// Anthropic API client — the network-reaching half of the BonesAI engine.
// Reads the key from ANTHROPIC_API_KEY (or PRAXIS_ANTHROPIC_KEY). When no key
// is configured, callers fall back to deterministic stubs so the prototype is
// fully demonstrable offline — see ai/agents.js.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const MODELS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};
const DEFAULT_MODEL = MODELS.sonnet;

function apiKey() {
  return (process.env.ANTHROPIC_API_KEY || process.env.PRAXIS_ANTHROPIC_KEY || '').trim();
}
function available() {
  return !!apiKey();
}
function resolveModel(m) {
  if (!m) return DEFAULT_MODEL;
  return MODELS[m] || m;
}

async function request(body, signal) {
  const key = apiKey();
  if (!key) {
    const e = new Error('No Anthropic API key set (ANTHROPIC_API_KEY).');
    e.code = 'NO_KEY';
    throw e;
  }
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j?.error?.message || JSON.stringify(j); }
    catch (_) { detail = await resp.text().catch(() => ''); }
    throw new Error(`Anthropic API ${resp.status}: ${String(detail).slice(0, 300)}`);
  }
  return resp;
}

// Non-streaming completion. Returns the full text.
async function complete({ system, messages, model, maxTokens = 4096, temperature } = {}, signal) {
  const body = {
    model: resolveModel(model),
    max_tokens: maxTokens,
    messages: messages || [],
  };
  if (system) body.system = system;
  if (typeof temperature === 'number') body.temperature = temperature;
  const resp = await request(body, signal);
  const json = await resp.json();
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, model: body.model, usage: json.usage || null };
}

// Streaming completion. Calls onToken(textDelta) per chunk; returns full text.
async function stream({ system, messages, model, maxTokens = 4096, temperature } = {}, { onToken, signal } = {}) {
  const body = {
    model: resolveModel(model),
    max_tokens: maxTokens,
    stream: true,
    messages: messages || [],
  };
  if (system) body.system = system;
  if (typeof temperature === 'number') body.temperature = temperature;
  const resp = await request(body, signal);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          full += evt.delta.text;
          if (onToken) onToken(evt.delta.text);
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message || 'stream error');
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return { text: full, model: body.model };
}

// Convenience: ask for JSON, parse the first {...} or [...] block out of the reply.
function parseJsonBlock(text) {
  if (!text) return null;
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1, openCh = '{', closeCh = '}';
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) { start = arrStart; openCh = '['; closeCh = ']'; }
  else start = objStart;
  if (start < 0) return null;
  const end = text.lastIndexOf(closeCh);
  if (end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (_) { return null; }
}

module.exports = { complete, stream, available, parseJsonBlock, MODELS, DEFAULT_MODEL, resolveModel };
