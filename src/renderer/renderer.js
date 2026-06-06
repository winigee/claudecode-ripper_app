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
  projects: [],
  pendingProjectId: null,
  draggingChatId: null,
  currentMessages: [],
  pendingAgentEl: null,
  pendingAgentText: '',
  // Token routing for non-chat streams
  tokenSink: null, // 'cannon' | null
  // Absorb — its own dedicated file list separate from Work's, plus the
  // staging shape for the review modal.
  absorbFiles: [],
  absorbSkipped: [],
  absorbDocs: [],   // [{ name, facts: [{ text, picked }] }]
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

// Render a progress bar with a label and a percentage into any container.
// pct=null means indeterminate (animated stripe). Mirrors the .prog CSS in
// ----- In-app input modal (Electron has no window.prompt) -----
// Returns a promise that resolves to the entered string, or null if cancelled.
function showInput({ title, label = '', value = '', placeholder = '', okText = 'OK' }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-card modal-small">
        <div class="modal-head"><h3></h3></div>
        ${label ? '<p class="hint input-modal-label"></p>' : ''}
        <div style="padding:6px 18px 0">
          <input type="text" class="input-modal-field" />
        </div>
        <div class="modal-actions">
          <button data-act="cancel">Cancel</button>
          <button data-act="ok" class="primary"></button>
        </div>
      </div>`;
    modal.querySelector('h3').textContent = title || 'Enter a value';
    if (label) modal.querySelector('.input-modal-label').textContent = label;
    const field = modal.querySelector('.input-modal-field');
    field.placeholder = placeholder;
    field.value = value;
    modal.querySelector('[data-act="ok"]').textContent = okText;
    document.body.appendChild(modal);
    field.focus();
    field.select();
    const done = (val) => { document.body.removeChild(modal); resolve(val); };
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (btn) { done(btn.dataset.act === 'ok' ? field.value.trim() : null); return; }
      if (e.target === modal) done(null); // click backdrop = cancel
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(field.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
  });
}

// ----- Right-click context menu -----
// items: array of { label, onClick, disabled, danger } or { separator: true }
// or { header: 'text' }. Submenus aren't needed — we keep it one level.
let _ctxMenuEl = null;
function closeContextMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
    } else if (it.header) {
      const h = document.createElement('div');
      h.className = 'ctx-header';
      h.textContent = it.header;
      menu.appendChild(h);
    } else {
      const item = document.createElement('div');
      item.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '');
      item.textContent = it.label;
      if (!it.disabled) {
        item.addEventListener('click', () => { closeContextMenu(); it.onClick && it.onClick(); });
      }
      menu.appendChild(item);
    }
  }
  document.body.appendChild(menu);
  // Position, keeping it on-screen.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
  _ctxMenuEl = menu;
}
// Dismiss on any outside click / escape / scroll.
document.addEventListener('click', (e) => { if (_ctxMenuEl && !_ctxMenuEl.contains(e.target)) closeContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
window.addEventListener('blur', closeContextMenu);

// styles.css — single source of truth for what a progress indicator looks like.
function renderProgress(container, { pct, label, sub }) {
  if (!container) return;
  const indeterminate = pct == null;
  const widthPct = indeterminate ? 35 : Math.max(0, Math.min(100, Math.round(pct)));
  const pctText = indeterminate ? '' : `<span class="prog-pct">${widthPct}%</span>`;
  container.innerHTML = `<div class="prog">
    <div class="prog-bar"><div class="prog-fill${indeterminate ? ' indeterminate' : ''}" style="width:${widthPct}%"></div></div>
    <div class="prog-text"><span>${escapeHtml(label || '')}${sub ? ` <span class="muted">${escapeHtml(sub)}</span>` : ''}</span>${pctText}</div>
  </div>`;
  container.hidden = false;
}
function clearProgress(container) {
  if (container) { container.innerHTML = ''; container.hidden = true; }
}

// Streaming token counter — used while the local model or Claude is producing
// output. Updates in place via setStreamingMeter(el, {tokens, startedAt}).
function setStreamingMeter(el, { tokens, startedAt, label }) {
  if (!el) return;
  const elapsed = (Date.now() - startedAt) / 1000;
  const rate = elapsed > 0.2 ? (tokens / elapsed).toFixed(1) : '0.0';
  el.innerHTML = `<span class="pulse" aria-hidden="true"></span>
    ${escapeHtml(label || 'streaming')} · ${tokens} tokens · ${elapsed.toFixed(1)}s · ${rate} tok/sec`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function skullSvg(extraClass = '') {
  return `<svg class="${extraClass}" viewBox="0 0 100 100" width="28" height="28" aria-hidden="true"><use href="#skull-svg"/></svg>`;
}
function claudeStarSvg(extraClass = '') {
  return `<svg class="claude-star ${extraClass}" viewBox="0 0 100 100" width="26" height="26" aria-hidden="true"><use href="#claude-star"/></svg>`;
}
// Returns the right "in flight" mark for a bubble — skull for local, sparkle
// for Claude — so the user can see at a glance which model is generating.
function thinkingMark(source) {
  return source === 'claude' ? claudeStarSvg('claude-star-spin') : skullSvg('skull-spin');
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
// Tab-style: clicking a pill swaps which Settings card is visible. Only one
// card on screen at a time, no scrolling through the stack.
function setupSettingsSubnav() {
  const nav = document.getElementById('settings-subnav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.snav');
    if (!btn) return;
    const targetId = btn.dataset.jump;
    // Highlight the clicked pill
    nav.querySelectorAll('.snav').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    // Show only the matching card
    document.querySelectorAll('#tab-settings .setting').forEach((s) => {
      s.classList.toggle('active', s.id === targetId);
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
    // Show the real active model so the user always knows what's actually
    // serving requests, not a hardcoded label.
    const id = s.activeModelId || '';
    setStatus(`local · ready\n${id}`, 'ok');
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

// Which project groups are collapsed (by id; '_unfiled' for the catch-all).
const collapsedProjects = new Set();
let chatSearchTerm = '';

async function refreshChatList() {
  const root = $('#chat-list');
  const [list, projects] = await Promise.all([
    chatSearchTerm ? window.bones.chatSearch(chatSearchTerm) : window.bones.chatList(),
    window.bones.projectsList ? window.bones.projectsList() : [],
  ]);
  state.projects = projects || [];

  if (!list || list.length === 0) {
    root.innerHTML = chatSearchTerm
      ? `<div class="muted" style="padding:8px 10px;font-size:12px">No chats match “${escapeHtml(chatSearchTerm)}”.</div>`
      : '<div class="muted" style="padding:8px 10px;font-size:12px">No chats yet.</div>';
    return;
  }

  // Group chats by project_id. When searching, flatten (no groups) so results
  // are easy to scan.
  root.innerHTML = '';
  if (chatSearchTerm) {
    for (const c of list) root.appendChild(chatRow(c, { showSnippet: true }));
    return;
  }

  const allProjects = projects || [];
  const validIds = new Set(allProjects.map((p) => p.id));
  const byProject = new Map();
  const unfiled = [];
  for (const c of list) {
    if (c.project_id && validIds.has(c.project_id)) {
      if (!byProject.has(c.project_id)) byProject.set(c.project_id, []);
      byProject.get(c.project_id).push(c);
    } else {
      unfiled.push(c);
    }
  }

  // Build the tree: top-level projects, each followed by its subprojects.
  const topProjects = allProjects.filter((p) => !p.parent_id);
  for (const top of topProjects) {
    root.appendChild(projectGroup(top, byProject.get(top.id) || []));
    const subs = allProjects.filter((p) => p.parent_id === top.id);
    if (!collapsedProjects.has(top.id)) {
      for (const sub of subs) {
        root.appendChild(projectGroup(sub, byProject.get(sub.id) || [], false, true));
      }
    }
  }
  if (unfiled.length) {
    root.appendChild(projectGroup({ id: '_unfiled', name: 'Unfiled' }, unfiled, true));
  }
}

const FOLDER_SVG = '<svg class="folder-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

function projectGroup(project, chatsIn, isUnfiled = false, isSub = false) {
  const wrap = document.createElement('div');
  wrap.className = 'project-group' + (isSub ? ' sub' : '');
  const collapsed = collapsedProjects.has(project.id);
  const head = document.createElement('div');
  head.className = 'project-head' + (collapsed ? ' collapsed' : '') + (isSub ? ' sub' : '');
  head.dataset.projectId = isUnfiled ? '' : project.id;
  head.innerHTML = `
    <span class="project-caret">▾</span>
    ${isUnfiled ? '' : FOLDER_SVG}
    <span class="project-name"></span>
    <span class="project-count">${chatsIn.length}</span>
    ${isUnfiled ? '' : '<button class="project-menu-btn" title="Project options">⋯</button>'}
  `;
  head.querySelector('.project-name').textContent = project.name;
  head.addEventListener('click', (e) => {
    if (e.target.classList.contains('project-menu-btn')) return;
    if (collapsedProjects.has(project.id)) collapsedProjects.delete(project.id);
    else collapsedProjects.add(project.id);
    refreshChatList();
  });
  if (!isUnfiled) {
    head.querySelector('.project-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.target.getBoundingClientRect();
      projectMenu(project, r.left, r.bottom, isSub);
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      projectMenu(project, e.clientX, e.clientY, isSub);
    });
  }
  // Drop target: dragging a chat onto this header files it into this project
  // (or unfiles it for the Unfiled header).
  const targetProjectId = isUnfiled ? null : project.id;
  head.addEventListener('dragover', (e) => {
    if (!state.draggingChatId) return;
    e.preventDefault();
    head.classList.add('drop-target');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
  head.addEventListener('drop', async (e) => {
    e.preventDefault();
    head.classList.remove('drop-target');
    const chatId = state.draggingChatId;
    if (!chatId) return;
    await window.bones.chatSetProject(chatId, targetProjectId);
    refreshChatList();
  });
  wrap.appendChild(head);
  if (!collapsed) {
    const body = document.createElement('div');
    body.className = 'project-body';
    if (chatsIn.length === 0) {
      body.innerHTML = '<div class="project-empty muted">empty — drop a chat here</div>';
    } else {
      for (const c of chatsIn) body.appendChild(chatRow(c));
    }
    wrap.appendChild(body);
  }
  return wrap;
}

function chatRow(c, { showSnippet = false } = {}) {
  const row = document.createElement('div');
  row.className = 'chat-row' + (c.id === state.currentChatId ? ' active' : '');
  row.draggable = true;
  row.innerHTML = `
    <div class="chat-row-main">
      <span class="chat-row-title"></span>
      ${showSnippet && c.snippet ? '<span class="chat-row-snippet"></span>' : ''}
    </div>
    <button class="chat-row-file" data-id="${c.id}" title="File in project">⊕</button>
    <button class="chat-row-del" data-id="${c.id}" title="Delete">×</button>
  `;
  row.querySelector('.chat-row-title').textContent = c.title;
  if (showSnippet && c.snippet) row.querySelector('.chat-row-snippet').textContent = c.snippet;
  // Drag to move between projects.
  row.addEventListener('dragstart', (e) => {
    state.draggingChatId = c.id;
    row.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  });
  row.addEventListener('dragend', () => {
    state.draggingChatId = null;
    row.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.chat-row-del') || e.target.closest('.chat-row-file')) return;
    loadChat(c.id);
  });
  row.querySelector('.chat-row-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await window.bones.chatDelete(c.id);
    if (state.currentChatId === c.id) startNewChat();
    else refreshChatList();
  });
  row.querySelector('.chat-row-file').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.target.getBoundingClientRect();
    fileChatMenu(c, r.left, r.bottom);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    _lastCtxAnchor = { x: e.clientX, y: e.clientY };
    chatRowMenu(c, e.clientX, e.clientY);
  });
  return row;
}

// Context menu for filing a chat into a project (the ⊕ button + right-click).
function fileChatMenu(chat, x, y) {
  const projects = state.projects || [];
  const items = [{ header: `File "${truncate(chat.title, 28)}"` }];
  const tops = projects.filter((p) => !p.parent_id);
  for (const top of tops) {
    items.push({
      label: top.name,
      checked: chat.project_id === top.id,
      onClick: async () => { await window.bones.chatSetProject(chat.id, top.id); refreshChatList(); },
    });
    for (const sub of projects.filter((p) => p.parent_id === top.id)) {
      items.push({
        label: '   ↳ ' + sub.name,
        checked: chat.project_id === sub.id,
        onClick: async () => { await window.bones.chatSetProject(chat.id, sub.id); refreshChatList(); },
      });
    }
  }
  if (tops.length) items.push({ separator: true });
  items.push({
    label: '＋ New project…',
    onClick: async () => {
      const name = await showInput({ title: 'New project', placeholder: 'Project name', okText: 'Create & file' });
      if (!name) return;
      const p = await window.bones.projectsAdd(name);
      if (p && p.id) await window.bones.chatSetProject(chat.id, p.id);
      refreshChatList();
    },
  });
  if (chat.project_id) {
    items.push({
      label: 'Remove from project',
      onClick: async () => { await window.bones.chatSetProject(chat.id, null); refreshChatList(); },
    });
  }
  showContextMenu(x, y, items);
}

// Context menu for a chat row (right-click).
function chatRowMenu(chat, x, y) {
  showContextMenu(x, y, [
    { label: 'Open', onClick: () => loadChat(chat.id) },
    { label: 'Rename…', onClick: () => renameChat(chat) },
    { label: 'File into project…', onClick: () => {
      const r = _lastCtxAnchor; fileChatMenu(chat, r.x, r.y);
    } },
    { separator: true },
    { label: 'Delete chat', danger: true, onClick: async () => {
      if (!confirm('Delete this chat?')) return;
      await window.bones.chatDelete(chat.id);
      if (state.currentChatId === chat.id) startNewChat(); else refreshChatList();
    } },
  ]);
}

async function renameChat(chat) {
  const title = await showInput({ title: 'Rename chat', value: chat.title, okText: 'Rename' });
  if (!title || title === chat.title) return;
  await window.bones.chatRename(chat.id, title);
  refreshChatList();
}

// Context menu for a project header (the ⋯ button + right-click).
function projectMenu(project, x, y, isSub = false) {
  const items = [
    { header: project.name },
    { label: 'New chat in project', onClick: () => {
      state.pendingProjectId = project.id;
      startNewChat();
      setStatus(`new chat → ${project.name}`, 'ok');
    } },
  ];
  // Only top-level projects can have subprojects (one level of nesting).
  if (!isSub) {
    items.push({ label: '＋ New subproject…', onClick: async () => {
      const name = await showInput({ title: 'New subproject', label: `Inside "${project.name}"`, placeholder: 'Subproject name', okText: 'Create' });
      if (!name) return;
      const r = await window.bones.projectsAdd(name, project.id);
      if (r && r.error) { alert(r.error); return; }
      collapsedProjects.delete(project.id);
      refreshChatList();
    } });
  }
  items.push({ label: 'Rename…', onClick: async () => {
    const name = await showInput({ title: 'Rename project', value: project.name, okText: 'Rename' });
    if (name && name !== project.name) { await window.bones.projectsRename(project.id, name); refreshChatList(); }
  } });
  items.push({ separator: true });
  items.push({ label: isSub ? 'Delete subproject' : 'Delete project', danger: true, onClick: async () => {
    const msg = isSub
      ? `Delete subproject "${project.name}"? Its chats move to Unfiled.`
      : `Delete project "${project.name}" and its subprojects? Their chats move to Unfiled.`;
    if (!confirm(msg)) return;
    await window.bones.projectsDelete(project.id);
    refreshChatList();
  } });
  showContextMenu(x, y, items);
}

// Context menu for the blank area of the chat list.
function chatListBlankMenu(x, y) {
  showContextMenu(x, y, [
    { label: '＋ New chat', onClick: startNewChat },
    { label: '＋ New project…', onClick: async () => {
      const name = await showInput({ title: 'New project', placeholder: 'Project name', okText: 'Create' });
      if (name) { await window.bones.projectsAdd(name); refreshChatList(); }
    } },
    { separator: true },
    { label: 'Collapse all projects', onClick: () => {
      for (const p of state.projects || []) collapsedProjects.add(p.id);
      collapsedProjects.add('_unfiled');
      refreshChatList();
    } },
    { label: 'Expand all projects', onClick: () => { collapsedProjects.clear(); refreshChatList(); } },
  ]);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
let _lastCtxAnchor = { x: 0, y: 0 };

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

// Live context-window meter at the top of Chat. Estimates token usage at
// ~4 chars/token and shows it against the configured context limit, so the
// user has a sense of how "full" Bones's working memory is before a reply
// gets shortened or starts forgetting earlier turns.
//
// State labels:
//   fresh  — under 50% used
//   warm   — 50–75%
//   tired  — 75–90% (warn colour, "Bones is getting tired")
//   spent  — over 90% (err colour, suggest New chat)
async function refreshContextMeter() {
  const meterEl = $('#chat-context-meter');
  if (!meterEl) return;
  // Hide unless we have a running server we can ask for the limit.
  let limit = 16384;
  try {
    const s = await window.bones.serverStatus();
    if (s && s.runtime && s.runtime.context) limit = s.runtime.context;
  } catch (_) {}
  // Sum the conversation. ~4 chars per token is a reasonable rule of thumb
  // for English chat; close enough for a "tired" gauge.
  let chars = 0;
  for (const m of state.currentMessages) chars += (m.content || '').length;
  const used = Math.round(chars / 4);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  $('#ctx-tokens').textContent = used.toLocaleString();
  $('#ctx-limit').textContent = limit.toLocaleString();
  let label = 'fresh';
  let cls = 'fresh';
  if (pct >= 90) { label = 'spent — start a new chat'; cls = 'spent'; }
  else if (pct >= 75) { label = 'tired'; cls = 'tired'; }
  else if (pct >= 50) { label = 'warm'; cls = 'warm'; }
  $('#ctx-state').textContent = label;
  meterEl.className = 'context-meter ' + cls;
  meterEl.hidden = false;
  const fill = meterEl.querySelector('.ctx-fill');
  if (fill) fill.style.width = pct + '%';
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
  refreshContextMeter();
}

function bubbleFor(message) {
  const div = document.createElement('div');
  const isClaude = message.role === 'assistant' && (message.model || '').toLowerCase().startsWith('claude');
  let cls = 'bubble ' + (message.role === 'user' ? 'user' : 'agent');
  if (isClaude) cls += ' via-claude';
  div.className = cls;
  if (message.role === 'user') {
    div.textContent = message.content;
  } else {
    const tag = message.model ? `<div class="via-claude-note">${escapeHtml(isClaude ? 'via ' + message.model : message.model)}</div>` : '';
    div.innerHTML = `<div class="bubble-content">${escapeHtml(message.content || '')}</div>${tag}`;
  }
  return div;
}

function appendThinkingBubble({ source = 'local' } = {}) {
  const root = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'bubble agent thinking ' + (source === 'claude' ? 'via-claude' : 'via-local');
  const subtitle = source === 'claude' ? '<div class="via-claude-note">asking Claude (redacted)…</div>' : '';
  const body = source === 'claude' ? 'redacting & asking Claude…' : 'thinking…';
  div.innerHTML = `${thinkingMark(source)}<div class="bubble-content">${body}</div>${subtitle}<div class="streaming-meter" hidden></div>`;
  root.appendChild(div);
  root.scrollTop = root.scrollHeight;
  return div;
}

$('#btn-new-chat').addEventListener('click', startNewChat);

// Chat search box — debounced.
let chatSearchTimer = null;
if (document.getElementById('chat-search')) {
  $('#chat-search').addEventListener('input', (e) => {
    chatSearchTerm = e.target.value.trim();
    $('#chat-search-clear').hidden = !chatSearchTerm;
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(refreshChatList, 180);
  });
  $('#chat-search-clear').addEventListener('click', () => {
    chatSearchTerm = '';
    $('#chat-search').value = '';
    $('#chat-search-clear').hidden = true;
    refreshChatList();
  });
}

// New project.
if (document.getElementById('btn-new-project')) {
  $('#btn-new-project').addEventListener('click', async () => {
    const name = await showInput({ title: 'New project', placeholder: 'Project name', okText: 'Create' });
    if (!name) return;
    await window.bones.projectsAdd(name);
    refreshChatList();
  });
}

// Right-click the blank area of the chat list → blank-area menu.
if (document.querySelector('.chat-list-wrap')) {
  document.querySelector('.chat-list-wrap').addEventListener('contextmenu', (e) => {
    // Only when not over a chat row or project head (those handle their own).
    if (e.target.closest('.chat-row') || e.target.closest('.project-head')) return;
    e.preventDefault();
    chatListBlankMenu(e.clientX, e.clientY);
  });
}

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
  resetStreamMeter();

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
      const s = await window.bones.serverStatus();
      state.currentMessages.push({
        role: 'assistant',
        content: state.pendingAgentText || res.text || '',
        model: s.activeModelId || 'local',
      });
    }
    // Persist the chat
    const saved = await window.bones.chatSave({
      id: state.currentChatId,
      messages: state.currentMessages,
    });
    if (saved && saved.id) {
      state.currentChatId = saved.id;
      if (state.pendingProjectId) {
        await window.bones.chatSetProject(saved.id, state.pendingProjectId);
        state.pendingProjectId = null;
      }
    }
    refreshChatList();
  } catch (err) {
    state.pendingAgentEl.classList.remove('thinking');
    state.pendingAgentEl.innerHTML = `<div class="bubble-content" style="color:var(--err)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    // Drop the streaming meter from the now-settled bubble.
    if (state.pendingAgentEl) {
      const m = state.pendingAgentEl.querySelector('.streaming-meter');
      if (m) m.remove();
    }
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

// ⌘↩ submit · ⌘⇧↩ ask Claude
$('#chat-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) askClaudeFromChat();
    else $('#chat-form').requestSubmit();
  }
});

