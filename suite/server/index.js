// Praxis server — zero-dependency Node HTTP. Serves the SPA from web/ and a
// small REST + SSE API under /api. The BonesAI engine (ai/) powers drafting,
// docket extraction, intake triage, and the embedded assistant.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./db');
const { seed } = require('./seed');
const agents = require('./ai/agents');
const bones = require('./ai/bones');

const PORT = process.env.PORT || 4317;
const WEB_DIR = path.join(__dirname, '..', 'web');

// --- helpers ----------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  const full = path.join(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-API path → index.html
      if (!rel.includes('.')) return fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'text/html' }); res.end(b2);
      });
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// --- dashboard summary ------------------------------------------------------
function buildState() {
  const matters = db.all('matters');
  const events = db.all('events');
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const upcoming = events
    .filter((e) => e.status !== 'done' && e.dueDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  return {
    ai: { available: bones.available() },
    counts: {
      matters: matters.length,
      openMatters: matters.filter((m) => m.status === 'open').length,
      clients: db.all('clients').length,
      documents: db.all('documents').length,
      newIntake: db.all('intake').filter((i) => i.status === 'new').length,
      overdue: upcoming.filter((e) => e.dueDate < today).length,
      dueThisWeek: upcoming.filter((e) => e.dueDate >= today && e.dueDate <= in7).length,
    },
    upcoming: upcoming.slice(0, 8).map((e) => ({ ...e, matter: db.get('matters', e.matterId)?.title })),
    recentActivity: db.all('activity').slice(-12).reverse(),
  };
}

function matterDetail(id) {
  const matter = db.get('matters', id);
  if (!matter) return null;
  return {
    ...matter,
    client: matter.clientId ? db.get('clients', matter.clientId) : null,
    documents: db.where('documents', (d) => d.matterId === id),
    events: db.where('events', (e) => e.matterId === id).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))),
    notes: db.where('notes', (n) => n.matterId === id),
    timeEntries: db.where('timeEntries', (t) => t.matterId === id),
  };
}

