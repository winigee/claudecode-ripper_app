// Reference mock of TheWatcher's API — NOT the real TheWatcher.
//
// A tiny in-memory stand-in that implements the v1 contract (../../INTEGRATION.md)
// so the Praixis Time tab is demonstrable before the real timekeeper exists, and
// so the contract has an executable reference. Run it on its own port:
//
//   node server/integrations/thewatcher-mock.js        # → http://localhost:4400
//
// Then point Praixis at it (Time tab → connect, or THEWATCHER_URL=http://localhost:4400).

const http = require('http');
const url = require('url');

const PORT = process.env.WATCHER_PORT || 4400;
const timers = new Map();
const entries = [];
let seq = 0;
const id = (p) => `${p}_${++seq}`;

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(b);
}
function body(req) {
  return new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch (_) { r({}); } }); });
}

http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);
  const seg = pathname.split('/').filter(Boolean);

  if (pathname === '/health') return send(res, 200, { service: 'thewatcher', status: 'ok', version: '1.0.0-mock' });

  if (pathname === '/api/timers' && req.method === 'GET') {
    return send(res, 200, [...timers.values()].map(withElapsed));
  }
  if (pathname === '/api/timers' && req.method === 'POST') {
    const b = await body(req);
    const t = { id: id('tmr'), matterId: b.matterId || null, matterRef: b.matterRef || null, label: b.label || 'Untitled', attorney: b.attorney || '', description: b.description || '', rate: b.rate || 0, startedAt: new Date().toISOString(), running: true };
    timers.set(t.id, t);
    return send(res, 201, withElapsed(t));
  }
  if (seg[0] === 'api' && seg[1] === 'timers' && seg[3] === 'stop' && req.method === 'POST') {
    const t = timers.get(seg[2]);
    if (!t) return send(res, 404, { error: 'no such timer' });
    timers.delete(t.id);
    const endedAt = new Date().toISOString();
    const minutes = Math.max(1, Math.round((Date.now() - new Date(t.startedAt)) / 60000));
    const entry = { id: id('ent'), matterId: t.matterId, matterRef: t.matterRef, attorney: t.attorney, description: t.description || t.label, startedAt: t.startedAt, endedAt, minutes, rate: t.rate || 0, billable: true };
    entries.push(entry);
    return send(res, 200, { timer: { ...t, running: false, endedAt }, entry });
  }
  if (pathname === '/api/entries' && req.method === 'GET') {
    let list = entries;
    if (query.matterId) list = list.filter((e) => e.matterId === query.matterId);
    return send(res, 200, list);
  }
  if (pathname === '/api/entries' && req.method === 'POST') {
    const b = await body(req);
    const entry = { id: id('ent'), matterId: b.matterId || null, matterRef: b.matterRef || null, attorney: b.attorney || '', description: b.description || '', startedAt: null, endedAt: null, minutes: b.minutes || 0, rate: b.rate || 0, billable: b.billable !== false, date: b.date || new Date().toISOString().slice(0, 10) };
    entries.push(entry);
    return send(res, 201, entry);
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`TheWatcher (mock) on http://localhost:${PORT}`));

function withElapsed(t) {
  return { ...t, elapsedSeconds: Math.round((Date.now() - new Date(t.startedAt)) / 1000) };
}