// ----- Ask Claude (from chat) -----
//
// Redacts the whole conversation locally (regex + optional model NER), keeps
// the placeholder→original map in memory, sends the redacted multi-turn
// transcript to Claude, streams the reply, then swaps the placeholders back
// before showing it. The reply is tagged with the Claude model so the chat
// history visibly shows which turns came from where.
$('#btn-chat-ask-claude').addEventListener('click', askClaudeFromChat);

async function askClaudeFromChat() {
  if (state.currentRunId) return;
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  // Confirm Claude key is set before doing any work.
  const ks = await window.bones.claudeKeyStatus();
  if (!ks || !ks.hasKey) {
    setStatus('no API key — Settings → Claude API', 'err');
    return;
  }
  input.value = '';
  state.currentMessages.push({ role: 'user', content: text });
  renderMessages();

  // Append the assistant bubble up front so the user sees something is
  // happening; mark it as claude-sourced so it styles distinctly.
  state.pendingAgentEl = appendThinkingBubble({ source: 'claude' });
  state.pendingAgentText = '';
  resetStreamMeter();

  const runId = 'ac-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  state.tokenSink = 'ask-claude';
  $('#btn-chat-send').disabled = true;
  $('#btn-chat-ask-claude').disabled = true;
  $('#btn-chat-cancel').hidden = false;
  setStatus('redacting…', 'warn');

  try {
    // 1. Redact the whole conversation as one block (so the same name across
    //    turns maps to the same placeholder consistently).
    const transcript = state.currentMessages
      .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content)
      .join('\n\n');
    const redactRes = await window.bones.redact(
      { text: transcript, useModel: state.serverReady },
      runId + '-r'
    );
    if (redactRes && redactRes.error) throw new Error(redactRes.error.message || 'redact failed');

    // 2. Stash the map so we can put real names back into Claude's reply.
    const map = {};
    for (const r of (redactRes.replacements || [])) map[r.placeholder] = r.original;
    state.askClaudeMap = map;

    // 3. Split the redacted transcript back into messages by role marker,
    //    preserving multi-turn structure for Claude.
    const messages = splitTranscriptToMessages(redactRes.text || transcript);

    // 4. Stream the response.
    setStatus('asking Claude…', 'warn');
    const res = await window.bones.claudeSend({ messages }, runId);
    if (res && res.error) {
      state.pendingAgentEl.classList.remove('thinking');
      state.pendingAgentEl.innerHTML = `<div class="bubble-content" style="color:var(--err)">Error: ${escapeHtml(res.error.message)}</div>`;
      state.currentMessages.push({ role: 'assistant', content: `[Claude error: ${res.error.message}]`, model: res.model || 'claude' });
    } else {
      // 5. Re-identify placeholders in the streamed text and re-render the
      //    bubble with the real names back.
      const raw = state.pendingAgentText || res.text || '';
      const filled = reidentifyWithMap(raw, map);
      const contentEl = state.pendingAgentEl.querySelector('.bubble-content');
      if (contentEl) contentEl.textContent = filled.text;
      const reidentNote = state.pendingAgentEl.querySelector('.via-claude-note');
      if (reidentNote && filled.count > 0) {
        reidentNote.textContent = `via ${res.model || 'Claude'} · ${filled.count} name(s) re-identified locally`;
      }
      state.currentMessages.push({ role: 'assistant', content: filled.text, model: res.model || 'claude' });
    }
    // 6. Persist the chat with the model tag preserved.
    const saved = await window.bones.chatSave({ id: state.currentChatId, messages: state.currentMessages });
    if (saved && saved.id) {
      state.currentChatId = saved.id;
      if (state.pendingProjectId) {
        await window.bones.chatSetProject(saved.id, state.pendingProjectId);
        state.pendingProjectId = null;
      }
    }
    refreshChatList();
  } catch (err) {
    state.pendingAgentEl.classList.remove('thinking');
    state.pendingAgentEl.innerHTML = `<div class="bubble-content" style="color:var(--err)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (state.pendingAgentEl) {
      const m = state.pendingAgentEl.querySelector('.streaming-meter');
      if (m) m.remove();
    }
    state.currentRunId = null;
    state.tokenSink = null;
    state.pendingAgentEl = null;
    state.pendingAgentText = '';
    state.askClaudeMap = null;
    $('#btn-chat-send').disabled = false;
    $('#btn-chat-ask-claude').disabled = false;
    $('#btn-chat-cancel').hidden = true;
  }
}

// Re-identify against a specific map (caller-supplied), without touching state.
function reidentifyWithMap(text, map) {
  let count = 0;
  const seen = new Set();
  const out = text.replace(/\[([A-Z]+_\d+)\]/g, (full) => {
    const real = map[full];
    if (real == null) return full;
    if (!seen.has(full)) { seen.add(full); count++; }
    return real;
  });
  return { text: out, count };
}

// Recover a multi-turn messages array from a "User: …\n\nAssistant: …"
// transcript. Robust to extra blank lines and to assistant messages that
// span paragraphs.
function splitTranscriptToMessages(transcript) {
  const lines = transcript.split('\n');
  const out = [];
  let role = null;
  let buf = [];
  const flush = () => {
    if (role && buf.length) {
      const content = buf.join('\n').trim();
      if (content) out.push({ role, content });
    }
    buf = [];
  };
  for (const line of lines) {
    const um = line.match(/^User:\s*(.*)$/);
    const am = line.match(/^Assistant:\s*(.*)$/);
    if (um) { flush(); role = 'user'; buf.push(um[1]); }
    else if (am) { flush(); role = 'assistant'; buf.push(am[1]); }
    else { buf.push(line); }
  }
  flush();
  // Claude requires the last message to be from the user; if the transcript
  // ends with an assistant message (shouldn't happen for chat flows), fall
  // through and trust the API to reject it with a clear error.
  return out;
}

// Streaming counters: shared state across whichever bubble/output is live.
const streamMeter = { startedAt: 0, tokens: 0 };
function bumpStreamMeter(el, label) {
  // Cheap-ish: ~one token per delta is a good-enough proxy for the UI.
  streamMeter.tokens += 1;
  if (!streamMeter.startedAt) streamMeter.startedAt = Date.now();
  if (el && !el.hidden) setStreamingMeter(el, { tokens: streamMeter.tokens, startedAt: streamMeter.startedAt, label });
}
function resetStreamMeter() { streamMeter.startedAt = 0; streamMeter.tokens = 0; }

// Token stream for both chat and work runs
window.bones.onToken(({ runId, delta }) => {
  if (runId !== state.currentRunId) return;
  // Chat path (local model OR Ask Claude)
  if (state.pendingAgentEl) {
    const isClaude = state.pendingAgentEl.classList.contains('via-claude');
    if (state.pendingAgentEl.classList.contains('thinking')) {
      state.pendingAgentEl.classList.remove('thinking');
      const subtitle = isClaude ? '<div class="via-claude-note">via Claude · redacted in flight</div>' : '';
      const mark = isClaude ? claudeStarSvg('claude-star-spin') : skullSvg('skull-spin');
      state.pendingAgentEl.innerHTML = `${mark}<div class="bubble-content"></div>${subtitle}<div class="streaming-meter"></div>`;
    }
    state.pendingAgentText += delta;
    const c = state.pendingAgentEl.querySelector('.bubble-content');
    // For Ask Claude, re-identify placeholders in the streaming text live so
    // the user sees real names appear progressively rather than [PERSON_1].
    if (c) c.textContent = isClaude && state.askClaudeMap
      ? reidentifyWithMap(state.pendingAgentText, state.askClaudeMap).text
      : state.pendingAgentText;
    bumpStreamMeter(state.pendingAgentEl.querySelector('.streaming-meter'), isClaude ? 'Claude' : 'generating');
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
    const cm = $('#cannon-meter');
    if (cm) bumpStreamMeter(cm, 'Claude streaming');
    return;
  }
  // Brain research path (Claude API response into the brief area)
  if (state.tokenSink === 'brain') {
    const br = $('#brain-response');
    if (br) { br.textContent += delta; br.scrollTop = br.scrollHeight; }
    const bm = $('#brain-response-meter');
    if (bm) bumpStreamMeter(bm, 'Claude researching');
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

async function applyIngest(res) {
  if (!res) return;
  const merged = await mergeWithDupCheck(state.files, res.files || [], 'Work');
  state.files = merged.files;
  state.skipped = (res.skipped || []).concat(state.skipped);
  renderFilesSummary();
  refreshStatus();
}

function renderFilesSummary() {
  renderFilesCard({
    container: $('#files-summary'),
    files: state.files,
    skipped: state.skipped,
    emptyHint: 'No files loaded yet. Drag them onto the dropzone above, or use <strong>Pick files…</strong>.',
    onRemove: (_f, i) => {
      state.files.splice(i, 1);
      renderFilesSummary();
    },
  });
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
  // Three-stage pipeline: expanding (10%) → scanning (70%) → judging (20%).
  if (p.stage === 'expanding') {
    renderProgress(el, { pct: 5, label: 'Expanding query with related terms' });
  } else if (p.stage === 'scanning') {
    renderProgress(el, { pct: 50, label: 'Scanning files', sub: p.total != null ? `${p.total} file(s)` : '' });
  } else if (p.stage === 'judging') {
    renderProgress(el, { pct: 85, label: 'Judging top matches with the model', sub: p.count != null ? `${p.count} candidate(s)` : '' });
  } else if (p.stage === 'done') {
    clearProgress(el);
  }
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

// ===== ABSORB =====
// Absorb has its own top-level tab with its own dropzone and file list,
// independent of Work. Drop files here → extract facts → review → save to
// Memory.

// Track the most recent file index + chunk progress so we can compute a
// rolling "% complete" across the whole absorb run.
const absorbProgress = { files: 0, currentFile: 0, currentChunk: 0, totalChunks: 0 };

if (window.bones.onAbsorbProgress) {
  window.bones.onAbsorbProgress((p) => {
    if (p.runId !== state.currentRunId) return;
    const el = $('#absorb-progress');
    if (!el) return;
    if (p.stage === 'file') {
      absorbProgress.files = p.of;
      absorbProgress.currentFile = p.index;
      absorbProgress.currentChunk = 0;
      absorbProgress.totalChunks = 0;
      renderProgress(el, {
        pct: ((p.index - 1) / p.of) * 100,
        label: `Reading file ${p.index} of ${p.of}`,
        sub: p.file,
      });
    } else if (p.stage === 'extracting') {
      absorbProgress.currentChunk = p.chunk;
      absorbProgress.totalChunks = p.of;
      const filesPct = (absorbProgress.currentFile - 1) / absorbProgress.files;
      const insidePct = (p.chunk / p.of) / absorbProgress.files;
      renderProgress(el, {
        pct: (filesPct + insidePct) * 100,
        label: `Extracting from ${p.file}`,
        sub: `part ${p.chunk} of ${p.of}`,
      });
    } else if (p.stage === 'done') {
      clearProgress(el);
    }
  });
}

// --- Absorb dropzone + file list ---

const absorbDropzone = $('#absorb-dropzone');
if (absorbDropzone) {
  ['dragenter', 'dragover'].forEach((evt) => {
    absorbDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      absorbDropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    absorbDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      absorbDropzone.classList.remove('dragover');
    });
  });
  absorbDropzone.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files) return;
    const paths = [];
    for (const f of dt.files) if (f.path) paths.push(f.path);
    if (paths.length === 0) return;
    await ingestAbsorb(paths);
  });
}

$('#btn-absorb-pick-files')?.addEventListener('click', async () => {
  applyAbsorbIngest(await window.bones.pickFiles());
});
$('#btn-absorb-pick-folder')?.addEventListener('click', async () => {
  applyAbsorbIngest(await window.bones.pickFolder());
});
$('#btn-absorb-clear')?.addEventListener('click', () => {
  state.absorbFiles = [];
  state.absorbSkipped = [];
  renderAbsorbFilesSummary();
});

async function ingestAbsorb(paths) {
  setStatus('reading files…', 'warn');
  const res = await window.bones.ingestPaths(paths);
  if (res && res.error) { setStatus('ingest error: ' + res.error.message, 'err'); return; }
  applyAbsorbIngest(res);
}
async function applyAbsorbIngest(res) {
  if (!res) return;
  const merged = await mergeWithDupCheck(state.absorbFiles, res.files || [], 'Absorb');
  state.absorbFiles = merged.files;
  state.absorbSkipped = (res.skipped || []).concat(state.absorbSkipped);
  renderAbsorbFilesSummary();
}
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fileKindIcon(kind) {
  // Lightweight inline SVG. All three glyphs share the same "page" outline so
  // the list reads as a tidy column. Kind label sits on a chip beside the name.
  const base = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>';
  return `<svg class="file-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${base}</svg>`;
}
// Detect files that match something already loaded. Match is by full path if
// available, otherwise by (name + byte size). Returns the duplicate names so
// they can be listed in the conflict prompt.
function findDuplicates(existing, incoming) {
  const out = [];
  for (const inc of incoming) {
    const dup = existing.find((e) => {
      if (inc.path && e.path && inc.path === e.path) return true;
      if (!inc.path || !e.path) return false;
      return (e.name === inc.name && e.bytes === inc.bytes);
    });
    if (dup) out.push({ incoming: inc, existing: dup });
  }
  return out;
}

