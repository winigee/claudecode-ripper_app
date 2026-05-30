// Structured document search for BonesAI.
//
// Lets the user point Bones at a folder of already-ingested documents and ask
// "find the ones about X" — including documents that are *similar in meaning*
// but don't use the same words.
//
// The Mac runs a generative model (no embedding model on hand), so instead of
// vector search we use a three-stage local pipeline:
//
//   1. Query expansion — ask the local model for related terms / phrasings so
//      we can catch documents that mean the same thing with different words.
//   2. Lexical ranking — chunk each document and score chunks against the
//      original query terms (full weight) plus the expanded terms (half
//      weight), with phrase-match and term-coverage bonuses. Cheap, runs over
//      every document, narrows hundreds of files to a handful of candidates.
//   3. Relevance judging — hand the top candidate snippets to the model and ask
//      it to rate each document's relevance to the *intent* of the query
//      (strong / possible / weak / none) with a one-line reason.
//
// Everything runs on-device. No network calls.

const llama = require('./llama');

const STOPWORDS = new Set(
  ('a an the and or but if then else of to in on at by for from with without into onto '
    + 'is are was were be been being am do does did doing have has had having this that these '
    + 'those it its they them their there here what which who whom whose when where why how '
    + 'as not no nor so than too very can will just should now about above below over under '
    + 'again further once all any both each few more most other some such only own same i you '
    + 'we he she my your our his her also out up down off between within across per via').split(/\s+/)
);

function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Distinct, meaningful terms from the user's query.
function queryTerms(query) {
  const toks = tokenize(query).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return Array.from(new Set(toks));
}

// Overlapping character windows so a match near a chunk boundary still scores.
function chunkText(text, size = 1200, overlap = 200, maxChunks = 40) {
  const chunks = [];
  if (!text) return chunks;
  let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    chunks.push({ start: i, text: text.slice(i, i + size) });
    if (i + size >= text.length) break;
    i += size - overlap;
  }
  return chunks;
}

// Score one chunk against the weighted term set.
// weighted = Map(term -> weight). Original query terms weigh 1, expanded 0.5.
function scoreChunk(chunkText, weighted, originalTerms, fullQueryLower) {
  const lower = chunkText.toLowerCase();
  const toks = tokenize(lower);
  if (toks.length === 0) return { score: 0, matched: new Set() };

  const freq = new Map();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);

  let score = 0;
  const matched = new Set();
  for (const [term, weight] of weighted) {
    const f = freq.get(term);
    if (f) {
      // Diminishing returns past a few occurrences so one spammy doc can't win.
      score += weight * (1 + Math.log(Math.min(f, 5)));
      matched.add(term);
    }
  }

  // Coverage bonus: reward chunks that hit many *distinct* original terms.
  const origMatched = originalTerms.filter((t) => matched.has(t)).length;
  if (originalTerms.length > 0) {
    score += 2.0 * (origMatched / originalTerms.length);
  }

  // Exact phrase bonus: the user's literal query appears in the chunk.
  if (fullQueryLower && fullQueryLower.length >= 4 && lower.includes(fullQueryLower)) {
    score += 4.0;
  }

  return { score, matched };
}

// Build a short, readable snippet centred on the first matched term.
function makeSnippet(chunkText, matched, maxLen = 320) {
  const lower = chunkText.toLowerCase();
  let pos = -1;
  for (const term of matched) {
    const i = lower.indexOf(term);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0;
  let start = Math.max(0, pos - 80);
  let end = Math.min(chunkText.length, start + maxLen);
  let snip = chunkText.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < chunkText.length) snip = snip + '…';
  return snip;
}

