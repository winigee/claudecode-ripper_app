const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  files: [],
  skipped: [],
  lastOutput: '',
  lastOutputKind: null,
  currentRunId: null,
  serverReady: false,
  modelInstalled: false,
  // Chat
  currentChatId: null,
  currentMessages: [],
  pendingAgentEl: null,
  pendingAgentText: '',
  // Token routing for non-chat streams
  tokenSink: null, // 'cannon' | null
  // Cannon
  redactedText: '',
  redactMap: {},         // { '[PERSON_1]': 'Jane Doe', ... } — local only, never persisted
  prompts: [],
  selectedPrompt: null,
  cannonResponseRaw: '',     // what Claude actually returned (with placeholders)
  cannonResponseFilled: '',  // same with placeholders swapped back for real names
  cannonShowFilled: true,    // current view in the output box
  lastCannonResponse: '',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function skullSvg(extraClass = '') {
  return `<svg class="${extraClass}" viewBox="0 0 100 100" width="28" height="28" aria-hidden="true"><use href="#skull-svg"/></svg>`;
}

// ----- Tabs -----
// Both the sidebar nav and the mobile bottom nav share the .tab class and
// data-tab attribute, so the same activate function drives them in sync.
function activateTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'brain') refreshBrain();
  if (name === 'settings') refreshSettings();
  // Close the chats drawer after navigating on mobile.
  document.querySelector('.sidebar')?.classList.remove('open');
}
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ----- Settings sub-nav -----
// Pills at the top of Settings scroll to each section so the user doesn't
// have to wheel through the whole page. Active state follows whatever
// section is closest to the top of the visible area.
function setupSettingsSubnav() {
  const nav = document.getElementById('settings-subnav');
  if (!nav) return;
  const panel = document.getElementById('tab-settings');
  if (!panel) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.snav');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.jump);
    if (!target) return;
    // Account for the sticky subnav height so the target isn't hidden under it.
    const subnavH = nav.getBoundingClientRect().height + 8;
    const top = target.offsetTop - panel.offsetTop - subnavH;
    panel.scrollTo({ top, behavior: 'smooth' });
  });

  // Track scroll to highlight the section nearest the top of the viewport.
  const ids = Array.from(nav.querySelectorAll('.snav')).map((b) => b.dataset.jump);
  panel.addEventListener('scroll', () => {
    let active = ids[0];
    const subnavH = nav.getBoundingClientRect().height + 8;
    const probe = panel.scrollTop + subnavH + 20;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.offsetTop - panel.offsetTop <= probe) active = id;
    }
    nav.querySelectorAll('.snav').forEach((b) => {
      b.classList.toggle('active', b.dataset.jump === active);
    });
  });
}
setupSettingsSubnav();

// ----- Mobile sidebar toggle -----
const sidebarToggleBtn = document.getElementById('sidebar-toggle');
if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.toggle('open');
  });
}

// ----- Status -----
function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  // Mirror to the mobile-only top bar.
  const mob = $('#mobile-status');
  if (mob) {
    // The desktop pill is multi-line ("local · ready\nqwen-7b") — keep just the
    // first line on the slim mobile bar.
    mob.textContent = (text || '').split('\n')[0];
    mob.className = 'mobile-status' + (kind ? ' ' + kind : '');
  }
}

function applyServerStatus(s) {
  if (!s) return;
  state.serverReady = !!s.ready;
  state.modelInstalled = !!s.modelInstalled;

  const filesReady = s.modelInstalled && s.llamafileInstalled;
  if (filesReady) {
    $('#setup').hidden = true;
  } else {
    $('#setup').hidden = false;
    setStatus(!s.llamafileInstalled ? 'runtime missing' : 'model missing', 'warn');
    return;
  }

  if (s.error) {
    setStatus('server error\ncheck Settings', 'err');
  } else if (state.serverReady) {
    setStatus('local · ready\nqwen2.5-7b', 'ok');
  } else if (s.running) {
    setStatus('starting model…', 'warn');
  } else {
    setStatus('offline\nSettings → Restart', 'err');
  }
}
window.bones.onServerStatus(applyServerStatus);

// ----- Setup modal / downloads -----
$('#btn-download-model').addEventListener('click', async () => {
  $('#btn-download-model').hidden = true;
  $('#btn-cancel-download').hidden = false;
  $('#setup-progress').hidden = false;
  $('#setup-error').hidden = true;
  setStatus('downloading…', 'warn');

  const res = await window.bones.modelDownload();
  if (res && res.ok) {
    $('#setup').hidden = true;
    setStatus('starting model…', 'warn');
  } else if (res && res.cancelled) {
    $('#btn-download-model').hidden = false;
    $('#btn-cancel-download').hidden = true;
    $('#setup-progress').hidden = true;
    setStatus('cancelled', 'warn');
  } else {
    $('#btn-download-model').hidden = false;
    $('#btn-cancel-download').hidden = true;
    $('#setup-error').hidden = false;
    $('#setup-error').textContent = 'Error: ' + (res && res.error ? res.error : 'unknown');
    setStatus('download failed', 'err');
  }
});
$('#btn-cancel-download').addEventListener('click', () => window.bones.modelCancel());
// Note: onModelProgress is wired below, in the Settings section. Single handler
// covers both the setup-screen progress bar and the per-card download bars.

// ===== CHAT =====

