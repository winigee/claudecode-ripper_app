// Local HTTP server for browser/mobile access to BonesAI.
//
// Bound to 127.0.0.1 unless config.web.share === 'lan' (then 0.0.0.0).
// Auth: every API request and every static asset request must include a
// shared bearer token. The token is generated on first enable and shown in
// Settings; user can regenerate.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const url = require('url');
const { WebSocketServer } = require('ws');

const config = require('./config');
const llamaServer = require('./llama-server');
const llama = require('./llama');
const brain = require('./brain');
const chats = require('./chats');

let server = null;
let wss = null;
let listening = null; // { host, port }
const sseClients = new Set();

// Hook for the main process to receive incoming BackBones connections.
// Set by main.js once: backbones.attachIncoming(ws, pubKeyB64).
let onIncomingBackBones = null;
function setBackBonesHandler(fn) { onIncomingBackBones = fn; }

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function getWebConfig() {
  const cfg = config.readConfig();
  cfg.web = cfg.web || {};
  if (cfg.web.token == null) {
    cfg.web.token = generateToken();
    config.writeConfig(cfg);
  }
  if (cfg.web.enabled == null) cfg.web.enabled = false;
  if (cfg.web.share == null) cfg.web.share = 'localhost'; // 'localhost' | 'lan'
  if (cfg.web.port == null) cfg.web.port = 8765;
  return cfg.web;
}

function updateWebConfig(patch) {
  const cfg = config.readConfig();
  cfg.web = { ...getWebConfig(), ...patch };
  config.writeConfig(cfg);
  return cfg.web;
}

function regenerateToken() {
  return updateWebConfig({ token: generateToken() });
}