// Ask the user how to resolve duplicates. Resolves to one of:
//   'replace'    — drop the existing entries, add the incoming
//   'keep-both'  — add the incoming alongside
//   'cancel'     — drop the incoming, keep things as they are
function promptDuplicateChoice(duplicates) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    const names = duplicates.map((d) => d.incoming.name || d.incoming.path).slice(0, 6);
    const extra = duplicates.length > 6 ? ` <span class="muted">…and ${duplicates.length - 6} more</span>` : '';
    modal.innerHTML = `
      <div class="modal-card modal-small">
        <div class="modal-head">
          <h3>${duplicates.length} duplicate file${duplicates.length === 1 ? '' : 's'}</h3>
        </div>
        <p class="hint">${duplicates.length === 1 ? 'This file is' : 'These files are'} already loaded:</p>
        <ul class="dup-list">${names.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}${extra ? `<li>${extra}</li>` : ''}</ul>
        <p class="hint">How would you like to handle ${duplicates.length === 1 ? 'it' : 'them'}?</p>
        <div class="modal-actions">
          <button data-act="cancel">Cancel (skip)</button>
          <button data-act="keep-both">Keep both</button>
          <button data-act="replace" class="primary">Replace</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      document.body.removeChild(modal);
      resolve(btn.dataset.act);
    });
  });
}

// Merge an ingest result into a destination file list, asking the user when
// duplicates exist. Returns the new list (caller assigns).
async function mergeWithDupCheck(existing, incoming, label) {
  if (!incoming || incoming.length === 0) return { files: existing, skipped: 0 };
  const dups = findDuplicates(existing, incoming);
  if (dups.length === 0) {
    // No conflicts — prepend like before so newest sits at top.
    return { files: incoming.concat(existing), skipped: 0 };
  }
  const choice = await promptDuplicateChoice(dups);
  if (choice === 'cancel') {
    // Drop only the duplicates from the incoming; keep any non-duplicate
    // incoming files (a folder drop might have new files alongside dupes).
    const dupSet = new Set(dups.map((d) => d.incoming));
    const filtered = incoming.filter((f) => !dupSet.has(f));
    setStatus(`${label}: skipped ${dups.length} duplicate${dups.length === 1 ? '' : 's'}`, 'warn');
    return { files: filtered.concat(existing), skipped: dups.length };
  }
  if (choice === 'replace') {
    const dupExisting = new Set(dups.map((d) => d.existing));
    const remaining = existing.filter((f) => !dupExisting.has(f));
    setStatus(`${label}: replaced ${dups.length} duplicate${dups.length === 1 ? '' : 's'}`, 'ok');
    return { files: incoming.concat(remaining), skipped: 0 };
  }
  // keep-both — add everything; user gets two copies of the duplicate names
  setStatus(`${label}: kept both copies of ${dups.length} file${dups.length === 1 ? '' : 's'}`, 'ok');
  return { files: incoming.concat(existing), skipped: 0 };
}

// Shared renderer for the loaded-files card. Both the Work and Absorb tabs use
// this so the visual stays identical and any future tweak lands in one place.
// `onRemove(file)` is called when the per-row × is clicked; the caller mutates
// its own state and re-renders.
function renderFilesCard({ container, files, skipped, emptyHint, onRemove }) {
  if (!container) return;
  if ((!files || files.length === 0) && (!skipped || skipped.length === 0)) {
    container.innerHTML = `<div class="files-card empty">${emptyHint}</div>`;
    return;
  }
  const totalChars = files.reduce((n, f) => n + (f.text ? f.text.length : 0), 0);
  const tokenEst = Math.round(totalChars / 4); // very rough
  let html = '<div class="files-card">';
  html += `<div class="files-card-head">
    <div class="files-card-title"><strong>${files.length}</strong> file${files.length === 1 ? '' : 's'} loaded</div>
    <div class="files-card-stats muted">${totalChars.toLocaleString()} chars · ~${tokenEst.toLocaleString()} tokens</div>
  </div>`;
  html += '<ul class="files-list">';
  files.slice(0, 30).forEach((f, i) => {
    const name = f.name || f.path || '(unnamed)';
    const kind = (f.kind || '').toUpperCase();
    const size = fmtBytes(f.bytes);
    html += `<li class="file-row" data-idx="${i}">
      <span class="file-row-icon">${fileKindIcon(f.kind)}</span>
      <span class="file-row-name" title="${escapeHtml(f.path || name)}">${escapeHtml(name)}</span>
      <span class="file-row-meta">
        ${kind ? `<span class="kind-chip">${escapeHtml(kind)}</span>` : ''}
        <span class="file-row-size">${size}</span>
      </span>
      <button class="file-row-del" data-idx="${i}" aria-label="Remove">×</button>
    </li>`;
  });
  if (files.length > 30) {
    html += `<li class="file-row more muted">…and ${files.length - 30} more not shown</li>`;
  }
  html += '</ul>';
  if (skipped && skipped.length > 0) {
    html += '<div class="files-skipped">';
    html += `<div class="files-skipped-head muted">${skipped.length} skipped:</div>`;
    for (const s of skipped.slice(0, 10)) {
      html += `<div class="files-skipped-row muted">${escapeHtml(s.path || '?')} — ${escapeHtml(s.reason || '')}</div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
  if (onRemove) {
    container.querySelectorAll('.file-row-del').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.idx);
        if (Number.isFinite(i) && files[i]) onRemove(files[i], i);
      });
    });
  }
}

