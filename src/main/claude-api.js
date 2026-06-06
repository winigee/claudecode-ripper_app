// The "cannon" — sends de-identified material to the Anthropic API.
//
// This is the one feature in BonesAI that deliberately reaches the network. It
// only fires when the user clicks Send, and it sends the *cleaned* material
// (after CLEAN) plus the user's chosen prompt. The API key is stored locally in
// config.json (mode 0600) and never logged.

const config = require('./config');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

const CANNON_SYSTEM =
  'You are assisting with analysis of de-identified material. Names of people, '
  + 'companies, and addresses have been replaced with placeholders such as '
  + '[PERSON_1], [COMPANY_2], [ADDRESS_1], [EMAIL_1], [PHONE_1], [POSTCODE_1]. '
  + 'Each placeholder is a consistent stand-in for one real entity throughout the '
  + 'material. When you refer to one of these entities in your response, write the '
  + 'placeholder VERBATIM and unchanged, including the square brackets and the '
  + 'number — do not rename, paraphrase, summarise, or invent new placeholders, '
  + 'and do not drop the brackets. Follow the user\'s instructions exactly.';

function getApiConfig() {
  const cfg = config.readConfig();
  const api = cfg.api || {};
  return {
    key: api.key || '',
    model: api.model || DEFAULT_MODEL,
  };
}

function keyStatus() {
  const a = getApiConfig();
  return {
    hasKey: !!a.key,
    last4: a.key ? a.key.slice(-4) : null,
    model: a.model,
  };
}

function setKey(key) {
  const cfg = config.readConfig();
  cfg.api = { ...(cfg.api || {}), key: (key || '').trim() };
  config.writeConfig(cfg);
  return keyStatus();
}

function setModel(model) {
  const cfg = config.readConfig();
  cfg.api = { ...(cfg.api || {}), model: model || DEFAULT_MODEL };
  config.writeConfig(cfg);
  return keyStatus();
}

function buildUserContent(prompt, material) {
  const parts = [];
  if (prompt && prompt.trim()) parts.push(prompt.trim());
  if (material && material.trim()) {
    parts.push('\n\n--- MATERIAL (de-identified) ---\n' + material.trim());
  }
  return parts.join('');
}

// Streams the response. Calls onToken(text) for each text delta, returns the
// full text. Parses the Anthropic SSE stream (content_block_delta events).
//
// Two input shapes:
//   - { prompt, material } — single-shot (cannon / Brain research). The
//     material is appended below the prompt as one user message.
//   - { messages: [{role, content}, ...] } — multi-turn (Ask Claude from
//     chat). Messages are sent to the API directly.
async function send({ prompt, material, model, system, messages }, { onToken, signal } = {}) {
  const a = getApiConfig();
  if (!a.key) {
    const e = new Error('No Anthropic API key set. Add one in Settings → Claude API.');
    e.code = 'NO_KEY';
    throw e;
  }

  const body = {
    model: model || a.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: system || CANNON_SYSTEM,
    messages: messages && messages.length
      ? messages
      : [{ role: 'user', content: buildUserContent(prompt, material) }],
  };

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': a.key,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const j = await resp.json();
      detail = j && j.error && j.error.message ? j.error.message : JSON.stringify(j);
    } catch (_) {
      detail = await resp.text().catch(() => '');
    }
    throw new Error(`Anthropic API ${resp.status}: ${String(detail).slice(0, 300)}`);
  }

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
        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          full += evt.delta.text;
          if (onToken) onToken(evt.delta.text);
        } else if (evt.type === 'error') {
          throw new Error(evt.error && evt.error.message ? evt.error.message : 'stream error');
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // partial/ping line
        throw e;
      }
    }
  }

  return { text: full, model: body.model };
}

module.exports = { send, keyStatus, setKey, setModel, DEFAULT_MODEL };
