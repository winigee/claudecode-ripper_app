// Praixis front-end — vanilla JS SPA. No build step.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return n;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const api = {
  async get(p) { const r = await fetch('/api' + p); if (!r.ok) throw new Error((await r.json()).error || r.statusText); return r.json(); },
  async post(p, b) { const r = await fetch('/api' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async patch(p, b) { const r = await fetch('/api' + p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return r.json(); },
  async del(p) { const r = await fetch('/api' + p, { method: 'DELETE' }); return r.json(); },
};

const state = { view: 'dashboard', matterId: null, aiAvailable: false, chat: [] };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// --- views ------------------------------------------------------------------
const views = {};

views.dashboard = async () => {
  const s = await api.get('/state');
  const c = s.counts;
  const stat = (n, l, cls = '') => el('div', { class: `stat ${cls}` }, el('div', { class: 'n' }, String(n)), el('div', { class: 'l' }, l));
  const grid = el('div', { class: 'stat-grid' },
    stat(c.openMatters, 'Open matters'),
    stat(c.clients, 'Clients'),
    stat(c.documents, 'Documents'),
    stat(c.newIntake, 'New intake', c.newIntake ? 'warn' : ''),
    stat(c.dueThisWeek, 'Due this week', c.dueThisWeek ? 'warn' : ''),
    stat(c.overdue, 'Overdue', c.overdue ? 'alert' : ''),
  );

  const deadlines = el('div', { class: 'card grow' },
    el('h3', {}, 'Upcoming deadlines'),
    s.upcoming.length ? table(
      ['Due', 'Item', 'Matter', 'Type'],
      s.upcoming.map((e) => [dueCell(e.dueDate), e.title, e.matter || '—', el('span', { class: `badge ${e.priority}` }, e.type)]),
    ) : el('div', { class: 'empty' }, 'Nothing scheduled.'),
  );
  const activity = el('div', { class: 'card grow' },
    el('h3', {}, 'Recent activity'),
    s.recentActivity.length ? el('div', {}, ...s.recentActivity.map((a) => el('div', { class: 'muted', style: 'padding:6px 0;border-bottom:1px solid var(--border);font-size:13px' },
      `${a.actor || 'system'} · ${a.action} — ${a.detail || ''}`))) : el('div', { class: 'empty' }, 'No activity yet.'),
  );

  return el('div', {}, grid, el('div', { class: 'row' }, deadlines, activity));
};

views.matters = async () => {
  if (state.matterId) return matterDetail(state.matterId);
  const list = await api.get('/matters');
  const head = el('div', { class: 'section-head' },
    el('h2', {}, 'Matters'),
    el('button', { class: 'btn primary', onclick: showNewMatter }, '+ New matter'));
  if (!list.length) return el('div', {}, head, el('div', { class: 'empty' }, 'No matters yet.'));
  const t = table(
    ['Reference', 'Title', 'Client', 'Practice area', 'Attorney', 'Status'],
    list.map((m) => ({
      cells: [m.reference || m.id, m.title, m.client || '—', m.practiceArea || '—', m.responsibleAttorney || '—', el('span', { class: `badge ${m.status}` }, m.status)],
      onclick: () => { state.matterId = m.id; render(); },
    })),
  );
  return el('div', {}, head, el('div', { class: 'card' }, t));
};

async function matterDetail(id) {
  const m = await api.get('/matters/' + id);
  setAssistantContext(m);
  const back = el('a', { class: 'pill-link', onclick: () => { state.matterId = null; setAssistantContext(null); render(); } }, '← All matters');

  const header = el('div', { class: 'card' },
    el('div', { class: 'section-head' },
      el('div', {}, el('h2', { style: 'margin:0' }, m.title),
        el('div', { class: 'muted' }, `${m.reference || m.id} · ${m.practiceArea || '—'} · ${m.responsibleAttorney || 'unassigned'}`)),
      el('span', { class: `badge ${m.status}` }, m.status)),
    m.description ? el('p', { class: 'muted' }, m.description) : null,
    m.client ? el('div', {}, el('strong', {}, 'Client: '), `${m.client.name} (${m.client.type})`, m.client.email ? el('span', { class: 'muted' }, ` · ${m.client.email}`) : null) : null,
    m.parties?.length ? el('div', { style: 'margin-top:6px' }, el('strong', {}, 'Other parties: '), m.parties.map((p) => `${p.name} [${p.role}]`).join('; ')) : null,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn primary', onclick: () => { openAssistant(); } }, '🦴 Ask BonesAI about this matter'),
      el('button', { class: 'btn', onclick: () => { state.view = 'drafting'; state.draftMatter = id; setNav(); render(); } }, '✍️ Draft document'),
      el('button', { class: 'btn', onclick: async () => {
        try { await api.post('/watcher/timers/start', { matterId: id, attorney: m.responsibleAttorney, description: m.title }); toast('Timer started in TheWatcher.'); state.view = 'time'; setNav(); render(); }
        catch (e) { toast(e.message.includes('unreachable') || e.message.includes('configured') ? 'Connect TheWatcher in the Time tab first.' : 'Error: ' + e.message); }
      } }, '⏱️ Start timer'),
    ),
  );

  const docs = el('div', { class: 'card grow' },
    el('h3', {}, `Documents (${m.documents.length})`),
    m.documents.length ? el('div', {}, ...m.documents.map((d) => el('div', { class: 'row', style: 'padding:8px 0;border-bottom:1px solid var(--border);align-items:center' },
      el('div', { class: 'grow' }, el('a', { onclick: () => showDoc(d) }, d.name), el('div', { class: 'muted', style: 'font-size:12px' }, `${d.type} · ${d.source}`)),
      el('button', { class: 'btn', onclick: () => extractFromDoc(d.id, m.id) }, '📅 Extract dates'),
    ))) : el('div', { class: 'empty' }, 'No documents.'),
  );
  const events = el('div', { class: 'card grow' },
    el('h3', {}, `Deadlines (${m.events.length})`),
    m.events.length ? table(['Due', 'Item', 'Type', ''], m.events.map((e) => [
      dueCell(e.dueDate),
      el('span', { style: e.status === 'done' ? 'text-decoration:line-through;color:var(--muted)' : '' }, e.title),
      el('span', { class: `badge ${e.priority}` }, e.type),
      el('button', { class: 'btn', onclick: async () => { await api.patch('/events/' + e.id, { status: e.status === 'done' ? 'pending' : 'done' }); render(); } }, e.status === 'done' ? '↺' : '✓'),
    ])) : el('div', { class: 'empty' }, 'No deadlines.'),
  );

  return el('div', {}, back, header, el('div', { class: 'row', style: 'margin-top:16px' }, docs, events));
}

views.drafting = async () => {
  const status = await api.get('/ai/status');
  const matters = await api.get('/matters');
  const tmplOpts = Object.entries(status.templates).map(([k, v]) => el('option', { value: k }, v));
  const matterOpts = [el('option', { value: '' }, '— select matter —'), ...matters.map((m) => el('option', { value: m.id, selected: state.draftMatter === m.id ? '' : null }, `${m.reference || m.id} · ${m.title}`))];

  const out = el('pre', { class: 'doc', id: 'draft-out' }, 'Draft output appears here.');
  const matterSel = el('select', {}, ...matterOpts);
  const tmplSel = el('select', {}, ...tmplOpts);
  const instr = el('textarea', { rows: '4', placeholder: 'Special instructions (tone, key points, recipient, amounts)…' });
  const protect = el('input', { type: 'checkbox', checked: '' });
  const genBtn = el('button', { class: 'btn primary' }, 'Generate draft');

  genBtn.addEventListener('click', async () => {
    if (!matterSel.value) return toast('Pick a matter first.');
    genBtn.disabled = true; out.innerHTML = ''; out.append(el('span', { class: 'spinner' }), ' BonesAI is drafting…');
    try {
      const res = await api.post('/ai/draft', { matterId: matterSel.value, template: tmplSel.value, instructions: instr.value, protect: protect.checked });
      out.textContent = res.document.content;
      toast(`Draft saved to matter${res.usedAI ? '' : ' (offline template)'}${res.redactionCount ? ` · ${res.redactionCount} entities protected` : ''}`);
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    genBtn.disabled = false;
  });

  const form = el('div', { class: 'card' },
    el('label', { class: 'field' }, el('span', {}, 'Matter'), matterSel),
    el('label', { class: 'field' }, el('span', {}, 'Document type'), tmplSel),
    el('label', { class: 'field' }, el('span', {}, 'Instructions'), instr),
    el('label', { class: 'protect-toggle', style: 'margin-bottom:8px' }, protect, ' 🛡 De-identify (redact) before sending to the model'),
    el('div', { class: 'btn-row' }, genBtn),
  );
  return el('div', {}, el('h2', {}, '✍️ AI Document Drafting'),
    el('p', { class: 'muted' }, 'The drafter agent uses matter context to produce a reviewable first draft. Generated drafts are saved to the matter file.'),
    el('div', { class: 'grid-2' }, form, el('div', { class: 'card' }, el('h3', {}, 'Output'), out)));
};

views.docket = async () => {
  const events = await api.get('/events');
  const matters = await api.get('/matters');
  const matterOpts = [el('option', { value: '' }, '— select matter —'), ...matters.map((m) => el('option', { value: m.id }, `${m.reference || m.id} · ${m.title}`))];
  const matterSel = el('select', {}, ...matterOpts);
  const text = el('textarea', { rows: '6', placeholder: 'Paste a court order, contract clause, or letter. The docket agent extracts dates & computes relative deadlines.' });
  const extractBtn = el('button', { class: 'btn primary' }, 'Extract deadlines');
  const extractOut = el('div', { id: 'extract-out' });

  extractBtn.addEventListener('click', async () => {
    if (!text.value.trim()) return toast('Paste some text first.');
    extractBtn.disabled = true; extractOut.innerHTML = ''; extractOut.append(el('span', { class: 'spinner' }), ' Extracting…');
    try {
      const res = await api.post('/ai/extract-deadlines', { matterId: matterSel.value || null, text: text.value, commit: !!matterSel.value });
      extractOut.innerHTML = '';
      extractOut.append(el('div', { class: 'muted', style: 'margin:8px 0' }, `${res.events.length} item(s)${res.committed ? ` · added to matter` : ' (no matter selected — preview only)'}${res.usedAI ? '' : ' (offline heuristics)'}`));
      extractOut.append(table(['Due', 'Item', 'Type', 'Rationale'], res.events.map((e) => [
        e.dueDate || '—', e.title, el('span', { class: `badge ${e.priority || 'normal'}` }, e.type), el('span', { class: 'muted', style: 'font-size:12px' }, e.rationale || ''),
      ])));
    } catch (e) { extractOut.textContent = 'Error: ' + e.message; }
    extractBtn.disabled = false;
  });

  const extractor = el('div', { class: 'card' },
    el('h3', {}, 'Docket extraction agent'),
    el('label', { class: 'field' }, el('span', {}, 'Add results to matter (optional)'), matterSel),
    el('label', { class: 'field' }, el('span', {}, 'Source text'), text),
    el('div', { class: 'btn-row' }, extractBtn), extractOut,
  );

  const today = new Date().toISOString().slice(0, 10);
  const calendar = el('div', { class: 'card' },
    el('h3', {}, 'All deadlines'),
    events.length ? table(['Due', 'Item', 'Matter', 'Type', 'Status'], events.map((e) => [
      dueCell(e.dueDate), el('span', { style: e.status === 'done' ? 'text-decoration:line-through;color:var(--muted)' : '' }, e.title),
      e.matter || '—', el('span', { class: `badge ${e.priority}` }, e.type),
      el('span', { class: 'badge ' + (e.status === 'done' ? 'closed' : e.dueDate < today ? 'overdue' : 'normal') }, e.status === 'done' ? 'done' : e.dueDate < today ? 'overdue' : 'pending'),
    ])) : el('div', { class: 'empty' }, 'No deadlines.'),
  );
  return el('div', {}, el('h2', {}, '📅 Docket & Deadlines'), el('div', { class: 'grid-2' }, extractor, calendar));
};

views.intake = async () => {
  const items = await api.get('/intake');
  const head = el('div', { class: 'section-head' }, el('h2', {}, '📨 Intake & Triage'),
    el('button', { class: 'btn', onclick: showNewIntake }, '+ Simulate inbound'));
  if (!items.length) return el('div', {}, head, el('div', { class: 'empty' }, 'No intake.'));
  const cards = items.map(renderIntakeCard);
  return el('div', {}, head, el('p', { class: 'muted' }, 'The intake agent classifies inbound messages, flags conflicts, suggests matter links, and drafts replies.'), ...cards);
};

function renderIntakeCard(item) {
  const body = el('div', { class: 'card' });
  body.append(
    el('div', { class: 'section-head' },
      el('div', {}, el('strong', {}, item.subject), el('div', { class: 'muted', style: 'font-size:13px' }, `From: ${item.fromName || item.from} <${item.from}> · ${item.receivedAt || ''}`)),
      el('span', { class: `badge ${item.status === 'new' ? 'warn pending' : item.status === 'converted' ? 'open' : 'normal'}` }, item.status)),
    el('p', { class: 'muted', style: 'white-space:pre-wrap' }, item.body),
  );
  const triageArea = el('div');
  body.append(triageArea);
  if (item.triage) renderTriage(triageArea, item);

  const actions = el('div', { class: 'btn-row' });
  if (item.status !== 'converted') {
    const tBtn = el('button', { class: 'btn primary' }, item.triage ? 'Re-triage' : '🦴 Triage with BonesAI');
    tBtn.addEventListener('click', async () => {
      tBtn.disabled = true; tBtn.innerHTML = ''; tBtn.append(el('span', { class: 'spinner' }), ' Triaging…');
      try { const res = await api.post(`/intake/${item.id}/triage`, {}); item.triage = res.triage; renderTriage(triageArea, item); toast(`Triaged: ${res.triage.category}${res.usedAI ? '' : ' (offline)'}`); }
      catch (e) { toast('Error: ' + e.message); }
      tBtn.disabled = false; tBtn.textContent = 'Re-triage';
    });
    actions.append(tBtn);
    if (item.triage && item.triage.category !== 'spam') {
      actions.append(el('button', { class: 'btn', onclick: () => convertIntake(item) }, '→ Open as matter'));
    }
  } else if (item.matterId) {
    actions.append(el('button', { class: 'btn', onclick: () => { state.view = 'matters'; state.matterId = item.matterId; setNav(); render(); } }, 'View matter →'));
  }
  body.append(actions);
  return body;
}

function renderTriage(container, item) {
  const t = item.triage; container.innerHTML = '';
  container.append(el('div', { class: 'card', style: 'background:var(--panel-2);margin-top:12px' },
    el('div', { class: 'row' },
      el('div', {}, el('span', { class: `badge normal` }, t.category), ' ', el('span', { class: `badge ${t.urgency}` }, t.urgency + ' urgency'),
        t.conflictFlag ? el('span', { class: 'badge high', style: 'margin-left:6px' }, '⚠ CONFLICT') : null),
    ),
    t.practiceArea ? el('div', { style: 'margin-top:6px' }, el('strong', {}, 'Practice area: '), t.practiceArea) : null,
    t.summary ? el('div', { style: 'margin-top:4px' }, el('strong', {}, 'Summary: '), t.summary) : null,
    t.conflictNote ? el('div', { class: 'muted', style: 'margin-top:4px' }, '⚠ ' + t.conflictNote) : null,
    t.draftReply ? el('details', { style: 'margin-top:8px' }, el('summary', { style: 'cursor:pointer' }, 'Draft reply'), el('pre', { class: 'doc', style: 'margin-top:8px' }, t.draftReply)) : null,
  ));
}

views.time = async () => {
  const [st, cfg, matters] = await Promise.all([api.get('/watcher/status'), api.get('/watcher/config'), api.get('/matters')]);

  // Connection card
  const urlInput = el('input', { value: cfg.url || '', placeholder: 'http://localhost:4400' });
  const connDot = el('span', { class: 'badge ' + (st.connected ? 'open' : st.configured ? 'high' : 'low') },
    st.connected ? `connected · ${st.service || 'thewatcher'} ${st.version || ''}` : st.configured ? `unreachable (${st.error || '—'})` : 'not configured');
  const connCard = el('div', { class: 'card' },
    el('div', { class: 'section-head' }, el('h3', { style: 'margin:0' }, 'TheWatcher connection'), connDot),
    el('p', { class: 'muted', style: 'font-size:13px' }, 'TheWatcher is an independent timekeeper. Praixis drives timers and pulls entries over its API. When it’s offline, Praixis falls back to local time entries.'),
    el('div', { class: 'row', style: 'align-items:flex-end' },
      el('label', { class: 'field grow', style: 'margin:0' }, el('span', {}, 'TheWatcher URL'), urlInput),
      el('button', { class: 'btn primary', onclick: async () => { await api.post('/watcher/config', { url: urlInput.value }); toast('Saved. Reconnecting…'); render(); } }, 'Save & connect')),
  );

  // Start-timer card (only useful when connected)
  const matterSel = el('select', {}, el('option', { value: '' }, '— no matter (free-form) —'), ...matters.map((m) => el('option', { value: m.id }, `${m.reference || m.id} · ${m.title}`)));
  const desc = el('input', { placeholder: 'What are you working on?' });
  const att = el('input', { placeholder: 'Attorney' });
  const rate = el('input', { type: 'number', placeholder: 'Rate/hr', style: 'max-width:120px' });
  const startBtn = el('button', { class: 'btn primary', disabled: st.connected ? null : '' }, '▶ Start timer');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try { await api.post('/watcher/timers/start', { matterId: matterSel.value, description: desc.value, attorney: att.value, rate: Number(rate.value) || 0 }); desc.value = ''; toast('Timer started.'); render(); }
    catch (e) { toast('Error: ' + e.message); startBtn.disabled = false; }
  });
  const startCard = el('div', { class: 'card' },
    el('h3', {}, 'Start a timer'),
    st.connected ? null : el('p', { class: 'muted' }, 'Connect TheWatcher above to start timers.'),
    el('label', { class: 'field' }, el('span', {}, 'Matter'), matterSel),
    el('label', { class: 'field' }, el('span', {}, 'Description'), desc),
    el('div', { class: 'row' }, el('label', { class: 'field grow' }, el('span', {}, 'Attorney'), att), el('label', { class: 'field' }, el('span', {}, 'Rate'), rate)),
    el('div', { class: 'btn-row' }, startBtn),
  );

  const running = el('div', { class: 'card', id: 'running-timers' });
  const entriesCard = el('div', { class: 'card', id: 'time-entries' });
  const refresh = async () => { await renderRunningTimers(running); await renderTimeEntries(entriesCard); };
  await refresh();
  // Live tick while on this view: update running timers + entries every 5s.
  if (st.connected) state._tick = setInterval(() => { tickElapsed(); }, 1000), state._poll = setInterval(refresh, 5000);

  return el('div', {}, el('h2', {}, '⏱️ Time & Billing'),
    el('div', { class: 'grid-2' }, connCard, startCard),
    running, entriesCard);
};

