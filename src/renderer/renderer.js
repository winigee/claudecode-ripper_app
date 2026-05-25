const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  files: [],
  skipped: [],
  lastOutput: '',
  lastOutputKind: null,
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

async function refreshStatusFromSettings() {
  const s = await window.bones.getSettings();
  if (!s.hasApiKey) {
    setStatus('no API key — open Settings', 'err');
  } else {
    setStatus(`ready · ${s.model}`, 'ok');
  }
}

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
  for (const f of dt.files) {
    if (f.path) paths.push(f.path);
  }
  if (paths.length === 0) return;
  await ingestPaths(paths);
});

// Block default drop everywhere else so the window doesn't navigate
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#btn-pick-files').addEventListener('click', async () => {
  const res = await window.bones.pickFiles();
  applyIngest(res);
});
$('#btn-pick-folder').addEventListener('click', async () => {
  const res = await window.bones.pickFolder();
  applyIngest(res);
});
$('#btn-clear-files').addEventListener('click', () => {
  state.files = [];
  state.skipped = [];
  renderFilesSummary();
});

async function ingestPaths(paths) {
  setStatus('reading files…');
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
  refreshStatusFromSettings();
}

function renderFilesSummary() {
  const el = $('#files-summary');
  if (state.files.length === 0 && state.skipped.length === 0) {
    el.innerHTML = '';
    return;
  }
  const totalChars = state.files.reduce((n, f) => n + (f.text ? f.text.length : 0), 0);
  let html = `<div><strong>${state.files.length} file(s) loaded</strong> · ~${totalChars.toLocaleString()} chars</div>`;
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

// --- Summarise / Compact ---
$('#btn-summarise').addEventListener('click', () => run('summarise'));
$('#btn-compact').addEventListener('click', () => run('compact'));

async function run(kind) {
  const instructions = $('#instructions').value;
  const pasted = $('#paste-area').value.trim();
  let payload;
  if (kind === 'summarise') {
    if (pasted) {
      payload = { files: [{ name: 'pasted-content.txt', text: pasted }], instructions };
    } else if (state.files.length > 0) {
      payload = { files: state.files, instructions };
    } else {
      setStatus('drop files or paste text first', 'err');
      return;
    }
  } else {
    const content = pasted || state.files.map((f) => f.text).join('\n\n');
    if (!content) {
      setStatus('drop files or paste text first', 'err');
      return;
    }
    payload = { content, instructions };
  }

  setStatus('thinking…');
  $('#output').textContent = '';
  $('#btn-summarise').disabled = true;
  $('#btn-compact').disabled = true;

  try {
    const fn = kind === 'summarise' ? window.bones.summarise : window.bones.compact;
    const res = await fn(payload);
    if (res && res.error) {
      $('#output').textContent = 'Error: ' + res.error.message;
      setStatus('error', 'err');
    } else {
      $('#output').textContent = res.text;
      state.lastOutput = res.text;
      state.lastOutputKind = kind;
      $('#btn-save-brain').disabled = false;
      const usage = res.usage ? ` · ${res.usage.input_tokens}→${res.usage.output_tokens} tok` : '';
      setStatus(`${kind} done · ${res.model}${usage}`, 'ok');
    }
  } catch (err) {
    $('#output').textContent = 'Error: ' + err.message;
    setStatus('error', 'err');
  } finally {
    $('#btn-summarise').disabled = false;
    $('#btn-compact').disabled = false;
  }
}

// --- Brain ---
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
  const s = await window.bones.getSettings();
  $('#api-key').value = '';
  $('#api-key').placeholder = s.hasApiKey ? '••• saved •••' : 'sk-ant-…';
  $('#model').value = s.model;
  const hint = $('#api-key-hint');
  if (s.apiKeyFromEnv) {
    hint.textContent = 'Currently using ANTHROPIC_API_KEY from the environment.';
  } else if (s.hasApiKey) {
    hint.textContent = 'Key stored locally in BonesAI config (chmod 600). Not in the app bundle.';
  } else {
    hint.textContent = 'No key set. Paste your Anthropic API key and click Save.';
  }
}

$('#btn-save-key').addEventListener('click', async () => {
  const key = $('#api-key').value.trim();
  if (!key) return;
  await window.bones.setApiKey(key);
  $('#api-key').value = '';
  await refreshSettings();
  await refreshStatusFromSettings();
});

$('#btn-clear-key').addEventListener('click', async () => {
  await window.bones.setApiKey(null);
  await refreshSettings();
  await refreshStatusFromSettings();
});

$('#model').addEventListener('change', async () => {
  await window.bones.setModel($('#model').value);
  await refreshStatusFromSettings();
});

$('#btn-test').addEventListener('click', async () => {
  setStatus('pinging Claude…');
  const res = await window.bones.ping();
  if (res && res.error) {
    setStatus('ping failed: ' + res.error.message, 'err');
  } else {
    setStatus(`ping ok · ${res.model} · "${(res.text || '').trim()}"`, 'ok');
  }
});

// --- Init ---
refreshStatusFromSettings();
