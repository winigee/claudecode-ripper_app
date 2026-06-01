// BonesAI redaction — de-identification of privileged material before it
// leaves the building for a public LLM. Adapted from BonesAI's redact.js,
// regex-only (no local model dependency in the web server). People, orgs,
// addresses and obvious identifiers collapse to consistent placeholders
// ([PERSON_1], [COMPANY_2], …) so the text still reads coherently and the
// mapping can be reversed locally once the model replies.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRedactor() {
  const counters = {};
  const maps = {};
  const log = [];
  function placeholderFor(type, original) {
    const clean = original.trim();
    const key = clean.toLowerCase();
    maps[type] = maps[type] || new Map();
    if (maps[type].has(key)) return maps[type].get(key);
    counters[type] = (counters[type] || 0) + 1;
    const ph = `[${type}_${counters[type]}]`;
    maps[type].set(key, ph);
    log.push({ type, placeholder: ph, original: clean });
    return ph;
  }
  return { placeholderFor, log };
}

const PATTERNS = [
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'ADDRESS', re: /\bP\.?\s?O\.?\s?Box\s+\d+\b/gi },
  {
    type: 'ADDRESS',
    re: /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'.-]+\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Square|Sq|Close|Crescent|Cres|Parade|Row|Walk|Highway|Hwy)\b\.?/g,
  },
  { type: 'POSTCODE', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g },
  // US ZIP (5 or ZIP+4)
  { type: 'POSTCODE', re: /\b\d{5}(?:-\d{4})?\b/g },
  // SSN
  { type: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    type: 'COMPANY',
    re: /\b(?:[A-Z][A-Za-z&'.-]+\s+){1,4}(?:Inc|Incorporated|Ltd|Limited|LLC|L\.L\.C|LLP|PLC|Plc|Corp|Corporation|Company|Co|GmbH|AG|S\.A|B\.V|N\.V|Pty|Group|Holdings|Partners|Associates|Solutions|Technologies|Systems|Industries|Enterprises)\b\.?/g,
  },
  {
    type: 'PERSON',
    re: /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Lord|Lady|Rev|Hon|Capt|Col|Sgt|Lt|Judge|Justice)\.?\s+(?:[A-Z][A-Za-z'’-]+\.?\s*){1,3}/g,
  },
];

const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;

function redactPhones(text, R) {
  return text.replace(PHONE_CANDIDATE, (m) => {
    const digits = (m.match(/\d/g) || []).length;
    if (digits < 7 || digits > 15) return m;
    return R.placeholderFor('PHONE', m);
  });
}

function redactLiterals(text, names, type, R) {
  const sorted = Array.from(new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2)))
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'gi');
    text = text.replace(re, () => R.placeholderFor(type, name));
  }
  return text;
}

// names: { people:[], companies:[] } — known entities from the matter record,
// fed in so client/party names redact reliably even without a title prefix.
function redact(text, { people = [], companies = [] } = {}) {
  const R = makeRedactor();
  let out = text || '';
  out = redactLiterals(out, companies, 'COMPANY', R);
  out = redactLiterals(out, people, 'PERSON', R);
  out = redactPhones(out, R);
  for (const { type, re } of PATTERNS) out = out.replace(re, (m) => R.placeholderFor(type, m));

  const counts = {};
  for (const e of R.log) counts[e.type] = (counts[e.type] || 0) + 1;
  return { text: out, counts, replacements: R.log, total: R.log.length };
}

// Reverse the placeholders back to real names once a reply comes back.
function reidentify(text, replacements) {
  let out = text || '';
  for (const { placeholder, original } of replacements || []) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

module.exports = { redact, reidentify };