function fmtElapsed(s) { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; }
function tickElapsed() { document.querySelectorAll('[data-started]').forEach((n) => { const s = (Date.now() - new Date(n.dataset.started)) / 1000; n.textContent = fmtElapsed(s); }); }

async function renderRunningTimers(card) {
  const res = await api.get('/watcher/timers').catch(() => ({ connected: false, timers: [] }));
  card.innerHTML = '';
  card.append(el('h3', {}, `Running timers (${res.timers?.length || 0})`));
  if (!res.connected) { card.append(el('div', { class: 'empty' }, 'TheWatcher not connected.')); return; }
  if (!res.timers.length) { card.append(el('div', { class: 'empty' }, 'No timers running.')); return; }
  card.append(table(['Elapsed', 'Matter / label', 'Attorney', 'Description', ''], res.timers.map((t) => [
    el('span', { 'data-started': t.startedAt, style: 'font-family:monospace;color:var(--accent)' }, fmtElapsed(t.elapsedSeconds)),
    t.matterRef ? `${t.matterRef} · ${t.label}` : t.label, t.attorney || '—', t.description || '—',
    el('button', { class: 'btn danger', onclick: async () => { try { const out = await api.post(`/watcher/timers/${t.id}/stop`, {}); toast(`Logged ${out.entry?.minutes || 0} min.`); render(); } catch (e) { toast('Error: ' + e.message); } } }, '■ Stop'),
  ])));
}