async function expandQuery(query, signal) {
  const system = 'You expand search queries for a local document search tool. '
    + 'Given a query, list words and short phrases that documents about the same topic might use instead — '
    + 'synonyms, related terms, alternative phrasings. Output ONLY a comma-separated list, no explanation, no numbering. Keep it under 20 items.';
  const user = `Query: ${query}`;
  let text = '';
  try {
    text = await llama.complete({ system, user, temperature: 0.3, signal });
  } catch (_) {
    return [];
  }
  // Parse the comma/newline separated list into clean single-or-two word terms.
  const raw = text.split(/[,\n;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const terms = new Set();
  for (const phrase of raw) {
    const cleaned = phrase.replace(/^[-*\d.\)\s]+/, '').trim();
    if (!cleaned || cleaned.length > 40) continue;
    // Keep multi-word phrases whole; also fold in their individual tokens.
    const toks = tokenize(cleaned).filter((t) => t.length > 1 && !STOPWORDS.has(t));
    for (const t of toks) terms.add(t);
  }
  return Array.from(terms);
}

// Ask the model to judge the top candidates. Returns Map(index -> {relevance, reason}).
async function judgeRelevance(query, candidates, signal) {
  const RANK = { strong: 3, possible: 2, weak: 1, none: 0 };
  const blocks = candidates.map((c, i) =>
    `[${i + 1}] FILE: ${c.name}\nEXCERPT: ${c.snippet}`
  ).join('\n\n');

  const system = 'You judge whether documents are relevant to a search query, running locally. '
    + 'Consider the meaning and intent of the query, not just shared keywords. '
    + 'For each candidate respond with its relevance: "strong", "possible", "weak", or "none". '
    + 'Respond with ONLY a JSON array like '
    + '[{"id":1,"relevance":"strong","reason":"<max 10 words>"}]. No prose before or after.';
  const user = `Query: "${query}"\n\nCandidates:\n${blocks}`;

  let text = '';
  try {
    text = await llama.complete({ system, user, temperature: 0.1, signal });
  } catch (_) {
    return new Map();
  }

  const out = new Map();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1));
      for (const item of arr) {
        const idx = Number(item.id) - 1;
        const rel = String(item.relevance || '').toLowerCase();
        if (idx >= 0 && idx < candidates.length && rel in RANK) {
          out.set(idx, { relevance: rel, rank: RANK[rel], reason: String(item.reason || '').slice(0, 80) });
        }
      }
    } catch (_) {
      // Model didn't return clean JSON — fall through to lexical-only ordering.
    }
  }
  return out;
}

// Main entry. files: [{ name, path, text }]. Returns ranked results.
async function search({ files, query, expand = true, maxResults = 12 }, { onProgress, signal } = {}) {
  const report = (stage, extra) => { if (onProgress) onProgress({ stage, ...extra }); };

  const original = queryTerms(query);
  if (original.length === 0) {
    return { query, results: [], expandedTerms: [], note: 'Enter at least one meaningful search word.' };
  }

  // Stage 1: expansion (optional).
  let expanded = [];
  if (expand) {
    report('expanding');
    expanded = (await expandQuery(query, signal)).filter((t) => !original.includes(t));
  }

  const weighted = new Map();
  for (const t of original) weighted.set(t, 1.0);
  for (const t of expanded) if (!weighted.has(t)) weighted.set(t, 0.5);
  const fullQueryLower = query.trim().toLowerCase();

  // Stage 2: lexical ranking over every document.
  report('scanning', { total: files.length });
  const scored = [];
  for (const f of files) {
    const chunks = chunkText(f.text || '');
    let best = { score: 0, matched: new Set(), text: '' };
    let matchingChunks = 0;
    for (const ch of chunks) {
      const r = scoreChunk(ch.text, weighted, original, fullQueryLower);
      if (r.score > 0) matchingChunks++;
      if (r.score > best.score) best = { score: r.score, matched: r.matched, text: ch.text };
    }
    if (best.score > 0) {
      // Small bonus for the topic recurring across the document.
      const docScore = best.score + Math.min(matchingChunks - 1, 4) * 0.25;
      scored.push({
        name: f.name || f.path,
        path: f.path,
        lexScore: docScore,
        matched: Array.from(best.matched),
        snippet: makeSnippet(best.text, best.matched),
      });
    }
  }

  scored.sort((a, b) => b.lexScore - a.lexScore);

  if (scored.length === 0) {
    return {
      query,
      expandedTerms: expanded,
      results: [],
      note: 'No documents matched, even after expanding the query. Try different words.',
    };
  }

  // Stage 3: model relevance judging on the top candidates only.
  const candidates = scored.slice(0, maxResults);
  report('judging', { count: candidates.length });
  const judged = await judgeRelevance(query, candidates, signal);

  for (let i = 0; i < candidates.length; i++) {
    const j = judged.get(i);
    if (j) {
      candidates[i].relevance = j.relevance;
      candidates[i].rank = j.rank;
      candidates[i].reason = j.reason;
    } else {
      // No verdict from the model — keep it, ranked by lexical signal only.
      candidates[i].relevance = 'possible';
      candidates[i].rank = 2;
      candidates[i].reason = '';
    }
  }

  // Final order: model relevance first, lexical score as tiebreak.
  // Drop documents the model explicitly called "none".
  const results = candidates
    .filter((c) => c.relevance !== 'none')
    .sort((a, b) => (b.rank - a.rank) || (b.lexScore - a.lexScore));

  report('done', { results: results.length });
  return { query, expandedTerms: expanded, results, scanned: files.length };
}

module.exports = { search, queryTerms, chunkText, scoreChunk, expandQuery };
