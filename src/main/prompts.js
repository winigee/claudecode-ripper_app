// Prompt library for the Claude cannon.
//
// A prompt is { id, title, body, builtin }. Bodies may contain {{variables}};
// when the user picks such a prompt the renderer asks for each variable and
// fills it in before sending.
//
// Built-in prompts ship with the app. User prompts are stored in config.json
// under `prompts` so they persist locally.

const config = require('./config');

const BUILTINS = [
  {
    id: 'builtin-summary',
    title: 'Executive summary',
    body: 'Write a clear executive summary of the material below for {{audience}}. Focus on {{focus}}. Keep it under {{word_limit}} words. Use plain language.',
  },
  {
    id: 'builtin-actions',
    title: 'Extract action items',
    body: 'From the material below, list every action item with its owner and deadline. Where an owner or deadline is not stated, mark it as "unassigned" or "no deadline". Present as a table.',
  },
  {
    id: 'builtin-risks',
    title: 'Risks & red flags',
    body: 'Identify the key risks, liabilities, and red flags in the material below. Rank them from most to least severe and explain each in one or two sentences.',
  },
  {
    id: 'builtin-reply',
    title: 'Draft a reply',
    body: 'Draft a {{tone}} reply to the material below. The reply should {{goal}}. Keep it concise and sign off as {{sign_off}}.',
  },
  {
    id: 'builtin-explain',
    title: 'Explain simply',
    body: 'Explain the material below as if to {{level}}. Avoid jargon, define any unavoidable terms, and use short paragraphs.',
  },
  {
    id: 'builtin-compare',
    title: 'Compare the documents',
    body: 'Compare and contrast the documents in the material below. Highlight where they agree, where they contradict each other, and any gaps between them.',
  },
  {
    id: 'builtin-questions',
    title: 'Questions to ask',
    body: 'Based on the material below, list the {{count}} most important questions I should ask before {{decision}}. For each question, say briefly why it matters.',
  },
  {
    id: 'builtin-timeline',
    title: 'Build a timeline',
    body: 'Construct a chronological timeline of the events, decisions, and dates in the material below. Flag anything where the sequence is ambiguous.',
  },
];

const VAR_RE = /\{\{\s*([a-zA-Z0-9_ -]+?)\s*\}\}/g;

function extractVariables(body) {
  const seen = new Set();
  const vars = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(body || '')) !== null) {
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      vars.push(name);
    }
  }
  return vars;
}

function fillVariables(body, values = {}) {
  return (body || '').replace(VAR_RE, (_full, raw) => {
    const name = raw.trim();
    const v = values[name] != null ? values[name] : values[name.toLowerCase()];
    return v == null || v === '' ? `{{${name}}}` : String(v);
  });
}

function userPrompts() {
  const cfg = config.readConfig();
  return Array.isArray(cfg.prompts) ? cfg.prompts : [];
}

function decorate(p, builtin) {
  return { ...p, builtin, variables: extractVariables(p.body) };
}

function list() {
  const builtins = BUILTINS.map((p) => decorate(p, true));
  const users = userPrompts().map((p) => decorate(p, false));
  return [...builtins, ...users];
}

function save(prompt) {
  const cfg = config.readConfig();
  const prompts = Array.isArray(cfg.prompts) ? cfg.prompts : [];
  const id = prompt.id && prompt.id.startsWith('user-')
    ? prompt.id
    : 'user-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const record = {
    id,
    title: (prompt.title || 'Untitled prompt').slice(0, 80),
    body: prompt.body || '',
  };
  const idx = prompts.findIndex((p) => p.id === id);
  if (idx >= 0) prompts[idx] = record;
  else prompts.push(record);
  cfg.prompts = prompts;
  config.writeConfig(cfg);
  return decorate(record, false);
}

function remove(id) {
  const cfg = config.readConfig();
  const prompts = Array.isArray(cfg.prompts) ? cfg.prompts : [];
  const next = prompts.filter((p) => p.id !== id);
  cfg.prompts = next;
  config.writeConfig(cfg);
  return { ok: next.length !== prompts.length };
}

module.exports = { list, save, remove, extractVariables, fillVariables, BUILTINS };