function renderAbsorbFilesSummary() {
  renderFilesCard({
    container: $('#absorb-files-summary'),
    files: state.absorbFiles,
    skipped: state.absorbSkipped,
    emptyHint: 'No files loaded yet. Drag them onto the dropzone above, or use <strong>Pick files…</strong>.',
    onRemove: (_f, i) => {
      state.absorbFiles.splice(i, 1);
      renderAbsorbFilesSummary();
    },
  });
}

$('#btn-absorb').addEventListener('click', async () => {
  if (state.currentRunId) return;
  if (!state.serverReady) { setStatus('model not ready', 'err'); return; }
  if (state.absorbFiles.length === 0) {
    setStatus('drop or pick files first', 'err');
    return;
  }
  const runId = 'ab-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.currentRunId = runId;
  $('#btn-absorb').disabled = true;
  $('#btn-absorb-cancel').hidden = false;
  setStatus('absorbing…', 'warn');
  try {
    const payload = state.absorbFiles.map((f) => ({ name: f.name || f.path, text: f.text || '' }));
    const res = await window.bones.absorbRun(payload, runId);
    if (res && res.error) {
      setStatus('absorb error: ' + (res.error.message || 'unknown'), 'err');
      return;
    }
    // Stage docs + facts for review. Even if the run was cancelled partway,
    // the docs array contains everything extracted up to that point — surface
    // it for review instead of throwing the work away.
    state.absorbDocs = (res.documents || []).map((d) => ({
      name: d.name,
      facts: (d.facts || []).map((text) => ({ text, picked: true })),
    }));
    const total = state.absorbDocs.reduce((n, d) => n + d.facts.length, 0);
    const wasCancelled = !!res.cancelled;
    if (total === 0) {
      setStatus(wasCancelled ? 'cancelled · nothing extracted yet' : 'absorbed · no facts extracted', 'warn');
      return;
    }
    state.absorbCancelled = wasCancelled;
    showAbsorbModal();
    const filesDone = state.absorbDocs.filter((d) => d.facts.length > 0).length;
    setStatus(
      wasCancelled
        ? `cancelled · ${total} fact(s) from ${filesDone} file(s) ready to review`
        : `absorbed · ${total} fact(s) to review`,
      'ok'
    );
  } catch (err) {
    setStatus('absorb error: ' + err.message, 'err');
  } finally {
    state.currentRunId = null;
    $('#btn-absorb').disabled = false;
    $('#btn-absorb-cancel').hidden = true;
    $('#absorb-progress').hidden = true;
  }
});

