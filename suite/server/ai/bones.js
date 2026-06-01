// The BonesAI engine — the cross-cutting AI layer the whole suite calls.
//
// It bundles two halves:
//   - redact.js   : local de-identification (privilege protection)
//   - claude.js   : the network-reaching model
//
// The defining feature carried over from BonesAI: when `protect` is on, the
// material is de-identified BEFORE it goes to the model, and the model's reply
// is re-identified locally afterwards. Real client/party names never leave the
// building. The replacement map stays server-side and is never persisted.

const claude = require('./claude');
const { redact, reidentify } = require('./redact');

// Pull the people/company names already known for a matter so they redact
// reliably (clients, opposing parties) even without a Mr/Ltd cue.
function knownEntities(matter, client) {
  const people = [];
  const companies = [];
  if (client) (client.type === 'organization' ? companies : people).push(client.name);
  for (const p of (matter?.parties || [])) {
    (p.type === 'organization' ? companies : people).push(p.name);
  }
  if (matter?.responsibleAttorney) people.push(matter.responsibleAttorney);
  return {
    people: people.filter(Boolean),
    companies: companies.filter(Boolean),
  };
}

// Non-streaming completion with optional redaction round-trip.
async function protectedComplete({ system, userText, model, maxTokens, temperature, protect, entities }, signal) {
  let outbound = userText;
  let replacements = [];
  if (protect) {
    const r = redact(userText, entities || {});
    outbound = r.text;
    replacements = r.replacements;
  }
  const res = await claude.complete({
    system,
    messages: [{ role: 'user', content: outbound }],
    model, maxTokens, temperature,
  }, signal);
  const text = protect ? reidentify(res.text, replacements) : res.text;
  return { text, model: res.model, redactionCount: replacements.length };
}

module.exports = {
  redact, reidentify, knownEntities, protectedComplete,
  available: claude.available,
  stream: claude.stream,
  complete: claude.complete,
  parseJsonBlock: claude.parseJsonBlock,
  MODELS: claude.MODELS,
};
