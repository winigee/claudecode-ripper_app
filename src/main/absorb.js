// Absorb — turn an uploaded document into Memory entries.
//
// The local model reads the document and proposes a list of discrete,
// load-bearing facts/principles/definitions. The user reviews the list and
// ticks which ones to keep; ticked items land in the shared Memory store
// with the source filename attached, so every future chat — with any local
// model — has them in context.
//
// This is the "Absorb" feature: from the user's point of view, Bones learns
// the document. Under the hood we're not fine-tuning anything (which wouldn't
// run on the user's Intel Mac anyway) — we're extracting structured knowledge
// and adding it to a persistent context layer the model already reads from.

const llama = require('./llama');

const SYSTEM = 'You extract knowledge for a personal research assistant, running locally on the user\'s Mac. '
  + 'Given a document, list the load-bearing facts, definitions, decisions, principles, and standing positions '
  + 'stated in it. Each item must be:\n'
  + '- A single complete sentence, useful in isolation (no "as stated above"-style references)\n'
  + '- Specific — preserve names, figures, dates, citations\n'
  + '- Verbatim or close paraphrase — do not infer, extrapolate, or add commentary\n'
  + '- Concrete, not vague background\n'
  + '\n'
  + 'Output ONLY a JSON array of strings, like ["fact 1", "fact 2"]. No prose before or after, no numbering, no markdown.';

const CHUNK_SIZE = 6000;
const MAX_CHUNKS = 5; // hard cap on local-model calls per absorb run

function chunkText(text) {
  const out = [];
  const trimmed = String(text || '').trim();
  if (!trimmed) return out;
  if (trimmed.length <= CHUNK_SIZE) return [trimmed];
  // Split on paragraph boundaries when possible, fall back to hard slices.
  const paras = trimmed.split(/\n\s*\n/);
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > CHUNK_SIZE) {
      if (cur) out.push(cur);
      if (p.length > CHUNK_SIZE) {
        // Single para too long — hard slice it.
        for (let i = 0; i < p.length && out.length < MAX_CHUNKS; i += CHUNK_SIZE) {
          out.push(p.slice(i, i + CHUNK_SIZE));
        }
        cur = '';
      } else {
        cur = p;
      }
    } else {
      cur = cur ? cur + '\n\n' + p : p;
    }
    if (out.length >= MAX_CHUNKS) break;
  }
  if (cur && out.length < MAX_CHUNKS) out.push(cur);
  return out.slice(0, MAX_CHUNKS);
}

function parseFacts(modelOutput) {
  const out = [];
  const start = modelOutput.indexOf('[');
  const end = modelOutput.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(modelOutput.slice(start, end + 1));
      for (const item of arr) {
        const s = String(item || '').trim();
        if (s.length >= 8 && s.length <= 500) out.push(s);
      }
      return out;
    } catch (_) { /* fall through to line-mode */ }
  }
  // Fallback: model returned plain lines or bullets — best effort recovery.
  for (const raw of modelOutput.split('\n')) {
    const s = raw.replace(/^[\s\-*\d.)]+/, '').trim().replace(/^"|"$/g, '');
    if (s.length >= 8 && s.length <= 500 && /[a-zA-Z]/.test(s)) out.push(s);
  }
  return out;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const s of items) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < 8) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

async function absorbDocument({ name, text }, { onProgress, signal } = {}) {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return { name, facts: [], truncated: false, note: 'Document was empty.' };
  }
  const truncated = (text || '').length > CHUNK_SIZE * MAX_CHUNKS;
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ stage: 'extracting', file: name, chunk: i + 1, of: chunks.length });
    let raw = '';
    try {
      raw = await llama.complete({
        system: SYSTEM,
        user: chunks[i],
        temperature: 0.2,
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // Skip the chunk on transient errors rather than failing the whole run.
      continue;
    }
    for (const f of parseFacts(raw)) all.push(f);
  }
  return { name, facts: dedupe(all), truncated };
}

// Multi-file absorb. Returns one bundle per file so the renderer can show
// them grouped under their source for review.
async function absorbFiles(files, { onProgress, signal } = {}) {
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress({ stage: 'file', file: f.name || f.path, index: i + 1, of: files.length });
    const r = await absorbDocument({ name: f.name || f.path, text: f.text || '' }, { onProgress, signal });
    results.push(r);
  }
  if (onProgress) onProgress({ stage: 'done', total: results.reduce((n, r) => n + r.facts.length, 0) });
  return { documents: results };
}

module.exports = { absorbDocument, absorbFiles, parseFacts, chunkText };
