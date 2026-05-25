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
};

// --- Tabs ---
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'brain') refreshBrain();
    if (btn.dataset.tab === 'settings') refreshSettings();
  });
});

// --- Status ---
function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function applyServerStatus(s) {
  state.serverReady = !!(s && s.ready);
  state.modelInstalled = !!(s && s.modelInstalled);

  if (!state.modelInstalled) {
    $('#setup').hidden = false;
    setStatus('model not installed', 'warn');
    return;
  }
  $('#setup').hidden = true;

  if (s.error) {
    setStatus('server error · check Settings → Diagnostics', 'err');
  } else if (state.serverReady) {
    setStatus('local · ready · qwen2.5-7b', 'ok');
  } else if (s.running) {
    setStatus('starting local model…', 'warn');
  } else {
    setStatus('local model offline', 'err');
  }
}

window.bones.onServerStatus(applyServerStatus);

// --- Setup screen / model download ---
$('#btn-download-model').addEventListener('click', async () => {
  $('#btn-download-model').hidden = true;
  $('#btn-cancel-download').hidden = false;
  $('#setup-progress').hidden = false;
  $('#setup-error').hidden = true;
  setStatus('downloading model…', 'warn');

  const res = await window.bones.modelDownload();
  if (res && res.ok) {
    $('#setup').hidden = true;
    setStatus('starting local model…', 'warn');
    const status = await window.bones.serverStart();
    applyServerStatus(status);
  } else if (res && res.cancelled) {
    $('#btn-download-model').hidden = false;
    $('#btn-cancel-download').hidden = true;
    $('#setup-progress').hidden = true;
    setStatus('download cancelled', 'warn');
  } else {
    $('#btn-download-model').hidden = false;
    $('#btn-cancel-download').hidden = true;
    $('#setup-error').hidden = false;
    $('#setup-error').textContent = 'Error: ' + (res && res.error ? res.error : 'unknown');
    setStatus('download failed', 'err');
  }
});

$('#btn-cancel-download').addEventListener('click', () => window.bones.modelCancel());

window.bones.onModelProgress((p) => {
  const pct = Math.round((p.pct || 0) * 100);
  $('#progress-fill').style.width = pct + '%';
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  $('#progress-text').textContent = `${pct}% · ${mb(p.received)} / ${mb(p.total)} MB`;
});

// --- Drop zone ---
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
  if (state.files.length === 0 && state.skipped.length === 0) {
    el.innerHTML = '';
    return;
  }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Run + streaming ---
$('#btn-summarise').addEventListener('click', () => run('summarise'));
$('#btn-compact').addEventListener('click', () => run('compact'));
$('#btn-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});

window.bones.onToken(({ runId, delta }) => {
  if (runId !== state.currentRunId) return;
  $('#output').textContent += delta;
  $('#output').scrollTop = $('#output').scrollHeight;
});

async function run(kind) {
  if (!state.serverReady) {
    setStatus('local model not ready', 'err');
    return;
  }
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
  setStatus(`${kind} · thinking locally…`, 'warn');
  $('#output').textContent = '';
  $('#output').classList.add('streaming');
  $('#btn-summarise').disabled = true;
  $('#btn-compact').disabled = true;
  $('#btn-cancel').hidden = false;
  $('#btn-save-brain').disabled = true;

  try {
    const fn = kind === 'summarise' ? window.bones.summarise : window.bones.compact;
    const res = await fn(payload, runId);
    if (res && res.error) {
      $('#output').textContent = ($('#output').textContent || '') + '\n\n[Error: ' + res.error.message + ']';
      setStatus('error', 'err');
    } else {
      state.lastOutput = $('#output').textContent;
      state.lastOutputKind = kind;
      $('#btn-save-brain').disabled = false;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      const trunc = res.truncated ? ' · input truncated' : '';
      setStatus(`${kind} done · ${secs}s${trunc}`, 'ok');
    }
  } catch (err) {
    $('#output').textContent += '\n\n[Error: ' + err.message + ']';
    setStatus('error', 'err');
  } finally {
    state.currentRunId = null;
    $('#output').classList.remove('streaming');
    $('#btn-summarise').disabled = false;
    $('#btn-compact').disabled = false;
    $('#btn-cancel').hidden = true;
  }
}

// --- Brain ---
$('#btn-save-brain').addEventListener('click', async () => {
  if (!state.lastOutput) return;
  const firstFile = state.files[0];
  const note = {
    title: firstFile
      ? `${state.lastOutputKind}: ${firstFile.name}`
      : `${state.lastOutputKind} ${new Date().toLocaleString()}`,
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
    list.innerHTML = '<p class="muted">No notes yet. Run a summarise or compact, then click "Save to Brain".</p>';
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

// --- Settings ---
async function refreshSettings() {
  const s = await window.bones.serverStatus();
  const state = [];
  state.push(s.modelInstalled ? 'Model file present.' : 'Model file missing — open the setup screen.');
  state.push(s.binary ? `llamafile binary: ${s.binary}` : 'llamafile binary not found in vendor/ or Resources/.');
  state.push(s.ready ? `Server ready on 127.0.0.1:${s.port}.` : 'Server not running.');
  if (s.error) state.push('Last error: ' + s.error.message);
  $('#model-state').innerHTML = state.map((l) => escapeHtml(l)).join('<br>');
  refreshLog();
}

async function refreshLog() {
  const lines = await window.bones.serverLogTail();
  $('#diag-log').textContent = (lines || []).join('\n') || '(no log yet)';
}

$('#btn-refresh-log').addEventListener('click', refreshLog);

$('#btn-test').addEventListener('click', async () => {
  setStatus('pinging local model…', 'warn');
  const res = await window.bones.ping();
  if (res && res.error) setStatus('ping failed: ' + res.error.message, 'err');
  else setStatus(`ping ok · "${(res.text || '').trim()}"`, 'ok');
});

$('#btn-server-restart').addEventListener('click', async () => {
  setStatus('restarting…', 'warn');
  const st = await window.bones.serverStart();
  applyServerStatus(st);
});

// --- Status refresher ---
async function refreshStatus() {
  const s = await window.bones.serverStatus();
  applyServerStatus(s);
}

refreshStatus();
