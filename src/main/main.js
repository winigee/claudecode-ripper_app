const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');

const config = require('./config');
const llamaServer = require('./llama-server');
const llama = require('./llama');
const modelDownload = require('./model-download');

const ingest = require('./ingest');
const docsearch = require('./docsearch');
const redact = require('./redact');
const prompts = require('./prompts');
const claudeApi = require('./claude-api');
const memory = require('./memory');
const absorb = require('./absorb');
const promptEngine = require('./prompt-engine');
const brain = require('./brain');
const chats = require('./chats');
const projects = require('./projects');
const webServer = require('./web-server');
const { BackBonesSession } = require('./backbones');

let mainWindow = null;
const activeRuns = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 500,
    title: 'BonesAI',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    { label: 'File', submenu: [isMac ? { role: 'close' } : { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function tryAutoStartServer() {
  if (!config.modelInstalled()) return;
  if (!config.llamafileInstalled() && !llamaServer.status().binary) return;
  try {
    await llamaServer.start();
    if (mainWindow) mainWindow.webContents.send('server:status', llamaServer.status());
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('server:status', llamaServer.status());
  }
}

app.whenReady().then(async () => {
  buildMenu();
  createWindow();

  mainWindow.webContents.once('did-finish-load', () => {
    tryAutoStartServer();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  llamaServer.stop();
  try { await webServer.stop(); } catch (_) {}
});

// Auto-start web server on app launch if previously enabled.
app.whenReady().then(async () => {
  const cfg = webServer.getWebConfig();
  if (cfg.enabled) {
    try { await webServer.start(); } catch (_) {}
  }
});

// --- IPC ---

function errorPayload(err) {
  return { error: { message: err.message, code: err.code || null } };
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('server:status', () => llamaServer.status());

ipcMain.handle('server:start', async () => {
  try {
    await llamaServer.start();
    return llamaServer.status();
  } catch (err) {
    return { ...llamaServer.status(), error: { message: err.message, code: err.code || null } };
  }
});

ipcMain.handle('server:log-tail', () => llamaServer.tail());

// Save the current llama-server log to a file the user picks, so they can
// send it for diagnostics. Writes both the persistent log file (everything
// since llamafile first ran) and a header with system info.
ipcMain.handle('server:export-log', async () => {
  const fs = require('fs');
  const os = require('os');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultName = `bonesai-log-${stamp}.txt`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export diagnostic log',
    defaultPath: defaultName,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };

  const status = llamaServer.status();
  const header = [
    `BonesAI diagnostic log`,
    `Exported: ${new Date().toISOString()}`,
    `App: ${app.getName()} ${app.getVersion()}`,
    `Platform: ${process.platform} ${process.arch} · Node ${process.versions.node} · Electron ${process.versions.electron}`,
    `OS: ${os.type()} ${os.release()}`,
    `Hardware: ${os.cpus().length} CPU thread(s) · ${Math.round(os.totalmem() / 1024 ** 3)} GB RAM`,
    `Active model: ${status.activeModelId}`,
    `Model path: ${status.modelPath}`,
    `llamafile binary: ${status.binary}`,
    `Server ready: ${status.ready} · port ${status.port}`,
    `Last server error: ${status.error ? status.error.message : '(none)'}`,
    `Runtime: context=${status.runtime?.context} threads=${status.runtime?.threads}`,
    `---- llama-server.log (full file follows) ----`,
    '',
  ].join('\n');

  let body = '';
  try {
    body = fs.readFileSync(status.logFilePath, 'utf8');
  } catch (e) {
    body = `(could not read log file at ${status.logFilePath}: ${e.message})\n\n`
      + 'In-memory tail follows:\n\n'
      + llamaServer.tail().join('\n');
  }
  try {
    fs.writeFileSync(result.filePath, header + body);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('model:download', async (event) => {
  const send = (p) => {
    try { event.sender.send('model:progress', p); } catch (_) {}
  };
  const res = await modelDownload.startDownload(send);
  if (res.ok) {
    setImmediate(async () => {
      try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
      try { await llamaServer.start(); } catch (_) {}
      try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
    });
  }
  return res;
});

ipcMain.handle('model:download-specific', async (event, modelId) => {
  const send = (p) => {
    try { event.sender.send('model:progress', { ...p, modelId }); } catch (_) {}
  };
  const res = await modelDownload.downloadModel(modelId, send);
  try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
  return res;
});

ipcMain.handle('model:delete', (_e, modelId) => modelDownload.deleteModel(modelId));

ipcMain.handle('model:list', () => config.listModels());
// Explicit rescan: drop the cache so a just-dropped .gguf is picked up now
// rather than within the scan TTL.
ipcMain.handle('model:rescan', () => { config.invalidateModelScan(); return config.listModels(); });

ipcMain.handle('model:hardware', () => ({
  ...config.detectHardware(),
  recommended: config.recommendModelId(),
  active: config.getActiveModelId(),
}));

ipcMain.handle('model:set-active', async (event, modelId) => {
  if (!config.findModel(modelId)) return { error: 'Unknown model id' };
  if (!config.isModelInstalled(modelId)) return { error: 'Model not installed yet' };
  config.setActiveModelId(modelId);
  // Restart server with new model
  llamaServer.stop();
  try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
  setImmediate(async () => {
    try { await llamaServer.start(); } catch (_) {}
    try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
  });
  return { ok: true, activeModelId: modelId };
});

ipcMain.handle('model:cancel', () => modelDownload.cancelDownload());

// Open the models folder in Finder so the user can drop a manually-downloaded
// .gguf there without typing the long Application Support path.
ipcMain.handle('model:open-folder', () => {
  try { shell.openPath(config.modelsDir()); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

// --- Runtime tuning (context window) ---
ipcMain.handle('runtime:get', () => ({
  context: config.getContext(),
  threads: config.defaultThreads(),
  hardware: config.detectHardware(),
  contextChoices: config.CONTEXT_CHOICES,
  contextDefault: config.defaultContext(),
}));

ipcMain.handle('runtime:set-context', async (event, n) => {
  try {
    config.setContext(n);
  } catch (e) {
    return { error: e.message };
  }
  // Restart server so the new context takes effect.
  llamaServer.stop();
  try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
  setImmediate(async () => {
    try { await llamaServer.start(); } catch (_) {}
    try { event.sender.send('server:status', llamaServer.status()); } catch (_) {}
  });
  return { ok: true, context: config.getContext() };
});

ipcMain.handle('llama:ping', async () => {
  try {
    return await llama.ping();
  } catch (err) {
    return errorPayload(err);
  }
});

ipcMain.handle('llama:summarise', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onToken = (t) => {
      try { event.sender.send('llama:token', { runId, delta: t }); } catch (_) {}
    };
    const res = await llama.summarise(payload, { onToken, signal: ctrl.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

ipcMain.handle('llama:compact', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onToken = (t) => {
      try { event.sender.send('llama:token', { runId, delta: t }); } catch (_) {}
    };
    const res = await llama.compact(payload, { onToken, signal: ctrl.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

ipcMain.handle('llama:cancel', (_e, runId) => {
  const ctrl = activeRuns.get(runId);
  if (ctrl) {
    ctrl.abort();
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('docsearch:run', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onProgress = (p) => {
      try { event.sender.send('docsearch:progress', { runId, ...p }); } catch (_) {}
    };
    // Search returns whatever it could compute even when cancelled mid-judge.
    return await docsearch.search(payload || {}, { onProgress, signal: ctrl.signal });
  } catch (err) {
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

// --- REDACT ---
ipcMain.handle('redact:run', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onProgress = (p) => {
      try { event.sender.send('redact:progress', { runId, ...p }); } catch (_) {}
    };
    // Redact returns a regex-only result when the model NER is cancelled.
    return await redact.clean(payload.text || '', { useModel: payload.useModel !== false }, { onProgress, signal: ctrl.signal });
  } catch (err) {
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

// --- Prompt library ---
ipcMain.handle('prompts:list', () => prompts.list());
ipcMain.handle('prompts:save', (_e, p) => prompts.save(p || {}));
ipcMain.handle('prompts:delete', (_e, id) => prompts.remove(id));

// --- Claude API (cannon) ---
ipcMain.handle('claude:key-status', () => claudeApi.keyStatus());
ipcMain.handle('claude:set-key', (_e, key) => claudeApi.setKey(key));
ipcMain.handle('claude:set-model', (_e, model) => claudeApi.setModel(model));
ipcMain.handle('claude:send', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onToken = (t) => {
      try { event.sender.send('llama:token', { runId, delta: t }); } catch (_) {}
    };
    return await claudeApi.send(payload || {}, { onToken, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

ipcMain.handle('ingest:paths', async (_e, paths) => {
  try {
    return await ingest.ingestPaths(paths || []);
  } catch (err) {
    return errorPayload(err);
  }
});

ipcMain.handle('ingest:pick-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'rst', 'json', 'csv', 'log', 'pdf', 'docx'] },
    ],
  });
  if (result.canceled) return { files: [], skipped: [] };
  return ingest.ingestPaths(result.filePaths);
});

ipcMain.handle('ingest:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick a folder',
    properties: ['openDirectory'],
  });
  if (result.canceled) return { files: [], skipped: [] };
  return ingest.ingestPaths(result.filePaths);
});

// --- BackBones (encrypted peer-to-peer chat) ---
//
// A single session at a time (you're chatting with one friend, not many).
// All in-memory. The renderer drives the lifecycle via IPC.

let backbones = null; // current BackBonesSession or null

function emitBackBonesUpdate() {
  try {
    if (mainWindow) mainWindow.webContents.send('backbones:update', backbones ? backbones.status() : null);
  } catch (_) {}
}
function bindBackBonesEvents(session) {
  session.on('message', (m) => {
    try { if (mainWindow) mainWindow.webContents.send('backbones:message', m); } catch (_) {}
    emitBackBonesUpdate();
  });
  session.on('connected', emitBackBonesUpdate);
  session.on('closed', (reason) => {
    try { if (mainWindow) mainWindow.webContents.send('backbones:closed', { reason }); } catch (_) {}
    backbones = null;
    emitBackBonesUpdate();
  });
}

// Incoming connection (we're the initiator; a friend joined our URL).
webServer.setBackBonesHandler((ws, initiatorPubB64Unused) => {
  if (!backbones || backbones.role !== 'initiator') {
    try { ws.close(1008, 'no session waiting'); } catch (_) {}
    return;
  }
  backbones.attachPeer(ws);
  // The joiner sends 'hello' with its pubkey; we respond with our own so they
  // can derive the shared secret too.
  ws.on('message', (data) => {
    try {
      const j = JSON.parse(data.toString('utf8'));
      if (j && j.t === 'hello' && j.k && !backbones._sharedKey) {
        backbones.sendHandshake(); // send ours back
      }
    } catch (_) {}
  });
});

ipcMain.handle('backbones:start', async () => {
  if (backbones) backbones.close('replaced by new session');
  backbones = new BackBonesSession({ role: 'initiator' });
  bindBackBonesEvents(backbones);
  const cfg = webServer.getWebConfig();
  // A friend can only reach us on a non-localhost address, which requires the
  // web server to be running in LAN scope (binds 0.0.0.0 and enumerates all
  // interfaces incl. Tailscale). Bring it up automatically so the host doesn't
  // have to fiddle with Settings → Sharing first.
  if (!webServer.info().running || cfg.share !== 'lan') {
    webServer.updateWebConfig({ share: 'lan' });
    try { await webServer.restart(); }
    catch (_) { try { await webServer.start(); } catch (_) {} }
  }
  const info = webServer.info();
  const urls = (info.urls || []).map((u) => {
    const base = u.url.split('?')[0].replace(/^http/, 'ws') + 'ws/backbones';
    return {
      label: u.label,
      url: `${base}?init=${backbones.publicKeyB64}&t=${cfg.token}`,
    };
  });
  return {
    sessionId: backbones.id,
    fingerprint: backbones.fingerprint,
    urls,
    serverRunning: !!info.running,
  };
});

ipcMain.handle('backbones:join', async (_e, urlStr) => {
  // 'joiner' opens a WS to the URL the friend supplied. Once open, exchange
  // pubkeys, derive shared key, ready to chat.
  if (backbones) backbones.close('replaced by new session');
  let parsed;
  try { parsed = new URL(urlStr); }
  catch (_) { return { error: 'Not a valid URL.' }; }
  if (!/^wss?:$/.test(parsed.protocol)) return { error: 'URL must start with ws:// or wss://' };
  if (!parsed.searchParams.get('init')) return { error: 'URL is missing the &init= public key.' };

  backbones = new BackBonesSession({ role: 'joiner' });
  bindBackBonesEvents(backbones);
  try {
    // Use the global WebSocket (Node 22 supports it natively).
    const ws = new WebSocket(urlStr);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        if (backbones) { backbones.close('connect timeout'); backbones = null; }
        resolve({ error: 'Connection timed out. Is the friend\'s BonesAI running and reachable?' });
      }, 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        // Wrap browser WebSocket to look enough like the ws lib's API for
        // attachPeer (it uses .on / .send / .readyState / .close).
        const adapter = {
          readyState: 1,
          send: (d) => ws.send(d),
          close: () => ws.close(),
          on: (ev, cb) => {
            if (ev === 'message') ws.addEventListener('message', (m) => cb(Buffer.from(m.data || '')));
            else if (ev === 'close') ws.addEventListener('close', () => cb());
            else if (ev === 'error') ws.addEventListener('error', () => cb());
          },
        };
        backbones.attachPeer(adapter);
        // Initiator's pubkey came in the URL query — record it and send ours.
        try {
          backbones.setPeerKey(parsed.searchParams.get('init'));
          backbones.sendHandshake();
          backbones.emit('connected');
        } catch (e) {
          backbones.close('handshake failed: ' + e.message);
          backbones = null;
          resolve({ error: 'Handshake failed.' });
          return;
        }
        resolve({ sessionId: backbones.id, fingerprint: backbones.fingerprint });
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        if (backbones) { backbones.close('connect error'); backbones = null; }
        resolve({ error: 'Could not connect.' });
      });
    });
  } catch (e) {
    if (backbones) { backbones.close('connect threw'); backbones = null; }
    return { error: e.message };
  }
});

ipcMain.handle('backbones:send', (_e, text) => {
  if (!backbones) return { error: 'no session' };
  try { backbones.sendMessage(text); return { ok: true }; }
  catch (e) { return { error: e.message }; }
});

ipcMain.handle('backbones:close', () => {
  if (!backbones) return { ok: true };
  backbones.close('user closed');
  backbones = null;
  return { ok: true };
});

ipcMain.handle('backbones:status', () => backbones ? backbones.status() : null);

// --- Web server / network sharing ---
ipcMain.handle('web:info', () => webServer.info());
ipcMain.handle('web:start', async () => {
  try { return await webServer.start(); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('web:stop', async () => {
  try { return await webServer.stop(); }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('web:set-share', async (_e, share) => {
  webServer.updateWebConfig({ share });
  if (webServer.info().running) {
    try { return await webServer.restart(); }
    catch (e) { return { error: e.message }; }
  }
  return webServer.info();
});
ipcMain.handle('web:regen-token', () => webServer.regenerateToken());

// --- Shared memory ---
ipcMain.handle('memory:list', () => memory.list());
ipcMain.handle('memory:add', (_e, text, source) => memory.add(text, source));
ipcMain.handle('memory:add-many', (_e, items, source) => memory.addMany(items || [], source));
ipcMain.handle('memory:delete', (_e, id) => memory.remove(id));
ipcMain.handle('memory:config', () => memory.getConfig());
ipcMain.handle('memory:set-icloud', (_e, on) => memory.setICloud(on));

// --- Absorb ---
ipcMain.handle('absorb:run', async (event, files, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onProgress = (p) => {
      try { event.sender.send('absorb:progress', { runId, ...p }); } catch (_) {}
    };
    // Absorb returns whatever it managed before any cancel, with cancelled:true.
    return await absorb.absorbFiles(files || [], { onProgress, signal: ctrl.signal });
  } catch (err) {
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

// --- Prompt engine (Brain → Claude) ---
ipcMain.handle('prompt-engine:build', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    return await promptEngine.engineer(payload || {}, { signal: ctrl.signal });
  } catch (err) {
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});

ipcMain.handle('brain:list', () => brain.listNotes());
ipcMain.handle('brain:add', (_e, note) => brain.addNote(note || {}));
ipcMain.handle('brain:delete', (_e, id) => ({ ok: brain.deleteNote(id) }));

// --- Chat ---

ipcMain.handle('chat:list', () => chats.list());
ipcMain.handle('chat:search', (_e, query) => chats.search(query));
ipcMain.handle('chat:load', (_e, id) => chats.load(id));
ipcMain.handle('chat:save', (_e, chat) => chats.save(chat || {}));
ipcMain.handle('chat:delete', (_e, id) => ({ ok: chats.remove(id) }));
ipcMain.handle('chat:rename', (_e, { id, title }) => chats.rename(id, title));
ipcMain.handle('chat:set-project', (_e, { id, projectId }) => chats.setProject(id, projectId));

// --- Projects ---
ipcMain.handle('projects:list', () => projects.list());
ipcMain.handle('projects:add', (_e, name, parentId) => projects.add(name, parentId || null));
ipcMain.handle('projects:rename', (_e, { id, name }) => projects.rename(id, name));
ipcMain.handle('projects:delete', (_e, id) => projects.remove(id));

ipcMain.handle('llama:chat', async (event, payload, runId) => {
  const ctrl = new AbortController();
  activeRuns.set(runId, ctrl);
  try {
    const onToken = (t) => {
      try { event.sender.send('llama:token', { runId, delta: t }); } catch (_) {}
    };
    return await llama.chat(payload, { onToken, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
    return errorPayload(err);
  } finally {
    activeRuns.delete(runId);
  }
});
