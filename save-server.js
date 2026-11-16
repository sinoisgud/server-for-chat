// Brawl Arena cloud-save server. No dependencies: node save-server.js
// Stores one save per account in saves.json next to this file.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8787;
const FILE = path.join(__dirname, 'saves.json');

let DB = {};
try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { DB = {}; }
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(DB), () => {}); } }, 1000);

const key = u => String(u || '').trim().toLowerCase().slice(0, 12);
const send = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.url === '/health') return send(res, 200, { ok: true, accounts: Object.keys(DB).length });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

  let body = '';
  req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    const u = key(m.u), h = String(m.h || '');
    if (!u || !h) return send(res, 400, { error: 'missing account' });
    const acc = DB[u];

    if (req.url === '/register') {
      if (acc) return send(res, 409, { error: 'That username is taken.' });
      DB[u] = { u: String(m.u).slice(0, 12), h, save: null, at: Date.now() };
      dirty = true;
      return send(res, 200, { ok: true, save: null });
    }
    if (req.url === '/login') {
      if (!acc) return send(res, 404, { error: 'No account with that name on this server.' });
      if (acc.h !== h) return send(res, 403, { error: 'Wrong password.' });
      return send(res, 200, { ok: true, save: acc.save, at: acc.at });
    }
    if (req.url === '/save') {
      if (!acc) return send(res, 404, { error: 'No account with that name.' });
      if (acc.h !== h) return send(res, 403, { error: 'Wrong password.' });
      acc.save = m.save || null; acc.at = Date.now(); dirty = true;
      return send(res, 200, { ok: true, at: acc.at });
    }
    send(res, 404, { error: 'not found' });
  });
});

server.listen(PORT, () => console.log('Brawl Arena save server on http://localhost:' + PORT));
