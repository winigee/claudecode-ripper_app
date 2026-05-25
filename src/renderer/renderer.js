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
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function skullSvg(extraClass = '') {
  return `<svg class="${extraClass}" viewBox="0 0 100 100" width="28" height="28" aria-hidden="true"><use href="#skull-svg"/></svg>`;
}

// ----- Tabs -----
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'brain') refreshBrain();
    if (btn.dataset.tab === 'settings') refreshSettings();
    // Close sidebar on mobile after tab change
    document.querySelector('.sidebar')?.classList.remove('open');
  });
});

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

    card.innerHTML = `
      <div class="info">
        <div class="title">${escapeHtml(m.name)} ${badges.join(' ')}</div>
        <div class="meta">${escapeHtml(m.short)} · ${m.sizeLabel} · needs ≥${m.minRamGB} GB RAM</div>
        <div class="notes">${escapeHtml(m.notes)}</div>
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
