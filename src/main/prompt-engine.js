// Research-prompt engineer.
//
// Turns a one-line research question from the user into a fully-structured
// prompt suitable for sending to a frontier model. Runs locally on the on-
// device model (Saul / Qwen / whichever is active) — so the prompt-design
// step is private and fast, with Claude only getting the polished prompt.
//
// Output is a single prompt string. The renderer presents it to the user for
// review/edit before sending.

const llama = require('./llama');

const SYSTEM = 'You are a research-prompt engineer. The user has stated a research question. '
  + 'Turn it into a complete, well-structured prompt that a frontier AI assistant should use to '
  + 'produce a thorough research brief. The prompt should:\n'
  + '- Re-state the question in precise terms.\n'
  + '- Specify a sectioned structure for the output (with markdown ## headings).\n'
  + '- Require concrete citations to named sources, statutes, cases, or other authority where applicable.\n'
  + '- Forbid speculation beyond the evidence and forbid generic background filler.\n'
  + '- Ask the assistant to flag areas where the law/data/evidence is unclear or evolving.\n'
  + '- Set an appropriate depth (a thorough brief, not a one-liner).\n'
  + '\n'
  + 'Output ONLY the prompt itself, ready for the user to send. No preamble, no commentary, no JSON, no quotes around it.';

function buildUser({ question, audience, jurisdiction, depth }) {
  const parts = [`Research question:\n${question.trim()}`];
  const opts = [];
  if (audience && audience.trim()) opts.push(`Target audience: ${audience.trim()}`);
  if (jurisdiction && jurisdiction.trim()) opts.push(`Jurisdiction / domain: ${jurisdiction.trim()}`);
  if (depth && depth.trim()) opts.push(`Depth: ${depth.trim()}`);
  if (opts.length) parts.push('Hints from the user:\n' + opts.map((o) => '- ' + o).join('\n'));
  return parts.join('\n\n');
}

async function engineer({ question, audience, jurisdiction, depth } = {}, { signal } = {}) {
  if (!question || !question.trim()) return { error: 'No research question.' };
  const user = buildUser({ question, audience, jurisdiction, depth });
  try {
    const text = await llama.complete({
      system: SYSTEM,
      user,
      temperature: 0.4,
      signal,
    });
    return { prompt: text.trim() };
  } catch (e) {
    if (e.name === 'AbortError') return { cancelled: true };
    return { error: e.message };
  }
}

module.exports = { engineer };
