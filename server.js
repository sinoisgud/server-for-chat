// Friend Chat server: accounts, friends, groups, messages. Node 18+, one dependency (pg).
// Run: npm install && node server.js   (env: PORT, DATABASE_URL, DB_FILE)
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const PORT = process.env.PORT || 3000;
const FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

// Storage: set DATABASE_URL (e.g. a free Supabase Postgres) and data survives restarts and redeploys.
// Without it, data goes to db.json, which free hosts like Render wipe on every restart.
const PG_URL = process.env.DATABASE_URL || '';
let pg = null, loaded = false;
let db = { users: {}, tokens: {}, groups: {}, msgs: {} };
const PROTO = 1, MIN_CLIENT = 1; // bump MIN_CLIENT only for a breaking change
const TOKEN_TTL = 30 * 864e5; // logins last 30 days of inactivity
const nul = o => Object.assign(Object.create(null), o); // no __proto__/constructor tricks
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function loadRaw() {
  const fromFile = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  if (!PG_URL) return fromFile();
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(PG_URL);
  pg = new Pool({ connectionString: PG_URL, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
  pg.on('error', e => console.error('Database connection error:', e.message));
  await pg.query('create table if not exists friendchat (k text primary key, v text not null)');
  const r = await pg.query("select v from friendchat where k = 'db'");
  return r.rows[0] ? JSON.parse(r.rows[0].v) : fromFile(); // first run: carry over a local db.json if one exists
}

function prepare(raw) {
  db = { users: {}, tokens: {}, groups: {}, msgs: {}, ...(raw || {}) };
  // tolerate data saved by older server versions
  for (const u of Object.values(db.users)) for (const f of ['friends', 'inc', 'out']) if (!Array.isArray(u[f])) u[f] = [];
  for (const u of Object.values(db.users)) if (!u.read || typeof u.read !== 'object') u.read = {};
  db.users = nul(db.users); db.groups = nul(db.groups); db.msgs = nul(db.msgs);
  for (const u of Object.values(db.users)) u.read = nul(u.read);
  // session tokens are stored hashed (so a leaked database can't be used to log in); upgrade old plaintext ones
  const oldTok = db.tokens; db.tokens = nul({});
  for (const [t, v] of Object.entries(oldTok || {})) {
    const rec = typeof v === 'string' ? { k: v, t: Date.now() } : v;
    db.tokens[t.length === 64 ? t : sha(t)] = rec;
  }
}

const tickets = new Map(); // one-use, 30-second tickets for the live connection
let dirty = false, saving = null;
const save = () => { dirty = true; };
function flush() {
  if (!dirty || !loaded || saving) return saving;
  dirty = false;
  const data = JSON.stringify(db);
  // .then() defers the work, so `saving` is always set before the finally below clears it
  saving = Promise.resolve().then(async () => {
    if (pg) await pg.query('insert into friendchat (k, v) values ($1, $2) on conflict (k) do update set v = excluded.v', ['db', data]);
    else { fs.writeFileSync(FILE + '.tmp', data); fs.renameSync(FILE + '.tmp', FILE); }
  }).catch(e => { dirty = true; console.error('Save failed, will retry:', e.message); })
    .finally(() => { saving = null; });
  return saving;
}
setInterval(flush, 1000).unref();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await saving; await flush(); process.exit(); });

const K = s => String(s).toLowerCase();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clients = new Map();
const push = (k, o) => { for (const r of clients.get(k) || []) r.write('data: ' + JSON.stringify(o) + '\n\n'); };
const ping = (...ks) => new Set(ks.flat()).forEach(k => push(k, { type: 'state' }));
const rm = (a, k) => { const i = a.indexOf(k); if (i >= 0) a.splice(i, 1); };
const dmId = (a, b) => 'd:' + [a, b].sort().join(':');

