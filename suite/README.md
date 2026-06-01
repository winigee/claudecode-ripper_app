# Praixis — AI Agentic Practice Management Suite

A prototype practice management suite for law firms, with the **BonesAI engine**
embedded as a cross-cutting AI layer. Built as a zero-dependency Node web app —
no `npm install`, no build step.

## Run

```sh
cd suite
node server/index.js
# → http://localhost:4317
```

Optionally enable the live AI agents by exporting an Anthropic key first:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
node server/index.js
```

Without a key, every agent falls back to a deterministic stub so the whole
prototype is demonstrable offline. The header pill shows `BonesAI: online/offline`.

## What's here

Four core modules, plus the BonesAI assistant woven through every screen:

| Module | What it does | Agent |
| --- | --- | --- |
| **Matters** | Clients, matters, parties, documents, deadlines, notes, time entries. The backbone everything hangs off. | — |
| **Drafting** | Generates a reviewable first draft (engagement letter, demand letter, memo, NDA, motion outline, …) from matter context. Saves to the matter file. | `agent:drafter` |
| **Docket** | Reads a court order / contract / letter and extracts dates, computing relative deadlines ("within 30 days of service"). | `agent:docket` |
| **Intake** | Triages inbound messages: classify, flag conflicts, suggest a matter link, draft a reply, convert to a matter. | `agent:intake` |
| **Activity** | Append-only audit log of everything the agents and users did. | — |

### BonesAI engine (`server/ai/`)

- `redact.js` — local de-identification (adapted from the BonesAI desktop app).
  People, orgs, addresses, emails, phones, SSNs, postcodes/ZIPs → consistent
  `[PERSON_1]` style placeholders.
- `claude.js` — Anthropic Messages client (streaming + non-streaming).
- `bones.js` — the privacy round-trip: redact → send → re-identify the reply
  locally. Real client/party names never leave the building when **🛡 Protect**
  is on. The replacement map is held in memory only, never persisted.
- `agents.js` — the four agents and the matter-aware assistant prompt.

## TheWatcher integration (timekeeper)

TheWatcher is a **separate, independent timekeeper app** (its own repo). Praixis
works with it but never depends on it. The coupling is a single documented HTTP
contract — see [`INTEGRATION.md`](./INTEGRATION.md).

- **Connected:** the **⏱️ Time** tab and the matter "Start timer" button drive
  timers in TheWatcher and pull its entries into billing. Stopped entries are
  mirrored locally so billing survives if the timekeeper later goes offline.
- **Not connected:** Praixis falls back to its own local time entries and keeps
  working. TheWatcher, likewise, runs fully standalone.

Configure the URL in the Time tab, or via `THEWATCHER_URL`. To see it working
before the real TheWatcher exists, run the reference mock alongside Praixis:

```sh
# terminal 1 — reference timekeeper (implements the v1 contract)
node server/integrations/thewatcher-mock.js          # → http://localhost:4400

# terminal 2 — Praixis, pointed at it
THEWATCHER_URL=http://localhost:4400 node server/index.js
```

> Hand `INTEGRATION.md` to the TheWatcher project so it implements the matching
> endpoints. The mock under `server/integrations/thewatcher-mock.js` is a
> reference stub, **not** the real TheWatcher.

## Architecture

```
suite/
  server/
    index.js        HTTP server (REST + SSE), static file serving
    db.js           JSON-file data store (swap for SQLite/Postgres later)
    seed.js         demo firm data on first boot
    ai/             ← the BonesAI engine
      redact.js  claude.js  bones.js  agents.js
    integrations/
      thewatcher.js       Praixis-side connector to the timekeeper
      thewatcher-mock.js  reference stub implementing the v1 contract
  INTEGRATION.md    Praixis ⇄ TheWatcher API contract
  web/
    index.html  app.js  styles.css   single-page UI, no framework
  data/             db.json (gitignored, created at runtime)
```

## Prototype scope / next steps

This is an exploration build. Deliberately not done yet:

- **Persistence**: single-process JSON store, no auth, no multi-user. Move to
  SQLite/Postgres + accounts before real use.
- **Document ingest**: drafting/docket take pasted text; wire in PDF/DOCX
  extraction (the desktop BonesAI already has `pdf-parse` + `mammoth`).
- **Real email/calendar**: intake is simulated. Connect Gmail/Outlook for live
  triage and push extracted deadlines to a real calendar.
- **Billing**: time entries are stored but there's no invoicing UI yet.
- **Conflicts**: the intake agent flags conflicts heuristically; a real
  conflict-check should run against the full client/party index.
