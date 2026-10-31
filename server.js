// Friend Chat server: accounts, friends, groups, messages. No dependencies (Node 18+).
// Run: node server.js   (env: PORT, DB_FILE)
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const PORT = process.env.PORT || 3000;
const FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

let db = { users: {}, tokens: {}, groups: {}, msgs: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
let dirty = false;
const save = () => { dirty = true; };
const flush = () => {
  if (!dirty) return; dirty = false;
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(FILE + '.tmp', FILE);
};
setInterval(flush, 1000).unref();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { flush(); process.exit(); });

const K = s => String(s).toLowerCase();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clients = new Map();
const push = (k, o) => { for (const r of clients.get(k) || []) r.write('data: ' + JSON.stringify(o) + '\n\n'); };
const ping = (...ks) => new Set(ks.flat()).forEach(k => push(k, { type: 'state' }));
const rm = (a, k) => { const i = a.indexOf(k); if (i >= 0) a.splice(i, 1); };
const dmId = (a, b) => 'd:' + [a, b].sort().join(':');

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

const hits = new Map();
const limited = ip => {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 30;
};

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const fail = (code, msg) => send(code, { error: msg });
  if (req.method === 'GET' && p === '/') return res.end('Friend Chat server OK');

  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 20000) return fail(413, 'Too large'); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, 'Bad JSON'); }
  }

  try {
    if (req.method === 'POST' && (p === '/signup' || p === '/login')) {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return fail(429, 'Too many attempts, wait a minute');
      const name = String(body.username || '').trim(), pw = String(body.password || ''), k = K(name);
      if (p === '/signup') {
        if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return fail(400, 'Username: 3-20 letters, numbers or _');
        if (pw.length < 6 || pw.length > 100) return fail(400, 'Password must be at least 6 characters');
        if (db.users[k]) return fail(409, 'Username already taken');
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[k] = { name, salt, hash: hashPw(pw, salt), friends: [], inc: [], out: [], read: {} };
      } else {
        const us = db.users[k];
        if (!us || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, us.salt)), Buffer.from(us.hash)))
          return fail(401, 'Wrong username or password');
      }
      const t = crypto.randomBytes(24).toString('hex');
      db.tokens[t] = k; save();
      return send(200, { token: t, name: db.users[k].name });
    }

    const tok = (req.headers.authorization || '').replace(/^Bearer /, '') || u.searchParams.get('token');
    const me = db.tokens[tok];
    if (!me || !db.users[me]) return fail(401, 'Not logged in');
    const U = db.users[me];
    const ok = (...notify) => { save(); ping(me, ...notify); send(200, { ok: 1 }); };

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': ok\n\n');
      const set = clients.get(me) || new Set(); set.add(res); clients.set(me, set);
      const hb = setInterval(() => res.write(': hb\n\n'), 25000);
      req.on('close', () => { clearInterval(hb); set.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/me') return send(200, state(me));
    if (req.method === 'POST' && p === '/logout') { delete db.tokens[tok]; save(); return send(200, { ok: 1 }); }

    if (req.method === 'GET' && p === '/messages') {
      const convo = u.searchParams.get('convo') || '', mem = members(convo);
      if (!mem || !mem.includes(me)) return fail(403, 'No access');
      const n = Math.min(+u.searchParams.get('limit') || 200, 500);
      return send(200, { messages: (db.msgs[convo] || []).slice(-n).map(({ id, from, text, time }) => ({ id, from, text, time })) });
    }
    if (req.method === 'POST' && p === '/send') {
      const convo = String(body.convo || ''), text = String(body.text || '').trim().slice(0, 500), mem = members(convo);
      if (!mem || !mem.includes(me)) return fail(403, 'No access');
      if (!text) return fail(400, 'Empty message');
      const m = { id: crypto.randomBytes(6).toString('hex'), k: me, from: U.name, text, time: Date.now() };
      const arr = db.msgs[convo] = db.msgs[convo] || [];
      arr.push(m); if (arr.length > 500) arr.splice(0, arr.length - 500);
      save();
      const out = { id: m.id, from: m.from, text: m.text, time: m.time };
      mem.forEach(k => push(k, { type: 'msg', convo, msg: out }));
      return send(200, { msg: out });
    }
    if (req.method === 'POST' && p === '/read') {
      const convo = String(body.convo || ''), mem = members(convo);
      if (mem && mem.includes(me)) { U.read[convo] = Date.now(); save(); }
      return send(200, { ok: 1 });
    }

    if (req.method === 'POST' && p.startsWith('/friends/')) {
      const t = K(body.user || body.to || ''), T = db.users[t];
      if (!T) return fail(404, 'No user with that username');
      if (t === me) return fail(400, "That's you");
      const befriend = () => {
        [U.inc, U.out].forEach(a => rm(a, t)); [T.inc, T.out].forEach(a => rm(a, me));
        if (!U.friends.includes(t)) U.friends.push(t);
        if (!T.friends.includes(me)) T.friends.push(me);
      };
      if (p === '/friends/request') {
        if (U.friends.includes(t)) return send(200, { ok: 1 });
        if (U.inc.includes(t)) befriend();
        else if (!U.out.includes(t)) { U.out.push(t); T.inc.push(me); }
        return ok(t);
      }
      if (p === '/friends/accept') { if (!U.inc.includes(t)) return fail(400, 'No such request'); befriend(); return ok(t); }
      if (p === '/friends/decline' || p === '/friends/remove') {
        [U.inc, U.out, U.friends].forEach(a => rm(a, t)); [T.inc, T.out, T.friends].forEach(a => rm(a, me));
        return ok(t);
      }
    }

    if (req.method === 'POST' && p === '/groups') {
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) return fail(400, 'Group needs a name');
      const id = crypto.randomBytes(5).toString('hex');
      db.groups[id] = { name, members: [me] };
      save(); ping(me); return send(200, { id });
    }
    if (req.method === 'POST' && (p === '/groups/invite' || p === '/groups/leave')) {
      const g = db.groups[String(body.id || '')];
      if (!g || !g.members.includes(me)) return fail(403, 'No access');
      if (p === '/groups/invite') {
        const t = K(body.user || '');
        if (!db.users[t]) return fail(404, 'No user with that username');
        if (!U.friends.includes(t)) return fail(400, 'You can only invite friends');
        if (!g.members.includes(t)) g.members.push(t);
        return ok(g.members);
      }
      const rest = g.members.filter(x => x !== me);
      if (rest.length) g.members = rest; else { delete db.groups[body.id]; delete db.msgs['g:' + body.id]; }
      return ok(rest);
    }
    fail(404, 'Not found');
  } catch (e) { console.error(e); if (!res.headersSent) fail(500, 'Server error'); }
}).listen(PORT, () => console.log('Friend Chat server on :' + PORT));
