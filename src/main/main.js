const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');

const config = require('./config');
const claude = require('./claude');
const ingest = require('./ingest');
const brain = require('./brain');

let mainWindow = null;

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
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC handlers ---

function errorPayload(err) {
  return { error: { message: err.message, code: err.code || null } };
}

ipcMain.handle('settings:get', () => {
  return {
    hasApiKey: !!config.getApiKey(),
    apiKeyFromEnv: !!process.env.ANTHROPIC_API_KEY,
    model: config.getModel(),
  };
});

ipcMain.handle('settings:set-api-key', (_e, key) => {
  config.setApiKey(key || null);
  return { ok: true };
});

ipcMain.handle('settings:set-model', (_e, model) => {
  config.setModel(model);
  return { ok: true };
});

ipcMain.handle('claude:ping', async () => {
  try {
    return await claude.ping();
  } catch (err) {
    return errorPayload(err);
  }
});

ipcMain.handle('claude:summarise', async (_e, payload) => {
  try {
    return await claude.summarise(payload);
  } catch (err) {
    return errorPayload(err);
  }
});

ipcMain.handle('claude:compact', async (_e, payload) => {
  try {
    return await claude.compact(payload);
  } catch (err) {
    return errorPayload(err);
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

ipcMain.handle('brain:list', () => brain.listNotes());
ipcMain.handle('brain:add', (_e, note) => brain.addNote(note || {}));
ipcMain.handle('brain:delete', (_e, id) => ({ ok: brain.deleteNote(id) }));