async function renderTimeEntries(card) {
  const res = await api.get('/watcher/entries').catch(() => ({ source: 'local', entries: [] }));
  const matters = {}; (await api.get('/matters')).forEach((m) => (matters[m.id] = m.reference || m.title));
  card.innerHTML = '';
  let totalMin = 0, totalAmt = 0;
  for (const e of res.entries) { totalMin += e.minutes || 0; totalAmt += ((e.minutes || 0) / 60) * (e.rate || 0); }
  card.append(el('div', { class: 'section-head' }, el('h3', { style: 'margin:0' }, 'Time entries'),
    el('span', { class: 'muted', style: 'font-size:13px' }, `source: ${res.source}${res.watcherError ? ` (TheWatcher: ${res.watcherError})` : ''}`)));
  if (!res.entries.length) { card.append(el('div', { class: 'empty' }, 'No time entries yet.')); return; }
  card.append(table(['Date', 'Matter', 'Attorney', 'Description', 'Min', 'Rate', 'Amount'], res.entries.map((e) => [
    (e.endedAt || e.date || '').slice(0, 10) || '—', matters[e.matterId] || e.matterRef || '—', e.attorney || '—', e.description || '—',
    String(e.minutes || 0), e.rate ? '$' + e.rate : '—', e.rate ? '$' + (((e.minutes || 0) / 60) * e.rate).toFixed(2) : '—',
  ])));
  card.append(el('div', { style: 'text-align:right;margin-top:10px;font-weight:600' }, `Total: ${(totalMin / 60).toFixed(2)} h${totalAmt ? ` · $${totalAmt.toFixed(2)}` : ''}`));
}