$('#btn-absorb-cancel').addEventListener('click', () => {
  if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
});

function showAbsorbModal() {
  renderAbsorbReview();
  $('#absorb-modal').hidden = false;
}
function hideAbsorbModal() {
  $('#absorb-modal').hidden = true;
  state.absorbDocs = [];
}

function renderAbsorbReview() {
  const root = $('#absorb-review');
  root.innerHTML = '';
  if (state.absorbCancelled) {
    const banner = document.createElement('div');
    banner.className = 'absorb-banner';
    banner.textContent = 'Cancelled — these are the partial results extracted before you stopped the run. You can still keep any of them.';
    root.appendChild(banner);
  }
  for (let di = 0; di < state.absorbDocs.length; di++) {
    const doc = state.absorbDocs[di];
    const group = document.createElement('div');
    group.className = 'absorb-group';
    group.innerHTML = `<div class="absorb-source">From <code></code></div>`;
    group.querySelector('code').textContent = doc.name;
    for (let fi = 0; fi < doc.facts.length; fi++) {
      const f = doc.facts[fi];
      const row = document.createElement('label');
      row.className = 'absorb-row';
      row.innerHTML = `<input type="checkbox"><span class="absorb-text"></span>`;
      const cb = row.querySelector('input');
      cb.checked = f.picked;
      cb.addEventListener('change', () => {
        state.absorbDocs[di].facts[fi].picked = cb.checked;
        updateAbsorbCounter();
      });
      row.querySelector('.absorb-text').textContent = f.text;
      group.appendChild(row);
    }
    root.appendChild(group);
  }
  updateAbsorbCounter();
}

