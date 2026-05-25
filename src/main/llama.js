const llamaServer = require('./llama-server');

const SUMMARY_SYSTEM = `You are BonesAI, a careful research assistant running locally on the user's Mac.

When summarising documents, produce a structured summary using these exact section headings, in this order:

## Purpose
One or two sentences on what the document is and why it exists.

## Key facts
Bullet list of concrete factual claims, figures, dates, parties, decisions. Be specific. No filler.

## Open questions
Bullet list of what is unresolved, ambiguous, or worth checking. If nothing is open, write "None."

Rules:
- Do not invent facts that are not in the document.
- If the document is unclear or contradicts itself, say so under Open questions.
- Keep the summary tight. No preamble, no closing remarks, no praise for the document.
- Use plain text. No emoji.`;

const COMPACT_SYSTEM = `You are BonesAI in compact mode, running locally. Your job is to compress long content so it can be passed onward as context to another step, without losing any load-bearing detail.

Rules:
- Preserve every concrete fact, figure, date, name, citation, and decision.
- Drop framing, transitions, rhetorical flourishes, and repetition.
- Output a dense but readable digest — paragraphs or bullets as appropriate.
- Aim to cut length roughly in half. Never invent or extrapolate.
- No preamble. Start straight into the compacted content.`;

const MAX_INPUT_CHARS = 24_000;

function buildDocumentBlock(files) {
  const parts = [];
  for (const f of files) {
    parts.push(`--- BEGIN FILE: ${f.name || f.path} ---\n${f.text}\n--- END FILE: ${f.name || f.path} ---`);
  }
  return parts.join('\n\n');
}

function clipForContext(text) {
  if (text.length <= MAX_INPUT_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_INPUT_CHARS) + '\n\n[...content truncated to fit local model context...]',
    truncated: true,
  };
}

async function chatStream({ system, user, onToken, signal }) {
  const port = llamaServer.getPort();
  if (!port) throw new Error('llama-server is not running.');

  const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      stream: true,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`llama-server ${resp.status}: ${body.slice(0, 200)}`);
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
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onToken) onToken(delta);
        }
      } catch (_) {
        // ignore malformed chunks
      }
    }
  }

  return full;
}

async function summarise({ files, instructions }, { onToken, signal } = {}) {
  const docs = buildDocumentBlock(files);
  const { text: clipped, truncated } = clipForContext(docs);
  const userParts = [];
  if (instructions && instructions.trim()) {
    userParts.push(`Additional instructions from the user:\n${instructions.trim()}`);
  }
  userParts.push(`Documents to summarise:\n\n${clipped}`);
  const text = await chatStream({
    system: SUMMARY_SYSTEM,
    user: userParts.join('\n\n'),
    onToken,
    signal,
  });
  return { text, truncated, model: 'qwen2.5-7b-instruct-q4_k_m' };
}

async function compact({ content, instructions }, { onToken, signal } = {}) {
  const { text: clipped, truncated } = clipForContext(content);
  const userParts = [];
  if (instructions && instructions.trim()) {
    userParts.push(`Additional instructions:\n${instructions.trim()}`);
  }
  userParts.push(`Content to compact:\n\n${clipped}`);
  const text = await chatStream({
    system: COMPACT_SYSTEM,
    user: userParts.join('\n\n'),
    onToken,
    signal,
  });
  return { text, truncated, model: 'qwen2.5-7b-instruct-q4_k_m' };
}

const CHAT_SYSTEM = `You are BonesAI, a helpful assistant running locally on the user's Mac. Be concise, accurate, and direct. If you don't know something, say so. Do not pretend to have access to information you don't have. Today's conversation is private to this user — nothing leaves the machine.`;

async function chat({ messages }, { onToken, signal } = {}) {
  const port = llamaServer.getPort();
  if (!port) throw new Error('llama-server is not running.');

  const wireMessages = [{ role: 'system', content: CHAT_SYSTEM }, ...messages];

  const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      stream: true,
      temperature: 0.7,
      messages: wireMessages,
    }),
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`llama-server ${resp.status}: ${body.slice(0, 200)}`);
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
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onToken) onToken(delta);
        }
      } catch (_) {}
    }
  }

  return { text: full, model: 'qwen2.5-7b-instruct-q4_k_m' };
}

async function ping() {
  const text = await chatStream({
    system: 'You are a test endpoint. Reply with the single word: pong',
    user: 'ping',
  });
  return { ok: true, text: text.trim().slice(0, 50), model: 'qwen2.5-7b-instruct-q4_k_m' };
}

module.exports = { summarise, compact, chat, ping };