views.activity = async () => {
  const log = await api.get('/activity');
  return el('div', {}, el('h2', {}, '🕘 Activity Log'),
    el('div', { class: 'card' }, log.length ? table(['Time', 'Actor', 'Action', 'Detail'], log.map((a) => [
      el('span', { class: 'muted', style: 'font-size:12px' }, (a.ts || '').replace('T', ' ').slice(0, 16)), a.actor || 'system', a.action, a.detail || '',
    ])) : el('div', { class: 'empty' }, 'No activity.')));
};

// --- shared UI helpers ------------------------------------------------------
function table(headers, rows) {
  const thead = el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h))));
  const tbody = el('tbody', {}, ...rows.map((r) => {
    const cells = Array.isArray(r) ? r : r.cells;
    const tr = el('tr', r.onclick ? { class: 'clickable', onclick: r.onclick } : {}, ...cells.map((c) => el('td', {}, c)));
    return tr;
  }));
  return el('table', {}, thead, tbody);
}
function dueCell(d) {
  if (!d) return el('span', { class: 'muted' }, '—');
  const today = new Date().toISOString().slice(0, 10);
  const overdue = d < today;
  return el('span', { class: overdue ? 'badge overdue' : '' }, d);
}

function showDoc(d) {
  modal(d.name, el('pre', { class: 'doc' }, d.content || '(no text)'));
}
async function extractFromDoc(docId, matterId) {
  toast('Extracting deadlines…');
  try { const res = await api.post('/ai/extract-deadlines', { documentId: docId, matterId, commit: true }); toast(`Added ${res.committed} deadline(s) to matter.`); render(); }
  catch (e) { toast('Error: ' + e.message); }
}
async function convertIntake(item) {
  const title = prompt('Matter title:', item.triage?.summary || item.subject);
  if (!title) return;
  try { const res = await api.post(`/intake/${item.id}/convert`, { title, practiceArea: item.triage?.practiceArea }); toast('Matter opened: ' + res.matter.reference); state.view = 'matters'; state.matterId = res.matter.id; setNav(); render(); }
  catch (e) { toast('Error: ' + e.message); }
}

