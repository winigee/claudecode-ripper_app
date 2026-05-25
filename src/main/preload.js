const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bones', {
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setApiKey: (key) => ipcRenderer.invoke('settings:set-api-key', key),
  setModel: (model) => ipcRenderer.invoke('settings:set-model', model),

  // Claude
  ping: () => ipcRenderer.invoke('claude:ping'),
  summarise: (payload) => ipcRenderer.invoke('claude:summarise', payload),
  compact: (payload) => ipcRenderer.invoke('claude:compact', payload),

  // Ingest
  ingestPaths: (paths) => ipcRenderer.invoke('ingest:paths', paths),
  pickFiles: () => ipcRenderer.invoke('ingest:pick-files'),
  pickFolder: () => ipcRenderer.invoke('ingest:pick-folder'),

  // Brain
  brainList: () => ipcRenderer.invoke('brain:list'),
  brainAdd: (note) => ipcRenderer.invoke('brain:add', note),
  brainDelete: (id) => ipcRenderer.invoke('brain:delete', id),
});