function updateAbsorbCounter() {
  let total = 0, picked = 0;
  for (const d of state.absorbDocs) for (const f of d.facts) { total++; if (f.picked) picked++; }
  $('#absorb-counter').textContent = `${picked}/${total} selected`;
}

$('#btn-absorb-close').addEventListener('click', hideAbsorbModal);
$('#btn-absorb-cancel-modal').addEventListener('click', () => {
  if (!confirm('Discard all absorbed facts without saving?')) return;
  hideAbsorbModal();
  setStatus('absorbed facts discarded', 'warn');
});
$('#btn-absorb-all').addEventListener('click', () => {
  for (const d of state.absorbDocs) for (const f of d.facts) f.picked = true;
  renderAbsorbReview();
});
$('#btn-absorb-none').addEventListener('click', () => {
  for (const d of state.absorbDocs) for (const f of d.facts) f.picked = false;
  renderAbsorbReview();
});
$('#btn-absorb-save').addEventListener('click', async () => {
  let savedTotal = 0;
  for (const doc of state.absorbDocs) {
    const picked = doc.facts.filter((f) => f.picked).map((f) => f.text);
    if (picked.length === 0) continue;
    const res = await window.bones.memoryAddMany(picked, doc.name);
    if (res && typeof res.added === 'number') savedTotal += res.added;
  }
  hideAbsorbModal();
  setStatus(`absorbed ${savedTotal} fact(s) into Memory`, 'ok');
  // If Memory section is visible right now, refresh it.
  refreshMemory();
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
    if (p.stage === 'model' && p.chunk) {
      // Model NER takes ~85% of the time; reserve the last 15% for regex.
      const pct = (p.chunk / p.of) * 85;
      renderProgress(el, {
        pct,
        label: 'Scanning for names with the local model',
        sub: `part ${p.chunk} of ${p.of}`,
      });
    } else if (p.stage === 'redacting') {
      renderProgress(el, { pct: 95, label: 'Applying redactions' });
    } else if (p.stage === 'done') {
      clearProgress(el);
    }
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
  resetStreamMeter();
  const cmEl = $('#cannon-meter');
  if (cmEl) { cmEl.hidden = false; cmEl.innerHTML = ''; }
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
    const cm = $('#cannon-meter');
    if (cm) cm.hidden = true;
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

// ===== BRAIN — research prompt engine =====
// Three views: list of saved briefs, compose new research, detail.

function showBrainView(name) {
  ['list', 'compose', 'detail'].forEach((v) => {
    const el = document.getElementById('brain-view-' + v);
    if (el) el.hidden = (v !== name);
  });
}

function resetBrainCompose() {
  $('#brain-question').value = '';
  $('#brain-audience').value = '';
  $('#brain-jurisdiction').value = '';
  $('#brain-depth').value = '';
  $('#brain-prompt').value = '';
  $('#brain-response').textContent = '';
  $('#brain-step-prompt').hidden = true;
  $('#brain-step-response').hidden = true;
  $('#btn-brain-save').disabled = true;
}

async function refreshBrain() {
  const notes = await window.bones.brainList();
  $('#brain-count').textContent = `${notes.length} brief${notes.length === 1 ? '' : 's'}`;
  const list = $('#brain-list');
  if (notes.length === 0) {
    list.innerHTML = '<p class="muted" style="padding:14px 4px">No briefs yet. Click <strong>+ New research</strong> to start one.</p>';
    return;
  }
  list.innerHTML = '';
  for (const n of notes.slice().reverse()) {
    const isBrief = n.kind === 'brief' || n.question;
    const snippet = (n.body || '').replace(/\s+/g, ' ').slice(0, 180);
    const div = document.createElement('div');
    div.className = 'brief';
    div.innerHTML = `
      <div class="brief-head">
        <div class="brief-title"></div>
        <div class="brief-meta">
          <span class="brief-date"></span>
          ${n.model ? `<span class="brief-model"></span>` : ''}
        </div>
      </div>
      ${isBrief && n.question ? '<div class="brief-question"></div>' : ''}
      <div class="brief-snippet"></div>
      <div class="brief-actions">
        <button class="btn-view" data-id="${n.id}">Open</button>
        <button class="btn-delete" data-id="${n.id}">Delete</button>
      </div>`;
    div.querySelector('.brief-title').textContent = n.title || 'Untitled';
    div.querySelector('.brief-date').textContent = new Date(n.created_at).toLocaleString();
    if (n.model) div.querySelector('.brief-model').textContent = n.model;
    if (isBrief && n.question) div.querySelector('.brief-question').textContent = n.question;
    div.querySelector('.brief-snippet').textContent = snippet + (snippet.length === 180 ? '…' : '');
    list.appendChild(div);
  }
  list.querySelectorAll('.btn-view').forEach((b) =>
    b.addEventListener('click', () => openBrief(b.dataset.id))
  );
  list.querySelectorAll('.btn-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this brief?')) return;
      await window.bones.brainDelete(b.dataset.id);
      refreshBrain();
    })
  );
}

