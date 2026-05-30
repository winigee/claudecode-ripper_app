// CLEAN — de-identification of material before it leaves the Mac.
//
// The goal is a version of the loaded documents safe to send to a public LLM:
// names of people and companies, plus addresses and other obvious personal
// identifiers, are replaced with consistent placeholders.
//
// Two passes:
//   1. Deterministic regex pass — emails, phone numbers, street addresses,
//      PO boxes, UK postcodes, companies with a legal suffix (Ltd/Inc/LLC…),
//      and people introduced by a title (Mr/Dr/Ms…). Fast, predictable.
//   2. Optional local-model pass — the on-device private model lists the plain
//      names of people and companies that the regexes can't reliably catch.
//      Because this runs locally, the raw text never leaves the machine to do
//      it. Those names are then redacted by literal replacement.
//
// Placeholders are consistent: the same entity always maps to the same token
// ([PERSON_1], [COMPANY_2], …) so the de-identified text still reads coherently
// and a downstream LLM can follow who's who.

const llama = require('./llama');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Assigns and remembers placeholders so repeats collapse to one token.
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
  // Emails
  { type: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // PO boxes
  { type: 'ADDRESS', re: /\bP\.?\s?O\.?\s?Box\s+\d+\b/gi },
  // Street addresses: number + 1-4 words + street type
  {
    type: 'ADDRESS',
    re: /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][A-Za-z'.-]+\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Square|Sq|Close|Crescent|Cres|Parade|Row|Walk|Highway|Hwy)\b\.?/g,
  },
  // UK postcodes (distinctive enough to match safely)
  { type: 'POSTCODE', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g },
  // Companies with a legal / corporate suffix
  {
    type: 'COMPANY',
    re: /\b(?:[A-Z][A-Za-z&'.-]+\s+){1,4}(?:Inc|Incorporated|Ltd|Limited|LLC|L\.L\.C|LLP|PLC|Plc|Corp|Corporation|Company|Co|GmbH|AG|S\.A|B\.V|N\.V|Pty|Group|Holdings|Partners|Associates|Solutions|Technologies|Systems|Industries|Enterprises)\b\.?/g,
  },
  // People introduced by a title
  {
    type: 'PERSON',
    re: /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Professor|Sir|Dame|Lord|Lady|Rev|Hon|Capt|Col|Sgt|Lt|Judge|Justice)\.?\s+(?:[A-Z][A-Za-z'’-]+\.?\s*){1,3}/g,
  },
];

// Phone numbers need digit-count validation, so handled separately.
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;

function redactPhones(text, R) {
  return text.replace(PHONE_CANDIDATE, (m) => {
    const digits = (m.match(/\d/g) || []).length;
    if (digits < 7 || digits > 15) return m; // not a phone-shaped number
    return R.placeholderFor('PHONE', m);
  });
}

// Replace a list of literal entity strings (from the model) with placeholders.
function redactLiterals(text, names, type, R) {
  // Longer names first so "Acme Global Ltd" wins over "Acme".
  const sorted = Array.from(new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2)))
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'gi');
    text = text.replace(re, () => R.placeholderFor(type, name));
  }
  return text;
}

function redact(text, { extraPeople = [], extraCompanies = [] } = {}) {
  const R = makeRedactor();
  let out = text;

  // Literal model-found entities first (longest, most specific), so a full
  // company name isn't broken up by the suffix regex.
  out = redactLiterals(out, extraCompanies, 'COMPANY', R);
  out = redactLiterals(out, extraPeople, 'PERSON', R);

  out = redactPhones(out, R);
  for (const { type, re } of PATTERNS) {
    out = out.replace(re, (m) => R.placeholderFor(type, m));
  }

  // Summarise per type.
  const counts = {};
  for (const e of R.log) counts[e.type] = (counts[e.type] || 0) + 1;

  return {
    text: out,
    counts,
    replacements: R.log, // {type, placeholder, original} — stays local
    total: R.log.length,
  };
}

// --- Local-model named-entity pass ---

function chunk(text, size, maxChunks) {
  const out = [];
  for (let i = 0; i < text.length && out.length < maxChunks; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

function parseEntities(modelText) {
  const start = modelText.indexOf('{');
  const end = modelText.lastIndexOf('}');
  if (start < 0 || end <= start) return { people: [], companies: [] };
  try {
    const obj = JSON.parse(modelText.slice(start, end + 1));
    const clean = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((s) => String(s).trim())
        .filter((s) => s.length >= 2 && s.length <= 60);
    return { people: clean(obj.people), companies: clean(obj.companies) };
  } catch (_) {
    return { people: [], companies: [] };
  }
}

const NER_SYSTEM =
  'You extract named entities for local redaction, running privately on the user\'s machine. '
  + 'From the text, list the full names of real people and the names of companies or organisations that appear. '
  + 'Output ONLY JSON of the form {"people":["..."],"companies":["..."]}. '
  + 'Include every distinct name once. Do NOT include job titles, generic role words, place names, dates, or product names unless the product name is also the company.';

async function findEntitiesWithModel(text, signal, onProgress) {
  // Cap work so a huge folder doesn't trigger dozens of slow local calls.
  const pieces = chunk(text, 6000, 3);
  const people = new Set();
  const companies = new Set();
  for (let i = 0; i < pieces.length; i++) {
    if (onProgress) onProgress({ stage: 'model', chunk: i + 1, of: pieces.length });
    let res = '';
    try {
      res = await llama.complete({ system: NER_SYSTEM, user: pieces[i], temperature: 0, signal });
    } catch (_) {
      continue;
    }
    const ents = parseEntities(res);
    for (const p of ents.people) people.add(p);
    for (const c of ents.companies) companies.add(c);
  }
  return {
    people: Array.from(people),
    companies: Array.from(companies),
    truncated: text.length > 6000 * 3,
  };
}

async function clean(text, { useModel = true } = {}, { onProgress, signal } = {}) {
  const report = (stage, extra) => { if (onProgress) onProgress({ stage, ...extra }); };
  let extraPeople = [];
  let extraCompanies = [];
  let truncated = false;
  if (useModel && text && text.trim()) {
    const ents = await findEntitiesWithModel(text, signal, onProgress);
    extraPeople = ents.people;
    extraCompanies = ents.companies;
    truncated = ents.truncated;
  }
  report('redacting');
  const r = redact(text || '', { extraPeople, extraCompanies });
  report('done', { counts: r.counts, total: r.total });
  return { ...r, modelUsed: useModel, truncated };
}

module.exports = { redact, clean, findEntitiesWithModel, parseEntities };
