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

  // Runtime tuning
  runtimeGet: () => ipcRenderer.invoke('runtime:get'),
  runtimeSetContext: (n) => ipcRenderer.invoke('runtime:set-context', n),

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

  // REDACT
  redact: (payload, runId) => ipcRenderer.invoke('redact:run', payload, runId),
  onRedactProgress: (cb) => ipcRenderer.on('redact:progress', (_e, p) => cb(p)),

  // Prompt library
  promptList: () => ipcRenderer.invoke('prompts:list'),
  promptSave: (p) => ipcRenderer.invoke('prompts:save', p),
  promptDelete: (id) => ipcRenderer.invoke('prompts:delete', id),

  // Claude API (cannon)
  claudeKeyStatus: () => ipcRenderer.invoke('claude:key-status'),
  claudeSetKey: (key) => ipcRenderer.invoke('claude:set-key', key),
  claudeSetModel: (model) => ipcRenderer.invoke('claude:set-model', model),
  claudeSend: (payload, runId) => ipcRenderer.invoke('claude:send', payload, runId),

  // Brain
  brainList: () => ipcRenderer.invoke('brain:list'),
  brainAdd: (note) => ipcRenderer.invoke('brain:add', note),
  brainDelete: (id) => ipcRenderer.invoke('brain:delete', id),

  // Shared memory
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryAdd: (text) => ipcRenderer.invoke('memory:add', text),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryConfig: () => ipcRenderer.invoke('memory:config'),
  memorySetICloud: (on) => ipcRenderer.invoke('memory:set-icloud', on),

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
