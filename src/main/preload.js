const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bones', {
  // Server / model lifecycle
  serverStatus: () => ipcRenderer.invoke('server:status'),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverLogTail: () => ipcRenderer.invoke('server:log-tail'),
  onServerStatus: (cb) => ipcRenderer.on('server:status', (_e, s) => cb(s)),
  modelDownload: () => ipcRenderer.invoke('model:download'),
  modelDownloadSpecific: (id) => ipcRenderer.invoke('model:download-specific', id),
  modelDelete: (id) => ipcRenderer.invoke('model:delete', id),
  modelList: () => ipcRenderer.invoke('model:list'),
  modelHardware: () => ipcRenderer.invoke('model:hardware'),
  modelSetActive: (id) => ipcRenderer.invoke('model:set-active', id),
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

  // Document search
  docSearch: (payload, runId) => ipcRenderer.invoke('docsearch:run', payload, runId),
  onDocSearchProgress: (cb) => ipcRenderer.on('docsearch:progress', (_e, p) => cb(p)),

  // Brain
  brainList: () => ipcRenderer.invoke('brain:list'),
  brainAdd: (note) => ipcRenderer.invoke('brain:add', note),
  brainDelete: (id) => ipcRenderer.invoke('brain:delete', id),

  // Chat
  chatList: () => ipcRenderer.invoke('chat:list'),
  chatLoad: (id) => ipcRenderer.invoke('chat:load', id),
  chatSave: (chat) => ipcRenderer.invoke('chat:save', chat),
  chatDelete: (id) => ipcRenderer.invoke('chat:delete', id),
  chatRename: (id, title) => ipcRenderer.invoke('chat:rename', { id, title }),
  chatStream: (payload, runId) => ipcRenderer.invoke('llama:chat', payload, runId),

  // Network sharing
  webInfo: () => ipcRenderer.invoke('web:info'),
  webStart: () => ipcRenderer.invoke('web:start'),
  webStop: () => ipcRenderer.invoke('web:stop'),
  webSetShare: (share) => ipcRenderer.invoke('web:set-share', share),
  webRegenToken: () => ipcRenderer.invoke('web:regen-token'),
});