async function openBrief(id) {
  const notes = await window.bones.brainList();
  const n = notes.find((x) => x.id === id);
  if (!n) return;
  $('#brain-detail-title').textContent = n.title || 'Untitled';
  const root = $('#brain-detail');
  root.innerHTML = '';
  if (n.question) {
    const block = document.createElement('div');
    block.className = 'brief-detail-section';
    block.innerHTML = '<div class="brief-detail-head">Research question</div><div class="brief-detail-body brief-detail-q"></div>';
    block.querySelector('.brief-detail-body').textContent = n.question;
    root.appendChild(block);
  }
  if (n.prompt) {
    const block = document.createElement('details');
    block.className = 'brief-detail-section brief-detail-prompt';
    block.innerHTML = '<summary class="brief-detail-head">Generated research prompt</summary><pre class="brief-detail-body"></pre>';
    block.querySelector('pre').textContent = n.prompt;
    root.appendChild(block);
  }
  const briefBlock = document.createElement('div');
  briefBlock.className = 'brief-detail-section';
  briefBlock.innerHTML = `<div class="brief-detail-head">Brief${n.model ? ` <span class="muted">· ${escapeHtml(n.model)}</span>` : ''} <span class="muted">· ${new Date(n.created_at).toLocaleString()}</span></div><pre class="brief-detail-body"></pre>`;
  briefBlock.querySelector('pre').textContent = n.body || '';
  root.appendChild(briefBlock);
  showBrainView('detail');
}

