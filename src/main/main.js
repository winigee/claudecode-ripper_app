const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');

const config = require('./config');
const llamaServer = require('./llama-server');
const llama = require('./llama');
const modelDownload = require('./model-download');
const ingest = require('./ingest');
const brain = require('./brain');

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

app.on('before-quit', () => {
  llamaServer.stop();
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
    await llamaServer.start().catch(() => {});
    event.sender.send('server:status', llamaServer.status());
  }
  return res;
});

ipcMain.handle('model:cancel', () => modelDownload.cancelDownload());

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

ipcMain.handle('brain:list', () => brain.listNotes());
ipcMain.handle('brain:add', (_e, note) => brain.addNote(note || {}));
ipcMain.handle('brain:delete', (_e, id) => ({ ok: brain.deleteNote(id) }));
