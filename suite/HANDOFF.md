# Praixis — Session Handoff

Resume doc for a new Claude Code session opened against **`winigee/praxais`**.
Pair with `CLAUDE.md` (standing project memory) and `INTEGRATION.md` (the
TheWatcher API contract).

## Origin

Praixis was built inside the BonesAI desktop-app repo
(`winigee/claudecode-ripper_app`, on branch
`claude/ai-practice-management-suite-6Sg6H`, under `suite/`) and then split out
into its own repo. The decision history:

- **Foundation:** new web app, with BonesAI (the desktop app's local AI +
  redaction + Claude layer) re-implemented as an embedded, cross-cutting engine.
- **Scope:** build all four core modules at once; treat as an exploration
  prototype (no auth/scale yet).
- **TheWatcher:** a separate timekeeper app, developed in its own repo/chat.
  Chosen integration = **two independent services + a shared HTTP contract**
  (`INTEGRATION.md`). Praixis is a client; neither depends on the other.
- **Naming:** product was "Praxis", renamed to **Praixis**. New repo is
  `praxais` (spelling mismatch is known and accepted).

## Status — what's built and verified

All of the following is implemented and was smoke-tested (syntax checks +
in-process agent tests + a two-service HTTP run with the TheWatcher mock):

- **Matters** module — clients, matters, parties, documents, deadlines, notes,
  time entries; dashboard with counts + upcoming deadlines + activity feed.
- **Drafting** (`agent:drafter`) — 8 templates; matter-aware; saves drafts to
  the matter file; optional redaction before the model call.
- **Docket** (`agent:docket`) — extracts dates from pasted text, computes
  relative deadlines ("within 30 days of service"); can commit to a matter.
- **Intake** (`agent:intake`) — triage (classify / urgency / conflict flag /
  suggested matter / draft reply); convert intake → matter.
- **Assistant** — matter-aware chat, streamed over SSE, with the redaction
  round-trip when Protect is on.
- **Activity** — append-only audit log of agent + user actions.
- **TheWatcher integration** — connector, Time & Billing tab, matter "Start
  timer" button, runtime-configurable URL (or `THEWATCHER_URL`), local mirroring
  of stopped entries, webhook receiver, and a reference mock. Verified that
  Praixis degrades gracefully to local data when TheWatcher is killed.

## Open decisions / next steps (pick up here)

1. **Persistence & auth** — replace the JSON store with SQLite/Postgres; add
   accounts + multi-user. Biggest blocker to real use.
2. **Document ingest** — wire PDF/DOCX extraction so drafting/docket can read
   uploaded files, not just pasted text. (Borrow `pdf-parse`/`mammoth` patterns
   from the BonesAI desktop app.)
3. **Live email/calendar** — make intake real (Gmail/Outlook); push extracted
   deadlines to a real calendar.
4. **Billing UI** — invoices/statements off the `timeEntries` + TheWatcher data.
5. **Conflict checking** — replace the heuristic flag with a real sweep over the
   client/party index.
6. **TheWatcher contract** — confirm `INTEGRATION.md` matches how TheWatcher is
   actually being built (endpoint names, timer model, auth) and bump to v1.1 if
   it drifts.
7. **Repo vs product name** — decide whether to align `praxais`/`Praixis`.

## How to verify changes (no test framework)

- `node --check <file>` on anything edited.
- In-process exercise of a module, e.g.:
  ```sh
  rm -rf data && node -e "require('./server/seed').seed({force:true}); \
    require('./server/ai/agents').triageIntake({intakeId:'int_0001'}).then(r=>console.log(r.triage))"
  ```
- Full HTTP run (Praixis + mock TheWatcher) — see `README.md`. Note: background
  servers may be killed between separate shell calls in the web sandbox; start
  server + curl + kill within a single shell invocation.

## House style

Carried from the BonesAI project: zero deps, JSON-on-disk, comment the *why*
only, tight commits with intent-rich messages, short/direct replies. Local-first
privacy posture — the model call is the one deliberate network reach, gated by
the redaction round-trip.