// --- modals -----------------------------------------------------------------
function modal(title, content) {
  const overlay = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;display:flex;align-items:center;justify-content:center;padding:24px' });
  const box = el('div', { class: 'card', style: 'max-width:720px;width:100%;max-height:85vh;overflow:auto' },
    el('div', { class: 'section-head' }, el('h2', { style: 'margin:0' }, title), el('button', { class: 'icon-btn', onclick: () => overlay.remove() }, '✕')),
    content);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.append(box); document.body.append(overlay);
  return overlay;
}

async function showNewMatter() {
  const clients = await api.get('/clients');
  const title = el('input', { placeholder: 'Matter title' });
  const ref = el('input', { placeholder: 'Reference (optional)' });
  const area = el('input', { placeholder: 'Practice area' });
  const att = el('input', { placeholder: 'Responsible attorney' });
  const clientSel = el('select', {}, el('option', { value: '' }, '— existing client —'), ...clients.map((c) => el('option', { value: c.id }, c.name)));
  const newClient = el('input', { placeholder: 'or new client name' });
  const desc = el('textarea', { rows: '3', placeholder: 'Description' });
  const overlay = modal('New matter', el('div', {},
    el('label', { class: 'field' }, el('span', {}, 'Title'), title),
    el('div', { class: 'grid-2' }, el('label', { class: 'field' }, el('span', {}, 'Reference'), ref), el('label', { class: 'field' }, el('span', {}, 'Practice area'), area)),
    el('div', { class: 'grid-2' }, el('label', { class: 'field' }, el('span', {}, 'Client'), clientSel), el('label', { class: 'field' }, el('span', {}, 'New client'), newClient)),
    el('label', { class: 'field' }, el('span', {}, 'Attorney'), att),
    el('label', { class: 'field' }, el('span', {}, 'Description'), desc),
    el('div', { class: 'btn-row' }, el('button', {
      class: 'btn primary', onclick: async () => {
        if (!title.value.trim()) return toast('Title required.');
        let clientId = clientSel.value;
        if (!clientId && newClient.value.trim()) { const c = await api.post('/clients', { name: newClient.value.trim(), type: 'individual' }); clientId = c.id; }
        const m = await api.post('/matters', { title: title.value, reference: ref.value, practiceArea: area.value, responsibleAttorney: att.value, clientId, description: desc.value });
        overlay.remove(); toast('Matter created.'); state.matterId = m.id; render();
      },
    }, 'Create'))));
}

