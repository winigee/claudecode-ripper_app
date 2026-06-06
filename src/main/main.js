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
const brain = require('./brain');
const chats = require('./chats');
const webServer = require('./web-server');

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
    return await docsearch.search(payload || {}, { onProgress, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
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
    return await redact.clean(payload.text || '', { useModel: payload.useModel !== false }, { onProgress, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') return { error: { message: 'Cancelled', code: 'CANCELLED' } };
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
ipcMain.handle('memory:add', (_e, text) => memory.add(text));
ipcMain.handle('memory:delete', (_e, id) => memory.remove(id));
ipcMain.handle('memory:config', () => memory.getConfig());
ipcMain.handle('memory:set-icloud', (_e, on) => memory.setICloud(on));

ipcMain.handle('brain:list', () => brain.listNotes());
ipcMain.handle('brain:add', (_e, note) => brain.addNote(note || {}));
ipcMain.handle('brain:delete', (_e, id) => ({ ok: brain.deleteNote(id) }));

// --- Chat ---

ipcMain.handle('chat:list', () => chats.list());
ipcMain.handle('chat:load', (_e, id) => chats.load(id));
ipcMain.handle('chat:save', (_e, chat) => chats.save(chat || {}));
ipcMain.handle('chat:delete', (_e, id) => ({ ok: chats.remove(id) }));
ipcMain.handle('chat:rename', (_e, { id, title }) => chats.rename(id, title));

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