// --- helpers ---

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendText(res, status, text, type = 'text/plain') {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

// Auth is satisfied if the token appears in any of: Authorization header,
// X-Bones-Token header, query string, or the bones-session cookie. The cookie
// path is important — the browser only fetches stylesheets, scripts, the
// manifest and the icons with whatever auth context it has, and it has no way
// to know about the original ?t= URL. So the first hit also sets the cookie,
// turning a query-string login into a session for subsequent subresources.
function checkAuth(req, parsedUrl) {
  const cfg = getWebConfig();
  const headerTok =
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.headers['x-bones-token'];
  const queryTok = parsedUrl.query.t || parsedUrl.query.token;
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies['bones-session'];
  return (
    headerTok === cfg.token ||
    queryTok === cfg.token ||
    cookieTok === cfg.token
  );
}

function sessionCookieHeader(token) {
  // 7-day cookie so an installed PWA stays signed in between launches. Not
  // HttpOnly: the renderer's HTTP client reads the same token from sessionStorage
  // when the URL carried it; the cookie is the persistent backup. Same security
  // tradeoff as the query token — anyone with the URL can reach the API.
  const maxAge = 60 * 60 * 24 * 7;
  return `bones-session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

const STATIC_DIR = path.join(__dirname, '..', 'renderer');
const STATIC_MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// In-memory cache of static assets keyed by absolute path. Renderer files
// (index.html, renderer.js, styles.css, icons) don't change while the app is
// running, so we read each one from disk at most once per process.
const STATIC_CACHE = new Map();
function serveStatic(parsedUrl, res, extraHeaders = {}) {
  let pathname = parsedUrl.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // Restrict to renderer dir (no path traversal)
  const safe = path.normalize(pathname).replace(/^[/\\]+/, '');
  const full = path.join(STATIC_DIR, safe);
  if (!full.startsWith(STATIC_DIR)) return send(res, 403, { error: 'forbidden' });

  const cached = STATIC_CACHE.get(full);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': cached.ctype,
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    res.end(cached.buf);
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    const ctype = STATIC_MIME[ext] || 'application/octet-stream';
    STATIC_CACHE.set(full, { buf, ctype });
    res.writeHead(200, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    res.end(buf);
  });
}

// --- handlers ---

async function handleApi(req, res, parsedUrl) {
  const route = parsedUrl.pathname;
  const method = req.method;

  if (method === 'GET' && route === '/api/server/status') {
    return send(res, 200, llamaServer.status());
  }

  if (method === 'POST' && route === '/api/llama/ping') {
    try {
      const r = await llama.ping();
      return send(res, 200, r);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (method === 'GET' && route === '/api/chats') {
    return send(res, 200, chats.list());
  }
  if (method === 'GET' && route.startsWith('/api/chats/')) {
    const id = route.slice('/api/chats/'.length);
    return send(res, 200, chats.load(id) || null);
  }
  if (method === 'POST' && route === '/api/chats') {
    const body = await readBody(req);
    return send(res, 200, chats.save(body));
  }
  if (method === 'DELETE' && route.startsWith('/api/chats/')) {
    const id = route.slice('/api/chats/'.length);
    return send(res, 200, { ok: chats.remove(id) });
  }

  if (method === 'GET' && route === '/api/brain') {
    return send(res, 200, brain.listNotes());
  }
  if (method === 'POST' && route === '/api/brain') {
    const body = await readBody(req);
    return send(res, 200, brain.addNote(body || {}));
  }
  if (method === 'DELETE' && route.startsWith('/api/brain/')) {
    const id = route.slice('/api/brain/'.length);
    return send(res, 200, { ok: brain.deleteNote(id) });
  }

  // Streaming chat via SSE.
  // POST /api/llama/chat with { messages: [...] }
  // Response: text/event-stream of {delta} events, then {done, text} terminator.
  if (method === 'POST' && route === '/api/llama/chat') {
    const body = await readBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    const onToken = (t) => {
      try {
        res.write(`event: delta\ndata: ${JSON.stringify({ delta: t })}\n\n`);
      } catch (_) {}
    };
    try {
      const r = await llama.chat({ messages: body.messages || [] }, { onToken, signal: ctrl.signal });
      res.write(`event: done\ndata: ${JSON.stringify(r)}\n\n`);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    }
    return res.end();
  }

  return send(res, 404, { error: 'no such route' });
}

function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family !== 'IPv4' || n.internal) continue;
      // Tailscale interface name on macOS is utun* or similar; report all
      out.push({ name, address: n.address });
    }
  }
  return out;
}

async function handleRequest(req, res) {
  try {
    const parsedUrl = url.parse(req.url, true);

    // Health check (no auth) so something can ping the server presence
    if (parsedUrl.pathname === '/healthz') return sendText(res, 200, 'ok');

    // Everything else requires the token
    if (!checkAuth(req, parsedUrl)) {
      // For browser convenience, show a tiny login prompt if a human is poking
      // around without a token.
      const accept = req.headers.accept || '';
      if (parsedUrl.pathname === '/' && accept.includes('text/html')) {
        return sendText(res, 401, `<!doctype html><body style="font-family:system-ui;background:#0a1426;color:#d5e6ff;padding:40px;max-width:480px;margin:auto">
          <h2 style="color:#4cc7ff">BonesAI — access requires a token</h2>
          <p>This endpoint is access-controlled. Open BonesAI on the host Mac, go to <strong>Settings → Network sharing</strong>, copy the URL with the token included, and use that.</p>
          </body>`, 'text/html');
      }
      return send(res, 401, { error: 'unauthorized' });
    }

    if (parsedUrl.pathname.startsWith('/api/')) {
      return await handleApi(req, res, parsedUrl);
    }

    // Static assets: if the auth came from a fresh ?t=TOKEN URL, set a session
    // cookie so subsequent fetches (CSS, JS, manifest, icons) carry auth too.
    const cfg = getWebConfig();
    const cookies = parseCookies(req.headers.cookie);
    const setCookie = (parsedUrl.query.t === cfg.token || parsedUrl.query.token === cfg.token)
      && cookies['bones-session'] !== cfg.token
      ? { 'Set-Cookie': sessionCookieHeader(cfg.token) }
      : {};
    return serveStatic(parsedUrl, res, setCookie);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

function isRunning() { return !!server; }

function info() {
  const cfg = getWebConfig();
  const urls = [];
  if (listening) {
    if (cfg.share === 'lan') {
      for (const ip of localIPs()) {
        urls.push({ label: ip.name, url: `http://${ip.address}:${listening.port}/?t=${cfg.token}` });
      }
    }
    urls.unshift({ label: 'localhost', url: `http://127.0.0.1:${listening.port}/?t=${cfg.token}` });
  }
  return {
    enabled: cfg.enabled,
    share: cfg.share,
    port: cfg.port,
    token: cfg.token,
    running: isRunning(),
    listening,
    urls,
  };
}

async function start() {
  if (server) return info();
  const cfg = getWebConfig();
  const host = cfg.share === 'lan' ? '0.0.0.0' : '127.0.0.1';
  server = http.createServer(handleRequest);

  // Attach a WebSocket server for BackBones (encrypted peer-to-peer chat).
  // Path /ws/backbones. The initiator's BackBones session pubkey is sent as
  // ?init=<b64> on the connect URL; the joiner sends its own pubkey as the
  // first 'hello' frame after the handshake completes.
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/ws/backbones') {
      socket.destroy();
      return;
    }
    // Auth: same bones-session cookie or ?t= token as the rest of the API.
    if (!checkAuth(req, parsed)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const initiatorPub = parsed.query.init || null;
      if (!initiatorPub) {
        try { ws.close(1008, 'missing initiator key'); } catch (_) {}
        return;
      }
      if (onIncomingBackBones) onIncomingBackBones(ws, initiatorPub);
      else { try { ws.close(1011, 'no handler'); } catch (_) {} }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, host, () => {
      listening = { host, port: cfg.port };
      resolve();
    });
  });
  updateWebConfig({ enabled: true });
  return info();
}

async function stop() {
  if (!server) return info();
  await new Promise((resolve) => server.close(resolve));
  server = null;
  listening = null;
  updateWebConfig({ enabled: false });
  return info();
}

async function restart() {
  if (server) await stop();
  return start();
}

module.exports = { start, stop, restart, info, regenerateToken, updateWebConfig, getWebConfig, setBackBonesHandler };