function showNewIntake() {
  const from = el('input', { placeholder: 'sender@example.com' });
  const subject = el('input', { placeholder: 'Subject' });
  const bodyT = el('textarea', { rows: '5', placeholder: 'Message body' });
  const overlay = modal('Simulate inbound message', el('div', {},
    el('label', { class: 'field' }, el('span', {}, 'From'), from),
    el('label', { class: 'field' }, el('span', {}, 'Subject'), subject),
    el('label', { class: 'field' }, el('span', {}, 'Body'), bodyT),
    el('div', { class: 'btn-row' }, el('button', {
      class: 'btn primary', onclick: async () => {
        if (!from.value || !subject.value) return toast('From and subject required.');
        await api.post('/intake', { from: from.value, subject: subject.value, body: bodyT.value });
        overlay.remove(); toast('Inbound added.'); render();
      },
    }, 'Add'))));
}

// --- assistant (BonesAI chat) ----------------------------------------------
const assistant = $('#assistant');
function openAssistant() { assistant.classList.remove('assistant-closed'); $('#chat-input').focus(); }
function closeAssistant() { assistant.classList.add('assistant-closed'); }
function setAssistantContext(matter) {
  state.assistantMatter = matter ? matter.id : null;
  $('#assistant-ctx').textContent = matter ? `Matter: ${matter.title}` : 'No matter in context';
}
function addChatMsg(role, text) {
  const log = $('#chat-log');
  const node = el('div', { class: 'msg ' + role }, text);
  log.append(node); log.scrollTop = log.scrollHeight;
  return node;
}
async function sendChat(e) {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addChatMsg('user', text);
  state.chat.push({ role: 'user', content: text });
  const protect = $('#protect-toggle').checked;
  const node = addChatMsg('assistant', '');
  node.append(el('span', { class: 'spinner' }));

  try {
    const resp = await fetch('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matterId: state.assistantMatter, messages: state.chat, protect }) });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', acc = '', first = true;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = /event: (.*)/.exec(chunk); const dl = /data: (.*)/s.exec(chunk);
        if (!dl) continue;
        const data = JSON.parse(dl[1]);
        const type = ev ? ev[1] : 'token';
        if (type === 'token') { if (first) { node.innerHTML = ''; first = false; } acc += data; node.textContent = acc; $('#chat-log').scrollTop = 1e9; }
        else if (type === 'error') { node.textContent = '⚠ ' + data.message; }
        else if (type === 'done') { state.chat.push({ role: 'assistant', content: acc }); if (data.redactionCount) node.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, `🛡 ${data.redactionCount} entities de-identified in transit`)); }
      }
    }
  } catch (err) { node.textContent = '⚠ ' + err.message; }
}

