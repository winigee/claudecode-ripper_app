# Praixis — Project Memory

> Claude Code loads this file automatically. It is the standing context for the
> Praixis repo. For the fuller narrative / session history see `HANDOFF.md`.

## What this is

**Praixis** — an AI agentic practice management suite for law firms. A
zero-dependency Node web app (pure `http` + vanilla-JS SPA, no build step, no
`npm install`). The **BonesAI engine** is embedded as a cross-cutting AI layer.

It was split out of the BonesAI desktop-app repo (`winigee/claudecode-ripper_app`)
into its own repo (`winigee/praxais`). Product name = **Praixis**; repo name =
`praxais` (the spelling mismatch is intentional/known).

## Run

```sh
node server/index.js            # → http://localhost:4317
export ANTHROPIC_API_KEY=sk-ant-...   # optional: enables live AI agents
```
Without a key, every agent falls back to deterministic stubs so the whole app
is demonstrable offline. There is no test runner; verify with `node --check`
on changed files plus an in-process require of the affected module.

## Architecture

```
server/
  index.js        HTTP server: REST + SSE, static file serving, route table
  db.js           JSON-file data store (data/db.json) — collections + _meta
  seed.js         demo firm data on first boot
  ai/             ← the BonesAI engine
    redact.js     local de-identification (regex; consistent [PERSON_1] tokens)
    claude.js     Anthropic Messages client (streaming + non-streaming)
    bones.js      privacy round-trip: redact → send → re-identify locally
    agents.js     the 4 agents + matter-aware assistant system prompt
  integrations/
    thewatcher.js       connector to TheWatcher (the timekeeper)
    thewatcher-mock.js  reference stub implementing the v1 contract
web/
  index.html app.js styles.css   single-page UI (no framework)
INTEGRATION.md    Praixis ⇄ TheWatcher API contract (v1)
data/             db.json — gitignored, created at runtime
```

## Core concepts

- **Matters** are the backbone. Clients, documents, events (deadlines/hearings),
  notes, and time entries all hang off a `matterId`.
- **Four agents** (`server/ai/agents.js`):
  - `agent:drafter` — drafts documents from matter context.
  - `agent:docket` — extracts dates/deadlines from text (computes relative ones).
  - `agent:intake` — triages inbound messages; can convert to a matter.
  - the **assistant** — matter-aware chat, streamed over SSE.
- **The privacy invariant (BonesAI):** when **Protect** is on, material is
  de-identified *before* it leaves for the model and the reply is re-identified
  *locally*. Real client/party names never go to the API. The replacement map is
  in-memory only, never persisted. See `bones.protectedComplete` and the chat
  redaction round-trip in `index.js`.
- **TheWatcher** is a *separate, independent* timekeeper app (its own repo).
  Praixis is only a client of its HTTP API (`INTEGRATION.md`). It must keep
  working when TheWatcher is offline (falls back to local `timeEntries`).

## Conventions / house style

- **Zero runtime dependencies.** Pure Node built-ins + vanilla JS. Keep it that
  way unless there's a strong reason; if adding a dep, flag it first.
- JSON-on-disk for storage (`db.js`). One object in memory, debounced flush.
- Comments explain *why*, not *what*. Don't over-comment.
- Tight, focused commits with intent-explaining messages.
- Match the existing terse code idiom (small helpers, early returns).
- Do **not** put the model identifier or internal session info in commits,
  code, or pushed artifacts.

## Known prototype limitations (intentional, not bugs)

- Single-process JSON store, **no auth, no multi-user**. Move to SQLite/Postgres
  + accounts before real use.
- Drafting/docket take **pasted text**; PDF/DOCX ingest not wired in yet (the
  BonesAI desktop app has `pdf-parse` + `mammoth` to borrow from).
- Intake is **simulated**; no live Gmail/Outlook yet.
- Time entries stored but **no invoicing UI**.
- Conflict checking in intake is heuristic, not a real index sweep.