// ---- family friendly: swear words are starred out on the server, so every copy of the app shows clean text ----
// The owner can turn it off by setting FAMILY_FRIENDLY=off on Render. Users can't turn it off.
const FAMILY = process.env.FAMILY_FRIENDLY !== 'off';
const BAD_ANY = ['fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'bitch', 'whore', 'slut', 'pussy', 'asshole',
  'bastard', 'wank', 'bollock', 'dickhead', 'เหี้ย', 'ควย', 'เย็ด', 'แม่ง', 'สัส']; // caught even inside other words
const BAD_WORD = ['ass', 'dick', 'cock', 'fag', 'tit', 'tits', 'piss', 'damn', 'crap', 'retard', 'hoe', 'twat', 'prick']; // whole words only
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const badRe = new RegExp('(' + BAD_ANY.join('|') + ')|(?<![a-z])(' + BAD_WORD.join('|') + ')(?![a-z])', 'g');
function clean(s) {
  if (!FAMILY) return s;
  let norm = ''; // same length as s, so match positions line up with the original text
  for (const c of s.split('')) { const l = c.toLowerCase(); norm += LEET[l] || (l.length === 1 ? l : c); }
  const out = s.split('');
  for (const m of norm.matchAll(badRe)) for (let i = m.index; i < m.index + m[0].length; i++) out[i] = '*';
  return out.join('');
}
const pub = m => ({ id: m.id, from: m.from, text: m.text, time: m.time, ...(m.re ? { re: m.re } : {}), ...(m.ed ? { edited: m.ed } : {}) });

function members(convo) {
  if (convo.startsWith('g:')) { const g = db.groups[convo.slice(2)]; return g ? g.members : null; }
  const m = /^d:([^:]+):([^:]+)$/.exec(convo);
  if (!m) return null;
  const a = db.users[m[1]], b = db.users[m[2]];
  return a && b && a.friends.includes(m[2]) ? [m[1], m[2]] : null;
}

function state(k) {
  const u = db.users[k], nm = x => db.users[x].name;
  const count = c => (db.msgs[c] || []).filter(m => m.k !== k && m.time > (u.read[c] || 0)).length;
  const groups = Object.entries(db.groups).filter(([, g]) => g.members.includes(k))
    .map(([id, g]) => ({ id, name: g.name, members: g.members.map(nm) }));
  const unread = {};
  groups.forEach(g => { unread['g:' + g.id] = count('g:' + g.id); });
  u.friends.forEach(f => { unread[dmId(k, f)] = count(dmId(k, f)); });
  return { name: u.name, friends: u.friends.map(nm), incoming: u.inc.map(nm), outgoing: u.out.map(nm), groups, unread };
}

