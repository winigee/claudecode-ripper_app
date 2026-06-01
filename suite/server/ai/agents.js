// The agentic layer. Three task agents plus the matter-aware assistant.
//
// Each agent uses the BonesAI engine (Claude, with optional redaction) when an
// API key is present, and a deterministic fallback otherwise — so every screen
// in the prototype produces a sensible result with or without a key. Each agent
// records what it did to the activity log.

const bones = require('./bones');
const db = require('../db');

const USE_AI = () => bones.available();

function fmtDate(d) {
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return String(d); }
}
function addDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Matter context — a compact brief fed to every agent so output is grounded.
// ---------------------------------------------------------------------------
function matterContext(matterId) {
  const matter = db.get('matters', matterId);
  if (!matter) return { matter: null, brief: 'No matter selected.' };
  const client = matter.clientId ? db.get('clients', matter.clientId) : null;
  const docs = db.where('documents', (d) => d.matterId === matterId);
  const events = db.where('events', (e) => e.matterId === matterId);
  const notes = db.where('notes', (n) => n.matterId === matterId);

  const lines = [
    `Matter: ${matter.title} (${matter.reference || matter.id})`,
    `Practice area: ${matter.practiceArea || 'n/a'}`,
    `Status: ${matter.status}`,
    `Responsible attorney: ${matter.responsibleAttorney || 'n/a'}`,
    client ? `Client: ${client.name} (${client.type})` : 'Client: n/a',
    matter.parties?.length ? `Other parties: ${matter.parties.map((p) => `${p.name} [${p.role}]`).join('; ')}` : null,
    matter.description ? `Description: ${matter.description}` : null,
    events.length ? `Key dates: ${events.map((e) => `${e.title} — ${fmtDate(e.dueDate)}`).join('; ')}` : null,
    notes.length ? `Notes: ${notes.map((n) => n.body).join(' | ').slice(0, 600)}` : null,
  ].filter(Boolean);

  return { matter, client, docs, events, brief: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Agent 1 — Document drafting
// ---------------------------------------------------------------------------
const DRAFT_SYSTEM =
  'You are a senior legal drafting assistant at a law firm. Produce clean, '
  + 'professional first drafts that a supervising attorney will review. Use '
  + 'clear structure and headings. Insert [BRACKETED] placeholders where a '
  + 'specific fact, figure, or citation is needed but not supplied. Never '
  + 'invent case citations or statutes. End every draft with a short '
  + '"⚠ Review notes" list of points the attorney must verify before sending.';

const DRAFT_TEMPLATES = {
  'engagement-letter': 'Client engagement / retainer letter',
  'demand-letter': 'Demand letter to an opposing party',
  'client-update': 'Status update letter to the client',
  'memo': 'Internal legal memorandum (IRAC structure)',
  'discovery-request': 'Request for production of documents',
  'settlement-proposal': 'Settlement proposal letter',
  'nda': 'Mutual non-disclosure agreement',
  'motion-outline': 'Outline of a motion with argument headings',
};

async function draftDocument({ matterId, template, instructions, protect = true }) {
  const ctx = matterContext(matterId);
  const docTypeLabel = DRAFT_TEMPLATES[template] || template || 'legal document';

  let text, usedAI = false, redactionCount = 0;
  if (USE_AI()) {
    usedAI = true;
    const entities = bones.knownEntities(ctx.matter, ctx.client);
    const userText =
      `Draft a ${docTypeLabel}.\n\n`
      + `MATTER CONTEXT:\n${ctx.brief}\n\n`
      + `INSTRUCTIONS:\n${instructions || '(none beyond the context above)'}`;
    const res = await bones.protectedComplete({
      system: DRAFT_SYSTEM, userText, protect, entities, maxTokens: 3000,
    });
    text = res.text;
    redactionCount = res.redactionCount;
  } else {
    text = stubDraft(docTypeLabel, ctx, instructions);
  }

  const doc = db.insert('documents', {
    matterId, name: `DRAFT — ${docTypeLabel}`, type: 'draft', template,
    content: text, source: 'ai-drafted', tags: ['draft', 'ai'],
  });
  db.logActivity({
    actor: 'agent:drafter', action: 'drafted-document', matterId,
    detail: `${docTypeLabel}${usedAI ? '' : ' (offline template)'}`, ref: doc.id,
  });
  return { document: doc, usedAI, redactionCount };
}

function stubDraft(docTypeLabel, ctx, instructions) {
  const m = ctx.matter;
  const client = ctx.client?.name || '[CLIENT NAME]';
  const today = fmtDate(new Date());
  return (
`${docTypeLabel.toUpperCase()}
Date: ${today}
Re: ${m ? m.title : '[MATTER]'}${m?.reference ? ` (Ref: ${m.reference})` : ''}

Dear [RECIPIENT],

[This is an offline template draft — set ANTHROPIC_API_KEY to have the BonesAI
engine generate a full, matter-aware draft.]

This ${docTypeLabel.toLowerCase()} concerns the above matter on behalf of our
client, ${client}. ${instructions ? `Per your instructions: ${instructions}` : ''}

1. [OPENING / PURPOSE]
2. [STATEMENT OF FACTS]
3. [ANALYSIS OR REQUEST]
4. [NEXT STEPS AND DEADLINE]

Yours faithfully,
${m?.responsibleAttorney || '[ATTORNEY]'}

⚠ Review notes
- Confirm recipient details and salutation.
- Verify all facts against the matter file.
- Supply any [BRACKETED] specifics before sending.`
  );
}

// ---------------------------------------------------------------------------
// Agent 2 — Deadline / docket extraction
// ---------------------------------------------------------------------------
const DOCKET_SYSTEM =
  'You are a litigation docketing clerk. From the supplied document text, '
  + 'extract every concrete date, deadline, hearing, or filing obligation. '
  + 'For relative references ("within 30 days of service"), compute the date '
  + 'from the supplied reference date if given, otherwise leave dueDate null '
  + 'and put the rule in "rationale". Respond ONLY with JSON: '
  + '{"events":[{"title":"","dueDate":"YYYY-MM-DD or null","type":"deadline|hearing|filing|task","priority":"high|normal|low","rationale":""}]}.';

async function extractDeadlines({ matterId, text, referenceDate, commit = true }) {
  let events = [], usedAI = false;
  if (USE_AI() && text && text.trim()) {
    usedAI = true;
    const res = await bones.complete({
      system: DOCKET_SYSTEM,
      messages: [{ role: 'user', content:
        `Reference date (for relative deadlines): ${referenceDate || fmtDate(new Date())}\n\n--- DOCUMENT ---\n${text.slice(0, 12000)}` }],
      temperature: 0, maxTokens: 1500,
    });
    const parsed = bones.parseJsonBlock(res.text);
    events = Array.isArray(parsed?.events) ? parsed.events : [];
  } else {
    events = stubExtractDeadlines(text, referenceDate);
  }

  // Normalise.
  events = events.map((e) => ({
    title: String(e.title || 'Untitled deadline').slice(0, 200),
    dueDate: e.dueDate || null,
    type: ['deadline', 'hearing', 'filing', 'task'].includes(e.type) ? e.type : 'deadline',
    priority: ['high', 'normal', 'low'].includes(e.priority) ? e.priority : 'normal',
    rationale: e.rationale || '',
  }));

  let committed = [];
  if (commit && matterId) {
    committed = events.map((e) => db.insert('events', {
      matterId, title: e.title, dueDate: e.dueDate, type: e.type,
      priority: e.priority, status: 'pending', source: 'agent:docket', rationale: e.rationale,
    }));
    db.logActivity({
      actor: 'agent:docket', action: 'extracted-deadlines', matterId,
      detail: `${committed.length} date(s)${usedAI ? '' : ' (offline heuristics)'}`,
    });
  }
  return { events: committed.length ? committed : events, usedAI, committed: committed.length };
}

// Offline heuristic: find explicit dates and "within N days" phrases.
function stubExtractDeadlines(text, referenceDate) {
  if (!text) return [];
  const base = referenceDate || fmtDate(new Date());
  const out = [];
  const dateRe = /\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi;
  let m;
  while ((m = dateRe.exec(text)) && out.length < 25) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ').trim();
    out.push({ title: around.slice(0, 120), dueDate: tryDate(m[1]), type: 'deadline', priority: 'normal', rationale: 'Date found in text (offline heuristic).' });
  }
  const relRe = /within\s+(\d{1,3})\s+(calendar\s+|business\s+)?days/gi;
  while ((m = relRe.exec(text)) && out.length < 25) {
    const around = text.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ').trim();
    out.push({ title: around.slice(0, 120), dueDate: addDays(base, parseInt(m[1], 10)), type: 'deadline', priority: 'high', rationale: `Computed: ${m[1]} days from ${base}.` });
  }
  return out;
}
function tryDate(s) {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Agent 3 — Intake / email triage
// ---------------------------------------------------------------------------
const TRIAGE_SYSTEM =
  'You are an intake coordinator at a law firm. Given an inbound message and a '
  + 'list of existing matters, classify it and propose next steps. Respond ONLY '
  + 'with JSON: {"category":"new-enquiry|existing-matter|spam|admin","practiceArea":"",'
  + '"summary":"one sentence","urgency":"high|normal|low","suggestedMatterId":"id or null",'
  + '"conflictFlag":true|false,"conflictNote":"","draftReply":"a short professional reply"}.';

async function triageIntake({ intakeId, protect = true }) {
  const item = db.get('intake', intakeId);
  if (!item) throw new Error('Intake item not found');
  const matters = db.all('matters').map((m) => ({
    id: m.id, title: m.title, client: db.get('clients', m.clientId)?.name, practiceArea: m.practiceArea,
  }));

  let result, usedAI = false, redactionCount = 0;
  if (USE_AI()) {
    usedAI = true;
    const entities = { people: [], companies: [] };
    const userText =
      `INBOUND MESSAGE\nFrom: ${item.from}\nSubject: ${item.subject}\n\n${item.body}\n\n`
      + `EXISTING MATTERS (for matching & conflicts):\n${JSON.stringify(matters)}`;
    // Redact the inbound body before it goes out, then work with the model's JSON.
    let outbound = userText, replacements = [];
    if (protect) { const r = bones.redact(userText, entities); outbound = r.text; replacements = r.replacements; redactionCount = r.replacements.length; }
    const res = await bones.complete({
      system: TRIAGE_SYSTEM, messages: [{ role: 'user', content: outbound }], temperature: 0, maxTokens: 1200,
    });
    const parsed = bones.parseJsonBlock(res.text) || {};
    if (parsed.draftReply && protect) parsed.draftReply = bones.reidentify(parsed.draftReply, replacements);
    if (parsed.summary && protect) parsed.summary = bones.reidentify(parsed.summary, replacements);
    result = parsed;
  } else {
    result = stubTriage(item, matters);
  }

  const triage = {
    category: result.category || 'new-enquiry',
    practiceArea: result.practiceArea || '',
    summary: result.summary || '',
    urgency: ['high', 'normal', 'low'].includes(result.urgency) ? result.urgency : 'normal',
    suggestedMatterId: result.suggestedMatterId || null,
    conflictFlag: !!result.conflictFlag,
    conflictNote: result.conflictNote || '',
    draftReply: result.draftReply || '',
  };
  db.update('intake', intakeId, { status: 'triaged', triage });
  db.logActivity({
    actor: 'agent:intake', action: 'triaged-intake', ref: intakeId,
    detail: `${triage.category} / ${triage.urgency}${triage.conflictFlag ? ' / CONFLICT FLAG' : ''}${usedAI ? '' : ' (offline)'}`,
  });
  return { triage, usedAI, redactionCount };
}

function stubTriage(item, matters) {
  const text = `${item.subject} ${item.body}`.toLowerCase();
  const urgent = /urgent|immediately|asap|deadline|today|tomorrow|served|summons/.test(text);
  const match = matters.find((m) => m.client && text.includes(m.client.toLowerCase().split(' ')[0]))
    || matters.find((m) => m.practiceArea && text.includes((m.practiceArea || '').toLowerCase()));
  return {
    category: match ? 'existing-matter' : 'new-enquiry',
    practiceArea: match?.practiceArea || (/divorce|custody/.test(text) ? 'Family' : /contract|breach/.test(text) ? 'Commercial' : /injur|accident/.test(text) ? 'Personal Injury' : ''),
    summary: `(offline) ${item.subject}`.slice(0, 140),
    urgency: urgent ? 'high' : 'normal',
    suggestedMatterId: match?.id || null,
    conflictFlag: false,
    conflictNote: '',
    draftReply:
`Dear ${item.from.split('@')[0]},

Thank you for contacting the firm regarding "${item.subject}". We have received
your message and a member of our team will review it and respond shortly.

[Offline template — set ANTHROPIC_API_KEY for a tailored reply.]

Kind regards,
Client Intake`,
  };
}

// Convert a triaged intake item into a matter (+ client).
function convertIntakeToMatter({ intakeId, title, practiceArea, responsibleAttorney }) {
  const item = db.get('intake', intakeId);
  if (!item) throw new Error('Intake item not found');
  const name = item.fromName || item.from.split('@')[0];
  const client = db.insert('clients', {
    name, type: 'individual', email: item.from, phone: '', address: '',
  });
  const matter = db.insert('matters', {
    title: title || item.triage?.summary || item.subject,
    reference: `M-${Date.now().toString().slice(-6)}`,
    clientId: client.id,
    practiceArea: practiceArea || item.triage?.practiceArea || '',
    status: 'open',
    responsibleAttorney: responsibleAttorney || '',
    description: `Opened from intake: ${item.subject}`,
    parties: [], tags: ['from-intake'],
  });
  db.update('intake', intakeId, { status: 'converted', matterId: matter.id });
  db.logActivity({ actor: 'user', action: 'converted-intake', ref: intakeId, matterId: matter.id, detail: `→ ${matter.title}` });
  return { client, matter };
}

// ---------------------------------------------------------------------------
// Matter assistant — system prompt for the embedded chat (streamed in routes).
// ---------------------------------------------------------------------------
function assistantSystem(matterId) {
  const ctx = matterContext(matterId);
  return (
    'You are BonesAI, the embedded assistant inside the Praixis legal practice '
    + 'management suite. You help the attorney with the matter below: answer '
    + 'questions, summarise, draft snippets, and suggest next steps. Be precise '
    + 'and practical. Never invent citations. Flag when something needs human '
    + 'verification.\n\n'
    + (ctx.matter ? `CURRENT MATTER:\n${ctx.brief}` : 'No specific matter is in context.')
  );
}

module.exports = {
  DRAFT_TEMPLATES,
  matterContext,
  draftDocument,
  extractDeadlines,
  triageIntake,
  convertIntakeToMatter,
  assistantSystem,
};