// --- streaming chat (SSE over POST) -----------------------------------------
async function handleChat(req, res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const { matterId, messages = [], protect = true, model } = body;
  const system = agents.assistantSystem(matterId);

  try {
    if (!bones.available()) {
      const reply = offlineAssistantReply(matterId, messages);
      for (const tok of reply.match(/\S+\s*/g) || [reply]) { send('token', tok); await sleep(12); }
      send('done', { usedAI: false }); return res.end();
    }
    // Redact outbound user turns when protect is on; re-identify the reply.
    let replacements = [];
    let outMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    if (protect) {
      const ctx = agents.matterContext(matterId);
      const ents = bones.knownEntities(ctx.matter, ctx.client);
      const seen = new Map();
      outMessages = messages.map((m) => {
        if (m.role !== 'user') return m;
        const r = bones.redact(m.content, ents);
        for (const rep of r.replacements) if (!seen.has(rep.placeholder)) { seen.set(rep.placeholder, rep.original); }
        return { role: 'user', content: r.text };
      });
      replacements = Array.from(seen, ([placeholder, original]) => ({ placeholder, original }));
    }
    let raw = '';
    await bones.stream({ system, messages: outMessages, model }, {
      onToken: (t) => {
        raw += t;
        send('token', protect ? bones.reidentify(t, replacements) : t);
      },
    });
    send('done', { usedAI: true, redactionCount: replacements.length });
  } catch (e) {
    send('error', { message: e.message });
  }
  res.end();
}
function offlineAssistantReply(matterId, messages) {
  const ctx = agents.matterContext(matterId);
  const q = messages.filter((m) => m.role === 'user').slice(-1)[0]?.content || '';
  return (
    `[BonesAI offline — no ANTHROPIC_API_KEY set]\n\n`
    + (ctx.matter
      ? `For the matter "${ctx.matter.title}", I can draft documents, extract deadlines, and answer questions once a key is configured.\n\nContext I have:\n${ctx.brief}\n\n`
      : '')
    + `You asked: "${q.slice(0, 200)}". Set ANTHROPIC_API_KEY and restart to get a real, matter-aware answer.`
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- router -----------------------------------------------------------------
async function api(req, res, pathname, query) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const r = seg.slice(1); // after 'api'

  // GET /api/state
  if (r[0] === 'state' && method === 'GET') return sendJson(res, 200, buildState());
  if (r[0] === 'ai' && r[1] === 'status' && method === 'GET')
    return sendJson(res, 200, { available: bones.available(), templates: agents.DRAFT_TEMPLATES, models: bones.MODELS });

  // Clients
  if (r[0] === 'clients') {
    if (method === 'GET') return sendJson(res, 200, db.all('clients'));
    if (method === 'POST') { const b = await readBody(req); return sendJson(res, 201, db.insert('clients', b)); }
  }

  // Matters
  if (r[0] === 'matters') {
    if (!r[1] && method === 'GET') {
      const list = db.all('matters').map((m) => ({ ...m, client: db.get('clients', m.clientId)?.name }));
      return sendJson(res, 200, list);
    }
    if (!r[1] && method === 'POST') { const b = await readBody(req); const m = db.insert('matters', { status: 'open', parties: [], tags: [], ...b }); db.logActivity({ actor: 'user', action: 'created-matter', matterId: m.id, detail: m.title }); return sendJson(res, 201, m); }
    if (r[1] && method === 'GET') { const d = matterDetail(r[1]); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'not found' }); }
    if (r[1] && method === 'PATCH') { const b = await readBody(req); const m = db.update('matters', r[1], b); return m ? sendJson(res, 200, m) : sendJson(res, 404, { error: 'not found' }); }
  }

  // Documents
  if (r[0] === 'documents') {
    if (!r[1] && method === 'GET') return sendJson(res, 200, query.matterId ? db.where('documents', (d) => d.matterId === query.matterId) : db.all('documents'));
    if (!r[1] && method === 'POST') { const b = await readBody(req); const d = db.insert('documents', { source: 'uploaded', tags: [], ...b }); return sendJson(res, 201, d); }
    if (r[1] && method === 'GET') { const d = db.get('documents', r[1]); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'not found' }); }
  }

  // Events / deadlines
  if (r[0] === 'events') {
    if (!r[1] && method === 'GET') {
      let list = query.matterId ? db.where('events', (e) => e.matterId === query.matterId) : db.all('events');
      list = list.map((e) => ({ ...e, matter: db.get('matters', e.matterId)?.title }))
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      return sendJson(res, 200, list);
    }
    if (!r[1] && method === 'POST') { const b = await readBody(req); return sendJson(res, 201, db.insert('events', { status: 'pending', source: 'manual', priority: 'normal', ...b })); }
    if (r[1] && method === 'PATCH') { const b = await readBody(req); const e = db.update('events', r[1], b); return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: 'not found' }); }
    if (r[1] && method === 'DELETE') { return sendJson(res, 200, { ok: db.remove('events', r[1]) }); }
  }

  // Notes / time entries
  if (r[0] === 'notes' && method === 'POST') { const b = await readBody(req); return sendJson(res, 201, db.insert('notes', b)); }
  if (r[0] === 'timeEntries') {
    if (method === 'GET') return sendJson(res, 200, query.matterId ? db.where('timeEntries', (t) => t.matterId === query.matterId) : db.all('timeEntries'));
    if (method === 'POST') { const b = await readBody(req); return sendJson(res, 201, db.insert('timeEntries', b)); }
  }

  // Intake
  if (r[0] === 'intake') {
    if (!r[1] && method === 'GET') return sendJson(res, 200, db.all('intake'));
    if (!r[1] && method === 'POST') { const b = await readBody(req); return sendJson(res, 201, db.insert('intake', { status: 'new', receivedAt: new Date().toISOString().slice(0, 10), ...b })); }
    if (r[1] && r[2] === 'triage' && method === 'POST') {
      const b = await readBody(req);
      try { return sendJson(res, 200, await agents.triageIntake({ intakeId: r[1], protect: b.protect !== false })); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (r[1] && r[2] === 'convert' && method === 'POST') {
      const b = await readBody(req);
      try { return sendJson(res, 200, agents.convertIntakeToMatter({ intakeId: r[1], ...b })); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
  }

  // Activity log
  if (r[0] === 'activity' && method === 'GET') return sendJson(res, 200, db.all('activity').slice(-100).reverse());

  // --- AI agent endpoints ---
  if (r[0] === 'ai') {
    if (r[1] === 'draft' && method === 'POST') {
      const b = await readBody(req);
      try { return sendJson(res, 200, await agents.draftDocument(b)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (r[1] === 'extract-deadlines' && method === 'POST') {
      const b = await readBody(req);
      try {
        let text = b.text;
        if (!text && b.documentId) text = db.get('documents', b.documentId)?.content || '';
        return sendJson(res, 200, await agents.extractDeadlines({ ...b, text }));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (r[1] === 'redact-preview' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, 200, bones.redact(b.text || '', { people: b.people || [], companies: b.companies || [] }));
    }
    if (r[1] === 'chat' && method === 'POST') { const b = await readBody(req); return handleChat(req, res, b); }
  }

  return sendJson(res, 404, { error: `no route: ${method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname.startsWith('/api/')) {
    api(req, res, pathname, parsed.query).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    return;
  }
  serveStatic(req, res, pathname);
});

db.load();
seed();
server.listen(PORT, () => {
  console.log(`\n  Praxis — AI practice management suite`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  BonesAI engine: ${bones.available() ? 'ONLINE (Anthropic key detected)' : 'OFFLINE (set ANTHROPIC_API_KEY for live agents)'}\n`);
});