const buckets = new Map();
const count = (key, ms) => { const now = Date.now(); return (buckets.get(key) || []).filter(t => now - t < ms).length; };
const hit = key => { const a = buckets.get(key) || []; a.push(Date.now()); buckets.set(key, a.slice(-200)); };
const over = (key, max, ms) => { hit(key); return count(key, ms) > max; }; // true when more than max events in ms
setInterval(() => { const now = Date.now(); for (const [k, a] of buckets) if (!a.length || now - a[a.length - 1] > 3600000) buckets.delete(k); }, 60000).unref();

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const fail = (code, msg) => send(code, { error: msg });
  if (req.method === 'GET' && p === '/') return res.end('Friend Chat server OK');
  if (req.method === 'GET' && p === '/version') return send(200, { proto: PROTO, min: MIN_CLIENT });

  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 20000) return fail(413, 'Too large'); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, 'Bad JSON'); }
  }

  try {
    if (req.method === 'POST' && (p === '/signup' || p === '/login')) {
      const xf = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      const ip = xf.length ? xf[xf.length - 1] : req.socket.remoteAddress; // last hop is added by the host's proxy; the first can be forged
      if (over('ip:' + ip, 30, 60000)) return fail(429, 'Too many attempts, wait a minute');
      const name = String(body.username || '').trim(), pw = String(body.password || ''), k = K(name);
      if (p === '/signup') {
        if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return fail(400, 'Username: 3-20 letters, numbers or _');
        if (pw.length < 8 || pw.length > 100) return fail(400, 'Password must be at least 8 characters');
        if (clean(name) !== name) return fail(400, 'Please pick a family-friendly username');
        if (db.users[k]) return fail(409, 'Username already taken');
        if (over('signups', 100, 3600000)) return fail(429, 'Too many new accounts right now, try again later');
        if (Object.keys(db.users).length >= 2000) return fail(503, 'Server is full');
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[k] = { name, salt, hash: hashPw(pw, salt), friends: [], inc: [], out: [], read: nul({}) };
      } else {
        if (count('fail:' + k, 600000) >= 10) return fail(429, 'Too many wrong passwords for this account, try again in 10 minutes');
        const us = db.users[k];
        const good = hashPw(pw, us ? us.salt : '00'); // same work whether or not the user exists
        if (!us || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(us.hash))) { hit('fail:' + k); return fail(401, 'Wrong username or password'); }
      }
      const t = crypto.randomBytes(24).toString('hex');
      db.tokens[sha(t)] = { k, t: Date.now() };
      Object.entries(db.tokens).filter(([, v]) => v.k === k).sort((a, b) => b[1].t - a[1].t)
        .slice(10).forEach(([h]) => delete db.tokens[h]); // keep the 10 newest logins per account
      save();
      return send(200, { token: t, name: db.users[k].name });
    }

    // token in a URL is only accepted for /events, and only for older extensions that have no ticket support
    const isEv = req.method === 'GET' && p === '/events';
    const tok = String((req.headers.authorization || '').replace(/^Bearer /, '') || (isEv && u.searchParams.get('token')) || '');
    let th = sha(tok), rec = db.tokens[th];
    const ticket = u.searchParams.get('ticket');
    if (isEv && ticket) { // one-use ticket: keeps the real token out of URLs and logs
      const tk = tickets.get(ticket); tickets.delete(ticket);
      rec = tk && tk.exp > Date.now() && db.tokens[tk.h] ? { k: tk.k, t: Date.now() } : null; // dead if that login logged out
      th = tk && tk.h;
    } else if (rec && Date.now() - rec.t > TOKEN_TTL) { delete db.tokens[th]; save(); rec = null; }
    else if (rec) rec.t = Date.now();
    const me = rec && rec.k;
    if (!me || !db.users[me]) return fail(401, 'Not logged in');
    const U = db.users[me];
    if (req.method === 'POST' && over('post:' + me, 120, 60000)) return fail(429, 'Slow down');
    const ok = (...notify) => { save(); ping(me, ...notify); send(200, { ok: 1 }); };

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': ok\n\n');
      const set = clients.get(me) || new Set();
      if (set.size >= 5) { const old = set.values().next().value; set.delete(old); old.end(); } // cap live connections per user
      res.th = th; set.add(res); clients.set(me, set);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(hb); set.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/me') return send(200, state(me));
    if (req.method === 'POST' && p === '/logout') {
      delete db.tokens[th]; save();
      for (const r of [...(clients.get(me) || [])]) if (r.th === th) r.end(); // logged out = live updates stop too
      return send(200, { ok: 1 });
    }
    if (req.method === 'POST' && p === '/ticket') {
      if (over('ticket:' + me, 30, 60000)) return fail(429, 'Slow down');
      for (const [a, b] of tickets) if (b.exp < Date.now()) tickets.delete(a);
      const tk = crypto.randomBytes(16).toString('hex');
      tickets.set(tk, { k: me, h: th, exp: Date.now() + 30000 });
      return send(200, { ticket: tk });
    }

    // ---- account: change password / delete account (both need the current password) ----
    const checkPw = pw => {
      if (count('fail:' + me, 600000) >= 10) return 'locked';
      const good = crypto.timingSafeEqual(Buffer.from(hashPw(String(pw || '').slice(0, 200), U.salt)), Buffer.from(U.hash));
      if (!good) hit('fail:' + me);
      return good;
    };
    const pwFail = (c, msg) => c === 'locked' ? fail(429, 'Too many wrong passwords, wait 10 minutes') : fail(401, msg);
    const kick = keep => { // end every login of this account except `keep`
      for (const [h, v] of Object.entries(db.tokens)) if (v.k === me && h !== keep) delete db.tokens[h];
      for (const r of [...(clients.get(me) || [])]) if (r.th !== keep) r.end();
    };
    if (req.method === 'POST' && p === '/account/password') {
      const c = checkPw(body.old); if (c !== true) return pwFail(c, 'Current password is wrong');
      const np = String(body.new || '');
      if (np.length < 8 || np.length > 100) return fail(400, 'New password must be at least 8 characters');
      U.salt = crypto.randomBytes(16).toString('hex'); U.hash = hashPw(np, U.salt);
      kick(th); save(); return send(200, { ok: 1 });
    }
    if (req.method === 'POST' && p === '/account/delete') {
      const c = checkPw(body.password); if (c !== true) return pwFail(c, 'Password is wrong');
      const touched = new Set();
      for (const f of [...U.friends, ...U.inc, ...U.out]) {
        const F = db.users[f];
        if (F) { [F.friends, F.inc, F.out].forEach(a => rm(a, me)); touched.add(f); }
        delete db.msgs[dmId(me, f)];
      }
      for (const [id, g] of Object.entries(db.groups)) {
        if (!g.members.includes(me)) continue;
        g.members = g.members.filter(x => x !== me);
        if (db.msgs['g:' + id]) db.msgs['g:' + id] = db.msgs['g:' + id].filter(m => m.k !== me); // their group messages go too
        if (g.members.length) g.members.forEach(x => touched.add(x)); else { delete db.groups[id]; delete db.msgs['g:' + id]; }
      }
      kick(null); delete db.users[me]; save(); ping([...touched]);
      return send(200, { ok: 1 });
    }

    if (req.method === 'GET' && p === '/messages') {
      const convo = u.searchParams.get('convo') || '', mem = members(convo);
      if (!mem || !mem.includes(me)) return fail(403, 'No access');
      const n = Math.min(+u.searchParams.get('limit') || 200, 500);
      return send(200, { messages: (db.msgs[convo] || []).slice(-n).map(pub) });
    }
    if (req.method === 'POST' && p === '/send') {
      const convo = String(body.convo || ''), text = clean(String(body.text || '').trim().slice(0, 500)), mem = members(convo);
      if (!mem || !mem.includes(me)) return fail(403, 'No access');
      if (!text) return fail(400, 'Empty message');
      if (over('send:' + me, 20, 10000)) return fail(429, 'Slow down');
      const arr = db.msgs[convo] = db.msgs[convo] || [];
      const m = { id: crypto.randomBytes(6).toString('hex'), k: me, from: U.name, text, time: Date.now() };
      const ref = body.replyTo && arr.find(x => x.id === String(body.replyTo)); // replies only to a message in this chat
      if (ref) m.re = { id: ref.id, from: ref.from, text: ref.text.slice(0, 80) };
      arr.push(m); if (arr.length > 500) arr.splice(0, arr.length - 500);
      save();
      const out = pub(m);
      mem.forEach(k => push(k, { type: 'msg', convo, msg: out }));
      return send(200, { msg: out });
    }
    if (req.method === 'POST' && p === '/edit') {
      const convo = String(body.convo || ''), mem = members(convo);
      if (!mem || !mem.includes(me)) return fail(403, 'No access');
      const text = clean(String(body.text || '').trim().slice(0, 500));
      if (!text) return fail(400, 'Empty message');
      if (over('send:' + me, 20, 10000)) return fail(429, 'Slow down');
      const m = (db.msgs[convo] || []).find(x => x.id === String(body.id || ''));
      if (!m || m.k !== me) return fail(403, 'You can only edit your own messages');
      m.text = text; m.ed = Date.now(); save();
      const out = pub(m);
      mem.forEach(k => push(k, { type: 'edit', convo, msg: out }));
      return send(200, { msg: out });
    }
    if (req.method === 'POST' && p === '/read') {
      const convo = String(body.convo || ''), mem = members(convo);
      if (mem && mem.includes(me)) { U.read[convo] = Date.now(); save(); }
      return send(200, { ok: 1 });
    }

    if (req.method === 'POST' && p.startsWith('/friends/')) {
      const t = K(body.user || body.to || ''), T = db.users[t];
      if (!T) return send(200, { ok: 1 }); // same answer whether or not the name exists: no username probing
      if (t === me) return fail(400, "That's you");
      const befriend = () => {
        [U.inc, U.out].forEach(a => rm(a, t)); [T.inc, T.out].forEach(a => rm(a, me));
        if (!U.friends.includes(t)) U.friends.push(t);
        if (!T.friends.includes(me)) T.friends.push(me);
      };
      if (p === '/friends/request') {
        if (U.friends.includes(t)) return send(200, { ok: 1 });
        if (U.inc.includes(t)) befriend();
        else if (!U.out.includes(t)) {
          if (U.out.length >= 50 || T.inc.length >= 200) return fail(400, 'Too many pending requests');
          U.out.push(t); T.inc.push(me);
        }
        return ok(t);
      }
      if (p === '/friends/accept') { if (!U.inc.includes(t)) return fail(400, 'No such request'); befriend(); return ok(t); }
      if (p === '/friends/decline' || p === '/friends/remove') {
        if (U.friends.includes(t)) delete db.msgs[dmId(me, t)]; // unfriending erases the DM history for both
        [U.inc, U.out, U.friends].forEach(a => rm(a, t)); [T.inc, T.out, T.friends].forEach(a => rm(a, me));
        return ok(t);
      }
    }

    if (req.method === 'POST' && p === '/groups') {
      const name = clean(String(body.name || '').trim().slice(0, 30));
      if (!name) return fail(400, 'Group needs a name');
      if (over('mkgroup:' + me, 10, 3600000)) return fail(429, 'Too many new groups, try later');
      if (Object.values(db.groups).filter(g => g.members.includes(me)).length >= 30) return fail(400, 'Too many groups');
      const id = crypto.randomBytes(5).toString('hex');
      db.groups[id] = { name, members: [me] };
      save(); ping(me); return send(200, { id });
    }
    if (req.method === 'POST' && (p === '/groups/invite' || p === '/groups/leave')) {
      const g = db.groups[String(body.id || '')];
      if (!g || !g.members.includes(me)) return fail(403, 'No access');
      if (p === '/groups/invite') {
        const t = K(body.user || '');
        if (!db.users[t] || !U.friends.includes(t)) return fail(400, 'You can only invite friends');
        if (!g.members.includes(t)) { if (g.members.length >= 100) return fail(400, 'Group is full'); g.members.push(t); }
        return ok(g.members);
      }
      const rest = g.members.filter(x => x !== me);
      if (rest.length) g.members = rest; else { delete db.groups[body.id]; delete db.msgs['g:' + body.id]; }
      return ok(rest);
    }
    fail(404, 'Not found');
  } catch (e) { console.error(e); if (!res.headersSent) fail(500, 'Server error'); }
});

// Only start once the data is loaded. If loading fails, stop instead of starting empty:
// starting empty would overwrite everyone's saved accounts on the next save.
loadRaw().then(raw => {
  prepare(raw); loaded = true;
  server.listen(PORT, () => console.log('Friend Chat server on :' + PORT + (pg ? ' (saving to Postgres)' : ' (saving to ' + FILE + ')')));
}).catch(e => { console.error('Could not load saved data, not starting:', e.message); process.exit(1); });
