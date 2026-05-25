const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

function client() {
  const apiKey = config.getApiKey();
  if (!apiKey) {
    const err = new Error('No Anthropic API key. Set ANTHROPIC_API_KEY or add one in Settings.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return new Anthropic({ apiKey });
}

async function ping() {
  const c = client();
  const resp = await c.messages.create({
    model: config.getModel(),
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  const text = resp.content.find((b) => b.type === 'text');
  return { ok: true, model: resp.model, text: text ? text.text : '' };
}

const SUMMARY_SYSTEM = `You are BonesAI, a research assistant.

When summarising documents, produce a structured summary with these exact section headings, in this order:

## Purpose
One or two sentences on what the document is and why it exists.

## Key facts
Bullet list of the concrete factual claims, figures, dates, parties, decisions. Be specific. No filler.

## Open questions
Bullet list of what is unresolved, ambiguous, or worth checking. If nothing is open, write "None."

Keep the summary tight. No preamble, no closing remarks, no praise for the document. Use plain text — no emoji.`;

const COMPACT_SYSTEM = `You are BonesAI in compact mode. Your job is to compress long content so it can be passed onward as context to another step, without losing any load-bearing detail.

Rules:
- Preserve every concrete fact, figure, date, name, citation, and decision.
- Drop framing, transitions, rhetorical flourishes, and repetition.
- Output a dense but readable digest — paragraphs or bullets as appropriate.
- Aim to cut length roughly in half. Never invent or extrapolate.
- No preamble. Start straight into the compacted content.`;

function buildDocumentBlock(files) {
  const parts = [];
  for (const f of files) {
    parts.push(`--- BEGIN FILE: ${f.name || f.path} ---\n${f.text}\n--- END FILE: ${f.name || f.path} ---`);
  }
  return parts.join('\n\n');
}

async function summarise({ files, instructions }) {
  const c = client();
  const docs = buildDocumentBlock(files);
  const userParts = [];
  if (instructions && instructions.trim()) {
    userParts.push(`Additional instructions from the user:\n${instructions.trim()}`);
  }
  userParts.push(`Documents to summarise:\n\n${docs}`);
  const resp = await c.messages.create({
    model: config.getModel(),
    max_tokens: 16000,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: userParts.join('\n\n') }],
  });
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model: resp.model, usage: resp.usage };
}

async function compact({ content, instructions }) {
  const c = client();
  const userParts = [];
  if (instructions && instructions.trim()) {
    userParts.push(`Additional instructions:\n${instructions.trim()}`);
  }
  userParts.push(`Content to compact:\n\n${content}`);
  const resp = await c.messages.create({
    model: config.getModel(),
    max_tokens: 16000,
    system: COMPACT_SYSTEM,
    messages: [{ role: 'user', content: userParts.join('\n\n') }],
  });
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model: resp.model, usage: resp.usage };
}

module.exports = { ping, summarise, compact };