// --- Compose flow ---

if (document.getElementById('btn-brain-new')) {
  $('#btn-brain-new').addEventListener('click', () => {
    resetBrainCompose();
    showBrainView('compose');
    $('#brain-question').focus();
  });
  $('#btn-brain-back').addEventListener('click', () => {
    if ($('#brain-response').textContent.trim() && !confirm('Discard the current research and go back?')) return;
    showBrainView('list');
    refreshBrain();
  });
  $('#btn-brain-back-from-detail').addEventListener('click', () => {
    showBrainView('list');
    refreshBrain();
  });

  // Step 1 → Step 2: build the research prompt with the local model.
  $('#btn-brain-build').addEventListener('click', async () => {
    if (state.currentRunId) return;
    if (!state.serverReady) { setStatus('model not ready', 'err'); return; }
    const question = $('#brain-question').value.trim();
    if (!question) { setStatus('type a research question first', 'err'); return; }
    const runId = 'pe-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.currentRunId = runId;
    $('#btn-brain-build').disabled = true;
    $('#btn-brain-build-cancel').hidden = false;
    renderProgress($('#brain-build-progress'), { pct: null, label: 'Engineering a research prompt with the local model' });
    setStatus('building prompt…', 'warn');
    try {
      const res = await window.bones.promptEngineBuild({
        question,
        audience: $('#brain-audience').value,
        jurisdiction: $('#brain-jurisdiction').value,
        depth: $('#brain-depth').value,
      }, runId);
      if (res && res.error) {
        setStatus('prompt build failed: ' + res.error, 'err');
        return;
      }
      if (res && res.cancelled) {
        setStatus('prompt build cancelled', 'warn');
        return;
      }
      $('#brain-prompt').value = res.prompt || '';
      $('#brain-step-prompt').hidden = false;
      refreshBrainKeyLabel();
      $('#brain-prompt').focus();
      setStatus('prompt ready · review & edit before sending', 'ok');
    } catch (err) {
      setStatus('prompt build error: ' + err.message, 'err');
    } finally {
      state.currentRunId = null;
      $('#btn-brain-build').disabled = false;
      $('#btn-brain-build-cancel').hidden = true;
      clearProgress($('#brain-build-progress'));
    }
  });
  $('#btn-brain-build-cancel').addEventListener('click', () => {
    if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
  });

  // Step 2 → Step 3: send the prompt to Claude.
  $('#btn-brain-send').addEventListener('click', async () => {
    if (state.currentRunId) return;
    const promptText = $('#brain-prompt').value.trim();
    if (!promptText) { setStatus('build or write a prompt first', 'err'); return; }
    const keyStatus = await window.bones.claudeKeyStatus();
    if (!keyStatus || !keyStatus.hasKey) {
      $('#brain-nokey').hidden = false;
      setStatus('no API key — see Settings → Claude API', 'err');
      return;
    }
    const runId = 'br-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.currentRunId = runId;
    state.tokenSink = 'brain';
    $('#brain-step-response').hidden = false;
    $('#brain-response').textContent = '';
    $('#btn-brain-send').disabled = true;
    $('#btn-brain-send-cancel').hidden = false;
    $('#btn-brain-save').disabled = true;
    resetStreamMeter();
    const meter = $('#brain-response-meter');
    if (meter) { meter.hidden = false; meter.innerHTML = ''; }
    setStatus('researching with Claude…', 'warn');
    const startedAt = Date.now();
    try {
      // No material attached — this is a pure research prompt, not document
      // analysis. The cannon backend still works fine with material=''.
      const res = await window.bones.claudeSend({ prompt: promptText, material: '' }, runId);
      if (res && res.error) {
        $('#brain-response').textContent += '\n\n[Error: ' + res.error.message + ']';
        setStatus('Claude error', 'err');
        return;
      }
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      setStatus(`brief ready · ${res.model || 'done'} · ${secs}s`, 'ok');
      $('#btn-brain-save').disabled = false;
      // Stash the model used and the question/prompt so save can persist them.
      state.brainPending = {
        question: $('#brain-question').value.trim(),
        prompt: promptText,
        body: $('#brain-response').textContent.trim(),
        model: res.model,
      };
    } catch (err) {
      $('#brain-response').textContent += '\n\n[Error: ' + err.message + ']';
      setStatus('Claude error', 'err');
    } finally {
      state.currentRunId = null;
      state.tokenSink = null;
      $('#btn-brain-send').disabled = false;
      $('#btn-brain-send-cancel').hidden = true;
      if (meter) meter.hidden = true;
    }
  });
  $('#btn-brain-send-cancel').addEventListener('click', () => {
    if (state.currentRunId) window.bones.cancelRun(state.currentRunId);
  });

  // Save the brief into Brain storage.
  $('#btn-brain-save').addEventListener('click', async () => {
    const p = state.brainPending;
    if (!p) return;
    // Title = first 60 chars of the question.
    const title = (p.question || 'Research brief').replace(/\s+/g, ' ').slice(0, 60);
    await window.bones.brainAdd({
      title,
      body: p.body,
      question: p.question,
      prompt: p.prompt,
      model: p.model,
      kind: 'brief',
    });
    state.brainPending = null;
    setStatus('brief saved to Brain', 'ok');
    showBrainView('list');
    refreshBrain();
  });
  $('#btn-brain-discard').addEventListener('click', () => {
    if (!confirm('Discard this research without saving?')) return;
    resetBrainCompose();
    setStatus('discarded', 'warn');
  });
}

async function refreshBrainKeyLabel() {
  const label = $('#brain-model-label');
  const nokey = $('#brain-nokey');
  if (!label) return;
  const st = await window.bones.claudeKeyStatus();
  if (st && st.hasKey) {
    label.textContent = `via ${st.model}`;
    nokey.hidden = true;
  } else {
    label.textContent = '';
    nokey.hidden = false;
  }
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
      const sourceMark = e.source ? '<span class="memory-source"></span>' : '';
      row.innerHTML = `<div class="memory-body"><span class="memory-text"></span>${sourceMark}</div><button class="memory-del" data-id="${e.id}" title="Forget">×</button>`;
      row.querySelector('.memory-text').textContent = e.text;
      const srcEl = row.querySelector('.memory-source');
      if (srcEl) srcEl.textContent = 'from ' + e.source;
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

async function setAboutVersion() {
  if (!window.bones.appVersion) return;
  try {
    const v = await window.bones.appVersion();
    if (v) {
      const a = document.getElementById('about-version');
      const m = document.getElementById('brand-version');
      if (a) a.textContent = v;
      if (m) m.textContent = 'v' + v;
    }
  } catch (_) {}
}

refreshStatus();
refreshChatList();
populateSetupCard();
setAboutVersion();
renderFilesSummary();
renderAbsorbFilesSummary();
refreshContextMeter();