// --- shell ------------------------------------------------------------------
function setNav() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#crumb').textContent = { dashboard: 'Dashboard', matters: 'Matters', drafting: 'Drafting', docket: 'Docket & Deadlines', intake: 'Intake', time: 'Time & Billing', activity: 'Activity' }[state.view] || state.view;
}
async function render() {
  if (state._tick) { clearInterval(state._tick); state._tick = null; }
  if (state._poll) { clearInterval(state._poll); state._poll = null; }
  setNav();
  const host = $('#view');
  host.innerHTML = '';
  host.append(el('div', { class: 'muted' }, el('span', { class: 'spinner' }), ' Loading…'));
  try {
    const node = await views[state.view]();
    host.innerHTML = ''; host.append(node);
  } catch (e) { host.innerHTML = ''; host.append(el('div', { class: 'empty' }, 'Error: ' + e.message)); }
}

async function init() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; if (b.dataset.view !== 'matters') state.matterId = null; render(); }));
  $('#ask-bones').addEventListener('click', openAssistant);
  $('#assistant-close').addEventListener('click', closeAssistant);
  $('#chat-form').addEventListener('submit', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendChat(e); });

  try {
    const s = await api.get('/ai/status');
    state.aiAvailable = s.available;
    const pill = $('#engine-pill');
    pill.textContent = s.available ? 'BonesAI: online' : 'BonesAI: offline';
    pill.classList.add(s.available ? 'online' : 'offline');
    addChatMsg('system', s.available ? 'BonesAI engine online. Ask me about a matter.' : 'BonesAI offline — set ANTHROPIC_API_KEY for live answers. Demo replies are stubbed.');
  } catch (_) {}
  render();
}
init();
