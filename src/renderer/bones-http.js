// HTTP transport for BonesAI when served from the in-app web server.
// Mirrors the window.bones API surface used by renderer.js so the same UI
// works whether running inside Electron (IPC) or in a browser tab.
//
// Token is read from URL query (?t=) or sessionStorage on first load.
// All API calls include the token via Authorization header.

(function () {
  function getToken() {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('t') || url.searchParams.get('token');
    if (t) {
      try { sessionStorage.setItem('bones-token', t); } catch (_) {}
      return t;
    }
    try { return sessionStorage.getItem('bones-token') || ''; }
    catch (_) { return ''; }
  }

  const TOKEN = getToken();

  function authHeaders(extra) {
    return Object.assign({
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    }, extra || {});
  }

  async function GET(path) {
    const r = await fetch(path, { headers: authHeaders() });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }
  async function POST(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }
  async function DELETE(path) {
    const r = await fetch(path, { method: 'DELETE', headers: authHeaders() });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }

  // SSE chat streaming.
  // The browser EventSource doesn't support POST bodies, so we use fetch + a
  // streaming reader to parse SSE manually.
  function streamChat(payload, onDelta) {
    const ctrl = new AbortController();
    const promise = (async () => {
      const r = await fetch('/api/llama/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload || {}),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`/api/llama/chat → ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalResp = { text: '', model: '' };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            if (event === 'delta' && onDelta) onDelta(obj.delta || '');
            else if (event === 'done') finalResp = obj;
            else if (event === 'error') throw new Error(obj.error || 'stream error');
          } catch (e) {
            // ignore malformed
          }
        }
      }
      return finalResp;
    })();
    return { promise, cancel: () => ctrl.abort() };
  }

  // Per-run token streaming uses a callback registry, mirroring window.bones.onToken
  const tokenListeners = new Set();
  let activeStream = null;
  let activeRunId = null;

  const bones = {
    // server lifecycle
    serverStatus: () => GET('/api/server/status'),
    serverStart: () => POST('/api/server/start', {}),
    serverLogTail: () => GET('/api/server/log').catch(() => []),
    onServerStatus: () => {}, // no live push over HTTP in v2.2.0

    // models — read-only over web for now
    modelDownload: async () => ({ error: 'Model management is only available on the host Mac.' }),
    modelDownloadSpecific: async () => ({ error: 'Model management is only available on the host Mac.' }),
    modelDelete: async () => ({ error: 'Model management is only available on the host Mac.' }),
    modelList: () => GET('/api/models').catch(() => []),
    modelHardware: () => GET('/api/models/hardware').catch(() => ({})),
    modelSetActive: async () => ({ error: 'Model management is only available on the host Mac.' }),
    modelCancel: () => ({ ok: true }),
    onModelProgress: () => {},

    // Inference (legacy/non-streaming over web)
    ping: () => POST('/api/llama/ping', {}),
    summarise: async () => ({ error: 'Work tab is only available on the host Mac.' }),
    compact: async () => ({ error: 'Work tab is only available on the host Mac.' }),
    cancelRun: (runId) => {
      if (activeStream && runId === activeRunId) {
        activeStream.cancel();
      }
      return { ok: true };
    },
    onToken: (cb) => tokenListeners.add(cb),

    // Ingest — not over web in v2.2.0
    ingestPaths: async () => ({ files: [], skipped: [{ path: '(remote)', reason: 'ingest from host Mac only' }] }),
    pickFiles: async () => ({ files: [], skipped: [] }),
    pickFolder: async () => ({ files: [], skipped: [] }),

    // Brain
    brainList: () => GET('/api/brain'),
    brainAdd: (note) => POST('/api/brain', note),
    brainDelete: (id) => DELETE('/api/brain/' + encodeURIComponent(id)),

    // Chat
    chatList: () => GET('/api/chats'),
    chatLoad: (id) => GET('/api/chats/' + encodeURIComponent(id)),
    chatSave: (chat) => POST('/api/chats', chat),
    chatDelete: (id) => DELETE('/api/chats/' + encodeURIComponent(id)),
    chatRename: async () => ({ ok: false }), // not exposed over web in v2.2.0
    chatStream: (payload, runId) => {
      const { promise, cancel } = streamChat(payload, (delta) => {
        for (const cb of tokenListeners) cb({ runId, delta });
      });
      activeStream = { cancel };
      activeRunId = runId;
      return promise.finally(() => {
        activeStream = null;
        activeRunId = null;
      });
    },

    // Network sharing — host only
    webInfo: async () => ({ error: 'host only' }),
    webStart: async () => ({ error: 'host only' }),
    webStop: async () => ({ error: 'host only' }),
    webSetShare: async () => ({ error: 'host only' }),
    webRegenToken: async () => ({ error: 'host only' }),
  };

  window.bones = bones;
})();