async function refreshChatList() {
  const list = await window.bones.chatList();
  const root = $('#chat-list');
  if (!list || list.length === 0) {
    root.innerHTML = '<div class="muted" style="padding:8px 10px;font-size:12px">No chats yet.</div>';
    return;
  }
  root.innerHTML = '';
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === state.currentChatId ? ' active' : '');
    row.innerHTML = `
      <span class="chat-row-title">${escapeHtml(c.title)}</span>
      <button class="chat-row-del" data-id="${c.id}" title="Delete">×</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('chat-row-del')) return;
      loadChat(c.id);
    });
    root.appendChild(row);
  }
  $$('.chat-row-del').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.bones.chatDelete(b.dataset.id);
      if (state.currentChatId === b.dataset.id) {
        startNewChat();
      } else {
        refreshChatList();
      }
    })
  );
}

function startNewChat() {
  state.currentChatId = null;
  state.currentMessages = [];
  renderMessages();
  refreshChatList();
  $('#chat-input').focus();
}

async function loadChat(id) {
  const chat = await window.bones.chatLoad(id);
  if (!chat) return;
  state.currentChatId = chat.id;
  state.currentMessages = chat.messages || [];
  renderMessages();
  refreshChatList();
  // Activate the Chat tab
  $$('.tab').forEach((b) => b.classList.remove('active'));
  $$('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="chat"]').classList.add('active');
  $('#tab-chat').classList.add('active');
}

function renderMessages() {
  const root = $('#chat-messages');
  if (state.currentMessages.length === 0) {
    root.innerHTML = `
      <div class="chat-empty muted">
        <svg class="skull-static" viewBox="0 0 100 100" width="120" height="120">
          <use href="#skull-svg" />
        </svg>
        <p>Ask anything. Conversations are saved locally.</p>
      </div>`;
    return;
  }
  root.innerHTML = '';
  for (const m of state.currentMessages) {
    root.appendChild(bubbleFor(m));
  }
  root.scrollTop = root.scrollHeight;
}

function bubbleFor(message) {
  const div = document.createElement('div');
  div.className = 'bubble ' + (message.role === 'user' ? 'user' : 'agent');
  if (message.role === 'user') {
    div.textContent = message.content;
  } else {
    div.innerHTML = `<div class="bubble-content">${escapeHtml(message.content || '')}</div>`;
  }
  return div;
}

function appendThinkingBubble() {
  const root = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'bubble agent thinking';
  div.innerHTML = `${skullSvg('skull-spin')}<div class="bubble-content">thinking…</div>`;
  root.appendChild(div);
  root.scrollTop = root.scrollHeight;
  return div;
}

$('#btn-new-chat').addEventListener('click', startNewChat);

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.currentRunId) return; // already running
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.serverReady) {
    setStatus('model not ready', 'err');
    return;
  }
  input.value = '';
  state.currentMessages.push({ role: 'user', content: text });
  renderMessages();

  state.pendingAgentEl = appendThinkingBubble();
  state.pendingAgentText = '';

  const runId = 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  $('#btn-chat-send').disabled = true;
  $('#btn-chat-cancel').hidden = false;

  try {
    const res = await window.bones.chatStream({ messages: state.currentMessages }, runId);
    if (res && res.error) {
      state.pendingAgentEl.classList.remove('thinking');
      state.pendingAgentEl.innerHTML = `<div class="bubble-content" style="color:var(--err)">Error: ${escapeHtml(res.error.message)}</div>`;
      state.currentMessages.push({ role: 'assistant', content: `[Error: ${res.error.message}]` });
    } else {
      state.currentMessages.push({ role: 'assistant', content: state.pendingAgentText || res.text || '' });
    }
    // Persist the chat
    const saved = await window.bones.chatSave({
      id: state.currentChatId,
      messages: state.currentMessages,
    });
    if (saved && saved.id) state.currentChatId = saved.id;
    refreshChatList();
  } catch (err) {
    state.pendingAgentEl.classList.remove('thinking');
    state.pendingAgentEl.innerHTML = `<div class="bubble-content" style="color:var(--err)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    state.currentRunId = null;
    state.pendingAgentEl = null;
    state.pendingAgentText = '';
    $('#btn-chat-send').disabled = false;
    $('#btn-chat-cancel').hidden = true;
  }
});

