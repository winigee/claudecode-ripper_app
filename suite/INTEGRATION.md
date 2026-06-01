# Praxis ⇄ TheWatcher — Integration Contract (v1)

This is the **shared API contract** between two independent applications:

- **Praxis** — the practice management suite (this repo).
- **TheWatcher** — a standalone timekeeper (separate repo, built independently).

Neither app depends on the other to function. When a TheWatcher URL is
configured in Praxis, Praxis becomes a **client** of TheWatcher's API: it can
start/stop timers against a matter and pull time entries into billing. When
TheWatcher is unreachable, Praxis falls back to its own local time entries and
keeps working.

> **For the TheWatcher developer:** implement the endpoints under
> "TheWatcher MUST implement" below and TheWatcher will plug straight into
> Praxis. Everything else (your own UI, storage, auth) is yours to design.

---

## Transport & identity

- REST over HTTP, JSON bodies, UTF-8.
- Dev default URL for TheWatcher: `http://localhost:4400`.
- Praxis identifies a matter with three fields, all optional from TheWatcher's
  point of view (it stores them opaquely and never needs to resolve them):
  - `matterId`  — Praxis internal id, e.g. `mat_0001`
  - `matterRef` — human reference, e.g. `M-100231`
  - `label`     — matter title, e.g. `Acme Robotics v. Nexus Components`
- TheWatcher can also be used with no matter at all (free-form `label` only),
  which is how it stays useful standalone.

---

## TheWatcher MUST implement

### `GET /health`
Liveness + identity. Praxis polls this to show connection status.
```json
200 → { "service": "thewatcher", "status": "ok", "version": "1.0.0" }
```

### `GET /api/timers`
All currently **running** timers.
```json
200 → [
  { "id": "tmr_1", "matterId": "mat_0001", "matterRef": "M-100231",
    "label": "Acme v. Nexus", "attorney": "Sarah Okonkwo",
    "description": "Drafting particulars", "startedAt": "2026-06-01T09:00:00Z",
    "elapsedSeconds": 1320, "running": true }
]
```

### `POST /api/timers`
Start a timer. Returns the running timer.
```json
body → { "matterId": "mat_0001", "matterRef": "M-100231",
         "label": "Acme v. Nexus", "attorney": "Sarah Okonkwo",
         "description": "Drafting particulars", "rate": 450 }
201  → { ...timer, "running": true }
```

### `POST /api/timers/:id/stop`
Stop a running timer; produce a time entry.
```json
200 → { "timer": { ...stopped }, "entry": { ...see entry shape below } }
```

### `GET /api/entries?matterId=&from=&to=`
Completed time entries. All query params optional.
```json
200 → [ {
  "id": "ent_1", "matterId": "mat_0001", "matterRef": "M-100231",
  "attorney": "Sarah Okonkwo", "description": "Drafting particulars",
  "startedAt": "2026-06-01T09:00:00Z", "endedAt": "2026-06-01T10:30:00Z",
  "minutes": 90, "rate": 450, "billable": true
} ]
```

### `POST /api/entries`
Create a manual entry (no live timer).
```json
body → { "matterId": "...", "matterRef": "...", "attorney": "...",
         "description": "...", "minutes": 30, "rate": 450, "billable": true,
         "date": "2026-06-01" }
201  → { ...entry }
```

---

## Optional — live push (TheWatcher → Praxis)

If TheWatcher wants Praxis to react the moment time is logged (instead of
Praxis polling), it MAY POST to a Praxis webhook. Praxis also works fine
without this by polling `GET /api/entries`.

### `POST {praxisUrl}/api/watcher/events`  (implemented by Praxis)
```json
body → { "type": "entry.created", "entry": { ...entry shape } }
200  → { "ok": true }
```
On receipt Praxis mirrors the entry into its local store for billing
resilience and logs it to the activity feed.

---

## Independence guarantees

| | Runs standalone | When paired |
| --- | --- | --- |
| **TheWatcher** | Yes — own UI, tracks time against labels or matter ids. | Praxis drives start/stop and reads entries via the API above. |
| **Praxis** | Yes — local `timeEntries` collection, manual entry. | Surfaces TheWatcher timers/entries; mirrors stopped entries locally for billing. |

No shared database, no shared code, no startup-order dependency. The contract
above is the only coupling.

---

## Versioning

This document is **v1**. Breaking changes bump the version and SHOULD be
negotiated via the `version` field returned by `GET /health`.
