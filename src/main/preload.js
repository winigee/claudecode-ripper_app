const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bones', {
  // Server / model lifecycle
  serverStatus: () => ipcRenderer.invoke('server:status'),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverLogTail: () => ipcRenderer.invoke('server:log-tail'),
  onServerStatus: (cb) => ipcRenderer.on('server:status', (_e, s) => cb(s)),
  modelDownload: () => ipcRenderer.invoke('model:download'),
  modelCancel: () => ipcRenderer.invoke('model:cancel'),
  onModelProgress: (cb) => ipcRenderer.on('model:progress', (_e, p) => cb(p)),

  // Inference
  ping: () => ipcRenderer.invoke('llama:ping'),
  summarise: (payload, runId) => ipcRenderer.invoke('llama:summarise', payload, runId),
  compact: (payload, runId) => ipcRenderer.invoke('llama:compact', payload, runId),
  cancelRun: (runId) => ipcRenderer.invoke('llama:cancel', runId),
  onToken: (cb) => ipcRenderer.on('llama:token', (_e, msg) => cb(msg)),

  // Ingest
  ingestPaths: (paths) => ipcRenderer.invoke('ingest:paths', paths),
  pickFiles: () => ipcRenderer.invoke('ingest:pick-files'),
  pickFolder: () => ipcRenderer.invoke('ingest:pick-folder'),

  // Brain
  brainList: () => ipcRenderer.invoke('brain:list'),
  brainAdd: (note) => ipcRenderer.invoke('brain:add', note),
  brainDelete: (id) => ipcRenderer.invoke('brain:delete', id),
});