$('#btn-chat-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});

// ⌘↩ submit
$('#chat-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// Token stream for both chat and work runs
window.bones.onToken(({ runId, delta }) => {
  if (runId !== state.currentRunId) return;
  // Chat path
  if (state.pendingAgentEl) {
    if (state.pendingAgentEl.classList.contains('thinking')) {
      state.pendingAgentEl.classList.remove('thinking');
      state.pendingAgentEl.innerHTML = `${skullSvg('skull-spin')}<div class="bubble-content"></div>`;
    }
    state.pendingAgentText += delta;
    const c = state.pendingAgentEl.querySelector('.bubble-content');
    if (c) c.textContent = state.pendingAgentText;
    const root = $('#chat-messages');
    root.scrollTop = root.scrollHeight;
    return;
  }
  // Cannon path (Claude API response)
  if (state.tokenSink === 'cannon') {
    const co = $('#cannon-output');
    if (co) {
      co.textContent += delta;
      co.scrollTop = co.scrollHeight;
    }
    return;
  }
  // Work path
  const out = $('#output');
  if (out) {
    out.textContent += delta;
    out.scrollTop = out.scrollHeight;
  }
});

// ===== WORK (unchanged behavior) =====
const dropzone = $('#dropzone');

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', async (e) => {
  const dt = e.dataTransfer;
  if (!dt || !dt.files) return;
  const paths = [];
  for (const f of dt.files) if (f.path) paths.push(f.path);
  if (paths.length === 0) return;
  await ingestPaths(paths);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#btn-pick-files').addEventListener('click', async () => applyIngest(await window.bones.pickFiles()));
$('#btn-pick-folder').addEventListener('click', async () => applyIngest(await window.bones.pickFolder()));
$('#btn-clear-files').addEventListener('click', () => {
  state.files = [];
  state.skipped = [];
  renderFilesSummary();
});

async function ingestPaths(paths) {
  setStatus('reading files…', 'warn');
  const res = await window.bones.ingestPaths(paths);
  if (res && res.error) {
    setStatus('ingest error: ' + res.error.message, 'err');
    return;
  }
  applyIngest(res);
}

function applyIngest(res) {
  if (!res) return;
  state.files = (res.files || []).concat(state.files);
  state.skipped = (res.skipped || []).concat(state.skipped);
  renderFilesSummary();
  refreshStatus();
}

function renderFilesSummary() {
  const el = $('#files-summary');
  if (state.files.length === 0 && state.skipped.length === 0) { el.innerHTML = ''; return; }
  const totalChars = state.files.reduce((n, f) => n + (f.text ? f.text.length : 0), 0);
  let html = `<div><strong>${state.files.length} file(s)</strong> · ~${totalChars.toLocaleString()} chars</div>`;
  for (const f of state.files.slice(0, 20)) {
    html += `<div class="file">${escapeHtml(f.name || f.path)} <span class="muted">(${f.kind}, ${f.bytes} B)</span></div>`;
  }
  if (state.files.length > 20) html += `<div class="muted">…and ${state.files.length - 20} more</div>`;
  for (const s of state.skipped.slice(0, 10)) {
    html += `<div class="skip">skipped: ${escapeHtml(s.path)} — ${escapeHtml(s.reason || '')}</div>`;
  }
  el.innerHTML = html;
}

$('#btn-summarise').addEventListener('click', () => run('summarise'));
$('#btn-compact').addEventListener('click', () => run('compact'));
$('#btn-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});

async function run(kind) {
  if (!state.serverReady) { setStatus('model not ready', 'err'); return; }
  const instructions = $('#instructions').value;
  const pasted = $('#paste-area').value.trim();
  let payload;
  if (kind === 'summarise') {
    if (pasted) payload = { files: [{ name: 'pasted-content.txt', text: pasted }], instructions };
    else if (state.files.length > 0) payload = { files: state.files, instructions };
    else { setStatus('drop files or paste text first', 'err'); return; }
  } else {
    const content = pasted || state.files.map((f) => f.text).join('\n\n');
    if (!content) { setStatus('drop files or paste text first', 'err'); return; }
    payload = { content, instructions };
  }
  const runId = 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  state.tokenSink = null;
  const startedAt = Date.now();
  setStatus(`${kind} · thinking…`, 'warn');
  $('#output').textContent = '';
  $('#btn-summarise').disabled = true;
  $('#btn-compact').disabled = true;
  $('#btn-cancel').hidden = false;
  $('#btn-save-brain').disabled = true;
  try {
    const fn = kind === 'summarise' ? window.bones.summarise : window.bones.compact;
    const res = await fn(payload, runId);
    if (res && res.error) {
      $('#output').textContent += '\n\n[Error: ' + res.error.message + ']';
      setStatus('error', 'err');
    } else {
      state.lastOutput = $('#output').textContent;
      state.lastOutputKind = kind;
      $('#btn-save-brain').disabled = false;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const trunc = res.truncated ? ' · truncated' : '';
      setStatus(`${kind} · ${secs}s${trunc}`, 'ok');
    }
  } catch (err) {
    $('#output').textContent += '\n\n[Error: ' + err.message + ']';
    setStatus('error', 'err');
  } finally {
    state.currentRunId = null;
    $('#btn-summarise').disabled = false;
    $('#btn-compact').disabled = false;
    $('#btn-cancel').hidden = true;
  }
}

// ===== DOCUMENT SEARCH =====
const PROGRESS_LABELS = {
  expanding: 'Expanding query with related terms…',
  scanning: 'Scanning files…',
  judging: 'Judging the closest matches with the model…',
  done: '',
};

function renderSearchProgress(p) {
  const el = $('#search-progress');
  if (!el) return;
  let msg = PROGRESS_LABELS[p.stage] || '';
  if (p.stage === 'scanning' && p.total != null) msg = `Scanning ${p.total} file(s)…`;
  if (p.stage === 'judging' && p.count != null) msg = `Judging ${p.count} closest match(es) with the model…`;
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
}

if (window.bones.onDocSearchProgress) {
  window.bones.onDocSearchProgress((p) => {
    if (p.runId !== state.currentRunId) return;
    renderSearchProgress(p);
  });
}

function relevanceBadge(rel) {
  const map = {
    strong: '<span class="rel-badge strong">strong match</span>',
    possible: '<span class="rel-badge possible">possible</span>',
    weak: '<span class="rel-badge weak">weak</span>',
  };
  return map[rel] || '';
}

function renderSearchResults(res) {
  const root = $('#search-results');
  if (!res || res.error) {
    root.innerHTML = `<p class="muted">${escapeHtml(res && res.error ? res.error.message : 'Search failed.')}</p>`;
    return;
  }
  if (!res.results || res.results.length === 0) {
    root.innerHTML = `<p class="muted">${escapeHtml(res.note || 'No matches.')}</p>`;
    return;
  }
  let html = `<div class="search-meta muted">${res.results.length} match(es) of ${res.scanned || '?'} file(s) scanned`;
  if (res.expandedTerms && res.expandedTerms.length) {
    html += ` · also searched: ${escapeHtml(res.expandedTerms.slice(0, 8).join(', '))}`;
  }
  html += '</div>';
  for (const r of res.results) {
    html += `
      <div class="result-card ${escapeHtml(r.relevance || '')}">
        <div class="result-head">
          <span class="result-name">${escapeHtml(r.name)}</span>
          ${relevanceBadge(r.relevance)}
        </div>
        ${r.reason ? `<div class="result-reason">${escapeHtml(r.reason)}</div>` : ''}
        <div class="result-snippet">${escapeHtml(r.snippet || '')}</div>
        <div class="result-path muted">${escapeHtml(r.path || '')}</div>
      </div>`;
  }
  root.innerHTML = html;
}

async function runSearch() {
  if (!state.serverReady) { setStatus('model not ready', 'err'); return; }
  if (state.currentRunId) return;
  const query = $('#search-query').value.trim();
  if (!query) { setStatus('type something to search for', 'err'); return; }
  if (state.files.length === 0) {
    $('#search-results').innerHTML = '<p class="muted">Drop or pick some files first, then search them.</p>';
    return;
  }
  const expand = $('#search-expand').checked;
  const payload = {
    files: state.files.map((f) => ({ name: f.name, path: f.path, text: f.text })),
    query,
    expand,
  };

  const runId = 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  const startedAt = Date.now();
  $('#btn-search').disabled = true;
  $('#btn-search-cancel').hidden = false;
  $('#search-results').innerHTML = '';
  setStatus('searching…', 'warn');

  try {
    const res = await window.bones.docSearch(payload, runId);
    renderSearchResults(res);
    if (res && res.error) {
      setStatus('search error', 'err');
    } else {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const n = (res.results || []).length;
      setStatus(`search · ${n} match(es) · ${secs}s`, 'ok');
    }
  } catch (err) {
    $('#search-results').innerHTML = `<p class="muted">Error: ${escapeHtml(err.message)}</p>`;
    setStatus('search error', 'err');
  } finally {
    state.currentRunId = null;
    $('#btn-search').disabled = false;
    $('#btn-search-cancel').hidden = true;
    $('#search-progress').hidden = true;
  }
}

$('#btn-search').addEventListener('click', runSearch);
$('#btn-search-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});
$('#search-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});

// ===== REDACT & CANNON =====

const REDACT_LABELS = {
  model: 'Scanning for names with the local model…',
  redacting: 'Redacting…',
  done: '',
};

if (window.bones.onRedactProgress) {
  window.bones.onRedactProgress((p) => {
    if (p.runId !== state.currentRunId) return;
    const el = $('#redact-progress');
    if (!el) return;
    let msg = REDACT_LABELS[p.stage] || '';
    if (p.stage === 'model' && p.chunk) msg = `Scanning for names with the local model… (part ${p.chunk}/${p.of})`;
    if (!msg) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = msg;
  });
}

function materialForRedact() {
  const pasted = $('#paste-area').value.trim();
  if (pasted) return pasted;
  if (state.files.length > 0) return state.files.map((f) => `--- ${f.name || f.path} ---\n${f.text}`).join('\n\n');
  return '';
}

function renderRedactSummary(res) {
  const el = $('#redact-summary');
  const counts = res.counts || {};
  const labelMap = { PERSON: 'people', COMPANY: 'companies', ADDRESS: 'addresses', EMAIL: 'emails', PHONE: 'phone numbers', POSTCODE: 'postcodes' };
  const parts = Object.keys(counts).map((k) => `${counts[k]} ${labelMap[k] || k.toLowerCase()}`);
  if (parts.length === 0) {
    el.innerHTML = '<span class="muted">Nothing matched to redact. Review the text before sending anyway.</span>';
  } else {
    el.innerHTML = `<strong>${res.total}</strong> item(s) redacted: ${escapeHtml(parts.join(', '))}. <span class="muted">Real names are remembered locally and put back into Claude's reply.</span>`
      + (res.truncated ? ' <span class="muted">(name scan covered the first part of very long material)</span>' : '');
  }
}

$('#btn-redact').addEventListener('click', async () => {
  const material = materialForRedact();
  if (!material) {
    $('#redact-summary').innerHTML = '<span class="muted">Drop or paste some material first.</span>';
    return;
  }
  const useModel = $('#redact-model').checked;
  if (useModel && !state.serverReady) {
    $('#redact-summary').innerHTML = '<span class="muted">Local model not ready — redacting with patterns only.</span>';
  }
  const runId = 'rd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  $('#btn-redact').disabled = true;
  setStatus('redacting…', 'warn');
  try {
    const res = await window.bones.redact({ text: material, useModel: useModel && state.serverReady }, runId);
    if (res && res.error) {
      $('#redact-summary').innerHTML = `<span class="muted">Error: ${escapeHtml(res.error.message)}</span>`;
      setStatus('redact error', 'err');
      return;
    }
    state.redactedText = res.text || '';
    // Remember every placeholder→original mapping so we can put real names
    // back into Claude's response. Lives only in this app session — wiped on
    // reload/quit, never written to disk.
    state.redactMap = {};
    for (const r of (res.replacements || [])) {
      state.redactMap[r.placeholder] = r.original;
    }
    renderRedactSummary(res);
    const out = $('#redact-output');
    out.hidden = false;
    out.value = state.redactedText;
    $('#cannon-send').hidden = false;
    // Reset any previous response panel when re-redacting.
    state.cannonResponseRaw = '';
    state.cannonResponseFilled = '';
    $('#cannon-output').textContent = '';
    $('#btn-toggle-reidentify').hidden = true;
    $('#reident-note').hidden = true;
    await loadPromptLibrary();
    await refreshCannonKeyLabel();
    setStatus('redacted · review before sending', 'ok');
  } catch (err) {
    $('#redact-summary').innerHTML = `<span class="muted">Error: ${escapeHtml(err.message)}</span>`;
    setStatus('redact error', 'err');
  } finally {
    state.currentRunId = null;
    $('#btn-redact').disabled = false;
    $('#redact-progress').hidden = true;
  }
});

// Keep edits to the redacted text as the source of truth for sending.
$('#redact-output').addEventListener('input', (e) => { state.redactedText = e.target.value; });

// ----- Prompt library -----

async function loadPromptLibrary() {
  state.prompts = (await window.bones.promptList()) || [];
  const sel = $('#prompt-select');
  sel.innerHTML = '<option value="custom">Custom (write your own)</option>';
  const builtins = state.prompts.filter((p) => p.builtin);
  const users = state.prompts.filter((p) => !p.builtin);
  if (builtins.length) {
    const g = document.createElement('optgroup');
    g.label = 'Library';
    for (const p of builtins) g.appendChild(new Option(p.title, p.id));
    sel.appendChild(g);
  }
  if (users.length) {
    const g = document.createElement('optgroup');
    g.label = 'Your prompts';
    for (const p of users) g.appendChild(new Option(p.title, p.id));
    sel.appendChild(g);
  }
}

function renderPromptVars(prompt) {
  const wrap = $('#prompt-vars');
  wrap.innerHTML = '';
  if (!prompt || !prompt.variables || prompt.variables.length === 0) return;
  const intro = document.createElement('div');
  intro.className = 'prompt-vars-intro muted';
  intro.textContent = 'Fill in the prompt:';
  wrap.appendChild(intro);
  for (const v of prompt.variables) {
    const row = document.createElement('div');
    row.className = 'prompt-var-row';
    const label = document.createElement('label');
    label.textContent = v;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.var = v;
    input.placeholder = v;
    input.addEventListener('input', applyPromptVars);
    row.appendChild(label);
    row.appendChild(input);
    wrap.appendChild(row);
  }
}

function applyPromptVars() {
  if (!state.selectedPrompt) return;
  const values = {};
  $$('#prompt-vars input[data-var]').forEach((i) => { values[i.dataset.var] = i.value; });
  // Fill {{var}} client-side (mirror of main's fillVariables).
  const body = state.selectedPrompt.body.replace(/\{\{\s*([a-zA-Z0-9_ -]+?)\s*\}\}/g, (_f, raw) => {
    const name = raw.trim();
    const val = values[name];
    return val == null || val === '' ? `{{${name}}}` : val;
  });
  $('#prompt-body').value = body;
}

$('#prompt-select').addEventListener('change', (e) => {
  const id = e.target.value;
  const isUser = id.startsWith('user-');
  $('#btn-prompt-delete').hidden = !isUser;
  if (id === 'custom') {
    state.selectedPrompt = null;
    $('#prompt-vars').innerHTML = '';
    $('#prompt-body').value = '';
    $('#prompt-body').focus();
    return;
  }
  const prompt = state.prompts.find((p) => p.id === id);
  state.selectedPrompt = prompt || null;
  renderPromptVars(prompt);
  if (prompt) {
    $('#prompt-body').value = prompt.body;
    applyPromptVars();
  }
});

$('#btn-prompt-save').addEventListener('click', async () => {
  const body = $('#prompt-body').value.trim();
  if (!body) { setStatus('write a prompt first', 'err'); return; }
  const title = prompt('Name this prompt for your library:', (state.selectedPrompt && !state.selectedPrompt.builtin) ? state.selectedPrompt.title : '');
  if (title == null) return;
  const saved = await window.bones.promptSave({ title: title || 'Untitled prompt', body });
  await loadPromptLibrary();
  if (saved && saved.id) {
    $('#prompt-select').value = saved.id;
    $('#prompt-select').dispatchEvent(new Event('change'));
  }
  setStatus('prompt saved', 'ok');
});

$('#btn-prompt-delete').addEventListener('click', async () => {
  const id = $('#prompt-select').value;
  if (!id.startsWith('user-')) return;
  if (!confirm('Delete this prompt from your library?')) return;
  await window.bones.promptDelete(id);
  await loadPromptLibrary();
  $('#prompt-select').value = 'custom';
  $('#prompt-select').dispatchEvent(new Event('change'));
});

// ----- Fire the cannon -----

async function refreshCannonKeyLabel() {
  const st = await window.bones.claudeKeyStatus();
  const label = $('#cannon-model-label');
  if (st && st.hasKey) {
    label.textContent = `via ${st.model}`;
    $('#cannon-nokey').hidden = true;
    $('#btn-cannon').disabled = false;
  } else {
    label.textContent = '';
    $('#cannon-nokey').hidden = false;
    $('#btn-cannon').disabled = false; // still clickable; will show the hint
  }
}

// Swap [TYPE_N] placeholders back to the real names from state.redactMap.
// Only known placeholders are touched, so anything Claude invented stays
// intact. Returns the count of distinct entities re-identified.
function reidentify(text) {
  let count = 0;
  const seen = new Set();
  const out = text.replace(/\[([A-Z]+_\d+)\]/g, (full, _key) => {
    const real = state.redactMap[full];
    if (real == null) return full;
    if (!seen.has(full)) { seen.add(full); count++; }
    return real;
  });
  return { text: out, count };
}

function setCannonView() {
  const co = $('#cannon-output');
  const btn = $('#btn-toggle-reidentify');
  const note = $('#reident-note');
  if (state.cannonShowFilled) {
    co.textContent = state.cannonResponseFilled;
    btn.textContent = 'Show redacted version';
    const n = Object.keys(state.redactMap).length;
    note.textContent = n ? `Re-identified using the local map (${n} entities).` : '';
    note.hidden = !n;
  } else {
    co.textContent = state.cannonResponseRaw;
    btn.textContent = 'Show re-identified version';
    note.textContent = 'Showing exactly what Claude returned.';
    note.hidden = false;
  }
}

$('#btn-toggle-reidentify').addEventListener('click', () => {
  state.cannonShowFilled = !state.cannonShowFilled;
  setCannonView();
});

$('#btn-cannon').addEventListener('click', async () => {
  if (state.currentRunId) return;
  const promptText = $('#prompt-body').value.trim();
  if (!promptText) { setStatus('add a prompt to send', 'err'); return; }
  const unfilled = promptText.match(/\{\{[^}]+\}\}/g);
  if (unfilled && !confirm(`This prompt still has unfilled blanks (${unfilled.join(', ')}). Send anyway?`)) return;
  if (!state.redactedText) { setStatus('redact the material first', 'err'); return; }

  const keyStatus = await window.bones.claudeKeyStatus();
  if (!keyStatus || !keyStatus.hasKey) {
    $('#cannon-nokey').hidden = false;
    setStatus('no API key — see Settings', 'err');
    return;
  }

  const runId = 'ca-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  state.tokenSink = 'cannon';
  $('#cannon-output').textContent = '';
  $('#btn-cannon').disabled = true;
  $('#btn-cannon-cancel').hidden = false;
  $('#btn-cannon-save-brain').disabled = true;
  const startedAt = Date.now();
  setStatus('sending to Claude…', 'warn');
  try {
    const res = await window.bones.claudeSend({ prompt: promptText, material: state.redactedText }, runId);
    if (res && res.error) {
      $('#cannon-output').textContent += '\n\n[Error: ' + res.error.message + ']';
      setStatus('Claude error', 'err');
    } else {
      // The output box was filled by the streaming token sink; capture both
      // the raw (redacted) response and the re-identified version, then show
      // the re-identified one by default when we have a redaction map.
      state.cannonResponseRaw = $('#cannon-output').textContent;
      const filled = reidentify(state.cannonResponseRaw);
      state.cannonResponseFilled = filled.text;
      const hasMap = Object.keys(state.redactMap).length > 0;
      state.cannonShowFilled = hasMap;
      $('#btn-toggle-reidentify').hidden = !hasMap;
      setCannonView();
      state.lastCannonResponse = state.cannonShowFilled
        ? state.cannonResponseFilled
        : state.cannonResponseRaw;
      $('#btn-cannon-save-brain').disabled = false;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const reidentMsg = filled.count ? ` · re-identified ${filled.count}` : '';
      setStatus(`Claude · ${res.model || 'done'} · ${secs}s${reidentMsg}`, 'ok');
    }
  } catch (err) {
    $('#cannon-output').textContent += '\n\n[Error: ' + err.message + ']';
    setStatus('Claude error', 'err');
  } finally {
    state.currentRunId = null;
    state.tokenSink = null;
    $('#btn-cannon').disabled = false;
    $('#btn-cannon-cancel').hidden = true;
  }
});

$('#btn-cannon-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});

$('#btn-cannon-save-brain').addEventListener('click', async () => {
  // Save whichever view the user is currently looking at — they can flip
  // before saving if they want the de-identified one in Brain instead.
  const body = state.cannonShowFilled ? state.cannonResponseFilled : state.cannonResponseRaw;
  if (!body) return;
  const tag = state.cannonShowFilled ? '' : ' (redacted)';
  await window.bones.brainAdd({
    title: `Claude${tag}: ${$('#prompt-body').value.trim().slice(0, 50)}`,
    body,
    source: state.files.map((f) => f.name || f.path),
  });
  setStatus('saved to Brain', 'ok');
});

// ===== BRAIN =====
$('#btn-save-brain').addEventListener('click', async () => {
  if (!state.lastOutput) return;
  const firstFile = state.files[0];
  const note = {
    title: firstFile ? `${state.lastOutputKind}: ${firstFile.name}` : `${state.lastOutputKind} ${new Date().toLocaleString()}`,
    body: state.lastOutput,
    source: state.files.map((f) => f.name || f.path),
  };
  await window.bones.brainAdd(note);
  setStatus('saved to Brain', 'ok');
});

async function refreshBrain() {
  const notes = await window.bones.brainList();
  $('#brain-count').textContent = `${notes.length} note(s)`;
  const list = $('#brain-list');
  if (notes.length === 0) {
    list.innerHTML = '<p class="muted">No notes yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const n of notes.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'note';
    div.innerHTML = `
      <div class="note-head">
        <div class="note-title">${escapeHtml(n.title)}</div>
        <div class="note-meta">${new Date(n.created_at).toLocaleString()}</div>
      </div>
      <div class="note-body">${escapeHtml(n.body)}</div>
      <div class="note-actions"><button data-id="${n.id}" class="btn-delete">Delete</button></div>
    `;
    list.appendChild(div);
  }
  $$('.btn-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      await window.bones.brainDelete(b.dataset.id);
      refreshBrain();
    })
  );
}

// ===== SETTINGS =====
async function refreshSettings() {
  const s = await window.bones.serverStatus();
  const lines = [];
  lines.push(`Active model: <strong>${escapeHtml(s.activeModelId || '?')}</strong>`);
  lines.push(s.modelInstalled ? 'Model file present.' : 'Model file missing.');
  lines.push(s.binary ? `llamafile binary: ${escapeHtml(s.binary)}` : 'llamafile binary not found.');
  lines.push(s.ready ? `Server ready on 127.0.0.1:${s.port}.` : 'Server not running.');
  if (s.error) lines.push('Last error: ' + escapeHtml(s.error.message));
  $('#model-state').innerHTML = lines.join('<br>');
  refreshLog();
  refreshModelList();
  refreshSharing();
  refreshApiSettings();
  refreshPerformance();
  refreshMemory();
}

async function refreshMemory() {
  if (!window.bones.memoryConfig) return;
  let cfg;
  try { cfg = await window.bones.memoryConfig(); } catch (_) { cfg = { error: 'host only' }; }
  const sec = $('#setting-memory');
  if (cfg && cfg.error) {
    if (sec) sec.style.display = 'none';
    return;
  }
  if (sec) sec.style.display = '';
  const entries = await window.bones.memoryList();
  const list = $('#memory-list');
  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="muted" style="font-size:12px">Nothing taught yet.</div>';
  } else {
    list.innerHTML = '';
    for (const e of entries.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'memory-item';
      row.innerHTML = `<span class="memory-text"></span><button class="memory-del" data-id="${e.id}" title="Forget">×</button>`;
      row.querySelector('.memory-text').textContent = e.text;
      list.appendChild(row);
    }
    $$('.memory-del').forEach((b) =>
      b.addEventListener('click', async () => {
        await window.bones.memoryDelete(b.dataset.id);
        refreshMemory();
      })
    );
  }
  $('#memory-icloud').checked = !!cfg.icloud;
  $('#memory-icloud').disabled = !cfg.icloudAvailable && !cfg.icloud;
  const loc = $('#memory-location');
  if (cfg.icloud) {
    loc.innerHTML = `Synced via iCloud · ${entries.length} item(s). <span class="muted">${escapeHtml(cfg.path)}</span>`;
  } else if (cfg.icloudAvailable) {
    loc.innerHTML = `Stored locally on this Mac · ${entries.length} item(s). <span class="muted">Tick the box to sync across your Macs.</span>`;
  } else {
    loc.innerHTML = `Stored locally · ${entries.length} item(s). <span class="muted">iCloud Drive not detected on this Mac.</span>`;
  }
}

async function addMemory() {
  const input = $('#memory-input');
  const text = input.value.trim();
  if (!text) return;
  await window.bones.memoryAdd(text);
  input.value = '';
  setStatus('taught Bones', 'ok');
  refreshMemory();
}

if (document.getElementById('memory-input')) {
  $('#btn-memory-add').addEventListener('click', addMemory);
  $('#memory-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addMemory(); }
  });
  $('#memory-icloud').addEventListener('change', async (e) => {
    const res = await window.bones.memorySetICloud(e.target.checked);
    if (res && res.error) {
      alert(res.error);
      e.target.checked = !e.target.checked;
    }
    refreshMemory();
  });
}

async function refreshPerformance() {
  if (!window.bones.runtimeGet) return;
  let info;
  try { info = await window.bones.runtimeGet(); } catch (_) { info = { error: 'host only' }; }
  const sec = $('#setting-perf');
  if (info && info.error) {
    if (sec) sec.style.display = 'none';
    return;
  }
  if (sec) sec.style.display = '';
  const hw = info.hardware || {};
  const archLabel = hw.arch === 'arm64' ? 'Apple Silicon' : 'Intel x64';
  $('#perf-hw').textContent =
    `This Mac: ${hw.ramGB} GB RAM · ${hw.cpus} logical / ${info.threads} physical CPU thread(s) · ${archLabel}.`;
  $('#perf-context').value = String(info.context);
  $('#perf-runtime').innerHTML =
    `Currently running with <strong>${info.context.toLocaleString()}</strong>-token context using <strong>${info.threads}</strong> thread(s). `
    + `Default for this Mac is <strong>${info.contextDefault.toLocaleString()}</strong>. `
    + `Changing the window restarts the model.`;
}

if (document.getElementById('perf-context')) {
  $('#perf-context').addEventListener('change', async (e) => {
    const n = Number(e.target.value);
    setStatus('switching context…', 'warn');
    const res = await window.bones.runtimeSetContext(n);
    if (res && res.error) {
      setStatus('context switch failed: ' + res.error, 'err');
      return;
    }
    setStatus(`context → ${n.toLocaleString()}`, 'warn');
    setTimeout(refreshSettings, 400);
  });
}

async function refreshApiSettings() {
  if (!window.bones.claudeKeyStatus) return;
  const st = await window.bones.claudeKeyStatus();
  const status = $('#api-key-status');
  if (st && st.host === false) {
    // Browser-served renderer — hide the whole API section.
    const sec = $('#setting-api');
    if (sec) sec.style.display = 'none';
    return;
  }
  if (st && st.hasKey) {
    status.textContent = `Key saved (…${st.last4}). Sending via ${st.model}.`;
  } else {
    status.textContent = 'No key set. Get one at console.anthropic.com.';
  }
  if (st && st.model) $('#api-model').value = st.model;
}

if (document.getElementById('api-key')) {
  $('#btn-save-key').addEventListener('click', async () => {
    const key = $('#api-key').value.trim();
    if (!key) { setStatus('paste a key first', 'err'); return; }
    await window.bones.claudeSetKey(key);
    $('#api-key').value = '';
    setStatus('API key saved', 'ok');
    refreshApiSettings();
    refreshCannonKeyLabel();
  });
  $('#api-model').addEventListener('change', async (e) => {
    await window.bones.claudeSetModel(e.target.value);
    refreshApiSettings();
    refreshCannonKeyLabel();
  });
}

async function refreshSharing() {
  if (!window.bones.webInfo) return;
  // In the browser-served renderer, webInfo isn't available — hide the section.
  const sec = $('#setting-sharing');
  let info;
  try { info = await window.bones.webInfo(); } catch (_) { info = { error: 'host only' }; }
  if (info && info.error) {
    if (sec) sec.style.display = 'none';
    return;
  }
  if (sec) sec.style.display = '';
  $('#web-enabled').checked = !!info.enabled;
  $('#web-share').value = info.share || 'localhost';
  const urls = $('#web-urls');
  if (!info.running) {
    urls.innerHTML = '<span class="muted">Server stopped.</span>';
  } else if (!info.urls || info.urls.length === 0) {
    urls.innerHTML = '<span class="muted">Listening, no URLs to show.</span>';
  } else {
    urls.innerHTML = info.urls.map((u) => `<div class="url-row"><span class="label">${escapeHtml(u.label)}</span>${escapeHtml(u.url)}</div>`).join('');
  }
}

if (document.getElementById('web-enabled')) {
  $('#web-enabled').addEventListener('change', async (e) => {
    if (e.target.checked) await window.bones.webStart();
    else await window.bones.webStop();
    refreshSharing();
  });
  $('#web-share').addEventListener('change', async (e) => {
    await window.bones.webSetShare(e.target.value);
    refreshSharing();
  });
  $('#btn-regen-token').addEventListener('click', async () => {
    if (!confirm('Regenerate the access token? All existing URLs will stop working.')) return;
    await window.bones.webRegenToken();
    // Restart if running so the new token actually takes effect on the wire
    const info = await window.bones.webInfo();
    if (info.running) {
      await window.bones.webStop();
      await window.bones.webStart();
    }
    refreshSharing();
  });
  $('#btn-copy-url').addEventListener('click', async () => {
    const info = await window.bones.webInfo();
    const u = (info.urls || []).find((x) => x.label !== 'localhost') || (info.urls || [])[0];
    if (u && u.url) {
      try { await navigator.clipboard.writeText(u.url); setStatus('URL copied', 'ok'); }
      catch (_) { setStatus('clipboard failed', 'err'); }
    }
  });
}

async function refreshModelList() {
  const [hw, list] = await Promise.all([
    window.bones.modelHardware(),
    window.bones.modelList(),
  ]);
  $('#hw-summary').textContent =
    `This Mac: ${hw.ramGB} GB RAM · ${hw.cpus} CPU threads · ${hw.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}. Recommended: ${hw.recommended}.`;

  const root = $('#model-list');
  root.innerHTML = '';
  for (const m of list) {
    const isActive = m.id === hw.active;
    const isRecommended = m.id === hw.recommended;
    const card = document.createElement('div');
    card.className = 'model-card' + (isActive ? ' active' : '');
    card.dataset.modelId = m.id;

    const badges = [];
    if (isActive) badges.push('<span class="badge active">active</span>');
    if (isRecommended && !isActive) badges.push('<span class="badge recommended">recommended</span>');

    const actions = [];
    if (!m.installed) {
      actions.push(`<button class="primary btn-dl" data-id="${m.id}">Download (${m.sizeLabel})</button>`);
    } else {
      if (!isActive) actions.push(`<button class="btn-activate" data-id="${m.id}">Make active</button>`);
      actions.push(`<button class="btn-delete-model" data-id="${m.id}">Delete</button>`);
    }

    let installedNote = '';
    if (m.installed && m.installedPath) {
      const fname = m.installedPath.split('/').pop();
      // Show a small "detected" line for user-dropped files (different name
      // than canonical) so it's obvious BonesAI found the manually-added file.
      if (fname !== m.filename) {
        installedNote = `<div class="meta installed-note">Detected file: <code>${escapeHtml(fname)}</code></div>`;
      }
    }
    card.innerHTML = `
      <div class="info">
        <div class="title">${escapeHtml(m.name)} ${badges.join(' ')}</div>
        <div class="meta">${escapeHtml(m.short)} · ${m.sizeLabel} · needs ≥${m.minRamGB} GB RAM</div>
        <div class="notes">${escapeHtml(m.notes)}</div>
        ${installedNote}
        <div class="progress"><div class="fill"></div></div>
      </div>
      <div class="actions">${actions.join('')}</div>
    `;
    root.appendChild(card);
  }

  $$('.btn-dl').forEach((b) =>
    b.addEventListener('click', () => downloadModelAndUI(b.dataset.id))
  );
  $$('.btn-activate').forEach((b) =>
    b.addEventListener('click', async () => {
      setStatus('switching model…', 'warn');
      const r = await window.bones.modelSetActive(b.dataset.id);
      if (r && r.error) setStatus('switch failed: ' + r.error, 'err');
      refreshSettings();
    })
  );
  $$('.btn-delete-model').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Delete the ${b.dataset.id} model file from disk?`)) return;
      await window.bones.modelDelete(b.dataset.id);
      refreshSettings();
    })
  );
}

// Manual "I just dropped a file in the folder, find it" button.
if (document.getElementById('btn-rescan-models')) {
  $('#btn-rescan-models').addEventListener('click', async () => {
    setStatus('rescanning…', 'warn');
    await refreshModelList();
    setStatus('rescan complete', 'ok');
  });
  $('#btn-open-models-folder').addEventListener('click', async () => {
    if (window.bones.openModelsFolder) {
      await window.bones.openModelsFolder();
    }
  });
}

async function downloadModelAndUI(modelId) {
  const card = document.querySelector(`.model-card[data-model-id="${modelId}"]`);
  if (card) {
    const btn = card.querySelector('.btn-dl');
    if (btn) btn.disabled = true;
    const prog = card.querySelector('.progress');
    if (prog) prog.classList.add('active');
  }
  setStatus(`downloading ${modelId}…`, 'warn');
  const res = await window.bones.modelDownloadSpecific(modelId);
  if (res && res.ok) {
    setStatus(`${modelId} ready`, 'ok');
  } else if (res && res.cancelled) {
    setStatus('cancelled', 'warn');
  } else {
    setStatus('download failed', 'err');
    alert('Download failed: ' + (res && res.error ? res.error : 'unknown'));
  }
  refreshSettings();
}

// Wire per-card progress for model downloads
window.bones.onModelProgress((p) => {
  // Setup screen progress (kept working)
  const pct = Math.round((p.pct || 0) * 100);
  const fillTop = $('#progress-fill');
  if (fillTop) fillTop.style.width = pct + '%';
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  const stage = p.label === 'runtime' ? 'runtime' : 'model';
  const text = $('#progress-text');
  if (text) text.textContent = `${stage}: ${pct}% · ${mb(p.received)} / ${mb(p.total)} MB`;
  // Per-card progress in Settings (when downloading a specific model)
  if (p.modelId) {
    const card = document.querySelector(`.model-card[data-model-id="${p.modelId}"]`);
    if (card) {
      const fill = card.querySelector('.progress .fill');
      if (fill) fill.style.width = pct + '%';
    }
  }
});

async function refreshLog() {
  const tail = await window.bones.serverLogTail();
  $('#diag-log').textContent = (tail || []).join('\n') || '(no log yet)';
}
$('#btn-refresh-log').addEventListener('click', refreshLog);
$('#btn-export-log').addEventListener('click', async () => {
  if (!window.bones.serverExportLog) return;
  const res = await window.bones.serverExportLog();
  if (!res) return;
  if (res.cancelled) return;
  if (res.error) { setStatus('export failed: ' + res.error, 'err'); return; }
  setStatus('log exported', 'ok');
});

$('#btn-test').addEventListener('click', async () => {
  setStatus('pinging…', 'warn');
  const res = await window.bones.ping();
  if (res && res.error) setStatus('ping failed', 'err');
  else setStatus(`ping ok\n"${(res.text || '').trim()}"`, 'ok');
});
$('#btn-server-restart').addEventListener('click', async () => {
  setStatus('restarting…', 'warn');
  const st = await window.bones.serverStart();
  applyServerStatus(st);
});

// ===== INIT =====
async function refreshStatus() {
  const s = await window.bones.serverStatus();
  applyServerStatus(s);
}

async function populateSetupCard() {
  try {
    const hw = await window.bones.modelHardware();
    const list = await window.bones.modelList();
    const m = list.find((x) => x.id === hw.recommended) || list[0];
    if (m) {
      $('#setup-model-name').textContent = m.name;
      $('#setup-model-size').textContent = m.sizeLabel;
    }
  } catch (_) {}
}

refreshStatus();
refreshChatList();
populateSetupCard();
