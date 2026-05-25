# BonesAI — Build Specification (v0.7.2 handoff)

Purpose: hand this to a fresh session so it can continue BonesAI from a known
state. Read this top to bottom before touching any code. The original spec we
started from is wrong on several factual points (hardware, default architecture,
delivery mechanism); this document supersedes it.

---

## 1. What BonesAI is, now

A **local-first** macOS desktop application for document summarisation and
research. All inference runs on-device via `llamafile` + Qwen2.5-7B-Instruct.
Nothing leaves the Mac during ordinary use. The Anthropic Claude API is
**not** integrated in v0.7.x. It will return in **v0.8.0** as an explicit,
gated per-request action, behind a local-anonymisation review step.

This is the user's personal tool. Not distributed.

---

## 2. Target environment (corrected)

- **Hardware: 2014 MacBook Pro 15"** (MacBookPro11,3), confirmed via crash
  report. Quad-core Intel Core i7 (Crystalwell) @ 2.8 GHz, 16 GB DDR3,
  Intel Iris Pro + NVIDIA GeForce GT 750M (irrelevant for AI). 1 TB Apple SSD.
- **OS: macOS 11.7.10 Big Sur (build 20G1427)**. Confirmed.
- **Architecture: x86_64**. Build x86_64 only.
- Home dir: `/Users/Dub/`.

The original spec said "2020 Intel Mac". It was wrong. This matters because:
- Inference performance is ~half what was originally projected.
- Big Sur 11.7.10 is the oldest macOS we have to support, not 11.7 generically.
- Modern llama.cpp prebuilt binaries require macOS 12.7+ and will NOT load on
  this Mac.

---

## 3. Current state — v0.7.2

- **Latest version: v0.7.2**, on branch `claude/bold-brahmagupta-oekyf` of
  `winigee/claudecode-ripper_app`.
- Release artifact at `releases/BonesAI-v0.7.2-mac-x64.app.zip` (89 MB,
  SHA-256 in the sibling `.sha256` file).
- Download URL for the user (no terminal needed):
  `https://github.com/winigee/claudecode-ripper_app/raw/claude/bold-brahmagupta-oekyf/releases/BonesAI-v0.7.2-mac-x64.app.zip`

**Open blocker as of this handoff**: llamafile 0.10.1 starts silently and dies
without producing any output on the user's Big Sur 11.7.10 in v0.7.0 and
v0.7.1. v0.7.2 ships with a comprehensive overhaul that should diagnose or
fix it (see §5). **The user has not yet tested v0.7.2 at the time of this
spec being written.** First thing the next session must do is ask whether
v0.7.2 started successfully.

---

## 4. Performance baseline (for this hardware)

Once llamafile starts:

| Workload | Expected time on this 2014 MBP |
| --- | --- |
| Cold model load (per launch) | 15–40 s |
| Short paragraph summary | 15–30 s |
| 8K-token-context full summary | 1–3 min |
| Token throughput | ~3–6 tok/sec on CPU |
| Resident RAM with model loaded | ~5.5 GB |

If this is too slow for the user's actual use, the natural pivot is
**Phi-3.5-mini Q4_K_M (2.4 GB)** which runs at ~10–15 tok/sec on the same
hardware. Drop the GGUF into `~/Library/Application Support/BonesAI/models/`
and add a model-picker UI in Settings.

---

## 5. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  BonesAI.app (Electron 28.3.3, Chromium 120, Node 18.18)     │
│                                                              │
│  ┌─────────────────────┐         ┌─────────────────────┐     │
│  │  Renderer (UI)       │ <─IPC─> │  Main process       │     │
│  │  Work / Brain /      │         │  - File ingest      │     │
│  │  Settings tabs       │         │  - Brain JSON       │     │
│  └─────────────────────┘         │  - Spawns child:    │     │
│                                   └────────┬────────────┘     │
└────────────────────────────────────────────┼──────────────────┘
                                              │ stdio
                                              ▼
                       ┌──────────────────────────────────┐
                       │  llamafile child (127.0.0.1 only) │
                       │  - HTTP server on random port    │
                       │  - OpenAI-compatible /v1/chat    │
                       │  - Loads Qwen2.5-7B GGUF         │
                       └──────────────────────────────────┘
```

### Why these choices

- **Electron 28.3.3** — pinned because Electron 28 supports macOS 10.15+ on
  Intel. Later Electron releases may not. Do not upgrade without verifying
  in the Electron release notes that Big Sur 11.x is still supported.
- **llamafile (not llama.cpp directly)** — Mozilla's Cosmopolitan-libc-built
  single binary. Runs on macOS 10.15+ Intel without dylibs or compilation.
  Bypasses the modern-macOS-only constraint of the official llama.cpp
  prebuilts. Speaks the same OpenAI-compatible HTTP API.
- **llamafile downloaded on first run, not bundled in the .app** — keeps
  the .app under GitHub's 100 MiB per-file limit so it can be delivered as
  a single zip via a browser-downloadable GitHub raw URL.
- **No native modules** — `pdf-parse` and `mammoth` are pure JS. Avoids
  node-gyp / dylib ABI mismatches on Big Sur Intel.
- **Brain as JSON file on disk** — simpler than SQLite for a single-user
  tool. No native deps.

### v0.7.2 spawn logic (overhauled in `src/main/llama-server.js`)

Cosmopolitan binaries start with `MZ` (DOS magic). macOS Big Sur sometimes
refuses to exec them directly because it doesn't see a Mach-O magic at byte
zero (the Mach-O is embedded at offset ~3224). The current code:

1. **Attempts direct `spawn(bin, args)` first.**
2. Listens for `proc.on('error', ...)` — previously missing, which is why
   v0.7.0/0.7.1 failed silently.
3. If the direct spawn dies before `/health` responds, **falls back to
   `spawn('/bin/bash', ['-c', 'exec ...'])`**. This lets the APE shell
   prefix at the top of the file bootstrap the embedded Mach-O via bash
   builtins.
4. **`probeHealth` bails fast** if the child dies — does not wait the full
   3-minute timeout.
5. **All output tee'd to `~/Library/Application Support/BonesAI/llama-server.log`**
   per-line (appendFileSync), so log entries can't be lost across rapid
   spawn cycles.

---

## 6. Repo layout

```
/
├── package.json              electron-builder config, version, deps
├── src/
│   ├── main/                 Electron main process
│   │   ├── main.js           Window + IPC routing
│   │   ├── preload.js        contextBridge API
│   │   ├── llama-server.js   Spawns llamafile, health probe, log
│   │   ├── llama.js          HTTP client for llamafile, prompts, streaming
│   │   ├── model-download.js First-run HF + llamafile downloads
│   │   ├── ingest.js         Folder walk + readers (txt/md/pdf/docx)
│   │   ├── brain.js          JSON note store
│   │   └── config.js         Paths + model metadata + version pins
│   └── renderer/             Chromium UI
│       ├── index.html
│       ├── renderer.js
│       └── styles.css        Cyan-on-deep-blue, matches chosen icon
├── scripts/
│   ├── fetch-llama.sh        Downloads llamafile into vendor/ (build-time)
│   └── build-mac.sh          On-Mac build helper (not used for cloud builds)
├── vendor/llama-cpp/         llamafile staged here (gitignored)
├── build/                    Optional icon.png / icon.icns drop-zone
├── releases/                 Distributed .app zips (committed)
│   ├── BonesAI-v0.7.2-mac-x64.app.zip
│   └── BonesAI-v0.7.2-mac-x64.app.zip.sha256
└── SPEC.md                   THIS FILE
```

### Files on the user's Mac after install

- App: `/Applications/BonesAI.app` (drag-installed)
- Application Support: `/Users/Dub/Library/Application Support/BonesAI/`
  - `runtime/llamafile` — 42 MB Cosmopolitan binary, downloaded on first run
  - `models/Qwen2.5-7B-Instruct-Q4_K_M.gguf` — 4.7 GB, downloaded on first run
  - `llama-server.log` — rolling, per-spawn log; primary diagnostic
  - `brain.json` — persistent notes
  - `config.json` — settings (chmod 600)
- llama.cpp source the user once tried to use: `/Users/Dub/localai/llama.cpp/`
  — has compiled binaries but no `llama-server` (the server target was
  silently dropped because libcurl was absent at cmake configure time).
  **Do not rely on this build.** Stick with llamafile.

---

## 7. Build & delivery flow (cross-build from cloud Linux container)

This is the flow we converged on, after the original "build on the Mac"
approach hit too much terminal friction:

1. In this Linux container: `npm install`.
2. `npx electron-builder --mac --x64 --dir` → produces `dist/mac/BonesAI.app`
   (unsigned, no codesign since we're on Linux).
3. Strip non-`en` locales from `dist/mac/BonesAI.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/*.lproj` to save ~36 MB.
   **Do NOT strip `Squirrel.framework`, `Mantle.framework`, or
   `ReactiveObjC.framework`** — Electron 28 hard-links to Squirrel via
   `@rpath` and removing them causes an instant dyld crash on Big Sur.
   (Older note in v0.7.0's commit log explains this in detail.)
4. `zip -9ryqX BonesAI-vX.Y.Z-mac-x64.app.zip BonesAI.app` — preserves
   symlinks and exec bits.
5. SHA-256 the zip.
6. Copy to `releases/` and commit to the branch.
7. Push.
8. Tell user the raw URL:
   `https://github.com/winigee/claudecode-ripper_app/raw/claude/bold-brahmagupta-oekyf/releases/BonesAI-vX.Y.Z-mac-x64.app.zip`

The user downloads in Safari/Chrome, unzips, drags to Applications,
**right-clicks → Open** the first time (or System Preferences → Security &
Privacy → "Open Anyway"). After that it launches normally.

The build artifact stays under GitHub's 100 MiB per-file hard limit because
llamafile is not bundled in the .app — the app downloads it on first run.

---

## 8. v0.8 — what comes next

The original spec's cloud-via-Claude path returns as an **explicit, gated**
per-request action.

### Flow (must be implemented exactly this way)

1. User clicks "Summarise with Claude" button (only enabled when an Anthropic
   API key is configured in Settings).
2. Local Qwen scans the input text and proposes redactions: people,
   organisations, dates, locations, case numbers, identifiers. Each entity
   is replaced with a placeholder token (`[PERSON_1]`, `[ORG_2]`, etc.).
   Mapping kept in memory only.
3. **The renderer shows a diff: original vs redacted text, plus the entity
   map.** Nothing has left the Mac yet.
4. User can: approve, edit the redactions and re-propose, or cancel.
5. On approve: redacted text → Claude API → response → placeholders reversed
   locally so the output is readable.

### Invariants (non-negotiable)

- **Nothing leaves the Mac unless the user has seen exactly what would leave
  and clicked Approve.** No "trust me" path.
- No auto-anonymise-then-send. Always a human gate.
- No API key in the .app bundle. Always env var or chmod-600 config.
- Anonymisation prompts to Qwen must be deterministic enough that the user
  can review meaningfully.

### Model choice for the API call

Default to `claude-sonnet-4-6`. Allow `claude-opus-4-7` (highest quality) and
`claude-haiku-4-5` (cheapest) via Settings. Use `output_config.format` for
structured output, not assistant-turn prefills (deprecated on 4.6/4.7).

### Decisions explicitly NOT taken

- Do not default to cloud.
- Do not anonymise silently in the background.
- Do not store API responses on Anthropic's servers — Claude API has a
  no-retention option; document it for the user but don't enforce it
  client-side.

---

## 9. Iteration history (for context)

| Version | What changed | Why |
| --- | --- | --- |
| v0.5.0 | Original spec, not built in this session | — |
| v0.6.0 | First session-built Electron+Claude-API .app | Original spec's request |
| v0.7.0 | Pivoted to local-first, llama.cpp from user's build | User correctly identified spec was wrong on cloud-default |
| v0.7.0 (rev 2) | Switched to llamafile bundled in .app | User's llama.cpp build was missing the server target |
| v0.7.0 (cross-built) | Cross-built from Linux container, delivered via GitHub raw URL | User wanted no terminal steps |
| v0.7.0 (final) | Stripped Squirrel.framework — caused immediate dyld crash on Big Sur | Misjudged what was load-bearing |
| v0.7.0 (refix) | Restored frameworks; still no app launch | — |
| v0.7.1 | Frameworks restored; setup modal still trapped UI; llamafile failed silently | Modal hid behind 120s IPC wait; spawn errors swallowed |
| v0.7.2 | Spawn rewritten with direct + shell fallback, comprehensive logging, modal gated only on file presence | Cosmopolitan APE binaries may need shell bootstrap on Big Sur |

---

## 10. Icon

User chose the **"Bones Data"** design (second from left in their 4-up contact
sheet) — polygon-mesh skull on cyan/blue, crossbones with binary digits, signal
waveform background.

Currently **not present in the .app** (using default Electron icon). The build
is wired to pick up `build/icon.png` (1024×1024) or `build/icon.icns` if
present. User needs to provide as a standalone PNG file — the contact sheet
is an image I can see but not crop programmatically.

App UI is already styled to match the icon's aesthetic (cyan-on-deep-blue
palette, glowing primary buttons, BONESAI wordmark with cyan AI suffix).

---

## 11. Privacy posture (current, v0.7.x)

- 100% on-device inference. No network calls during use.
- Only outbound traffic: one-time HuggingFace model download, one-time
  llamafile download from Mozilla's GitHub. Both happen explicitly on first
  run with progress bars.
- llamafile binds `127.0.0.1` only, never network-exposed.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, CSP locked
  to `'self'` origins.
- Suitable for privileged/confidential material — subject to user's own
  diligence on the model weights (Qwen2.5 is Apache 2.0, audited by many)
  and on llamafile (Mozilla, well-known project).

v0.8 changes this for the cloud-call path only, and only with explicit
per-request approval via the redaction diff.

---

## 12. Things a fresh session must do first

In order:

1. **Check whether v0.7.2 worked on the user's Mac.** Ask them: did the
   "ready" status appear, or did it fail? If failed, ask for the contents
   of `~/Library/Application Support/BonesAI/llama-server.log`. The v0.7.2
   log will be much more diagnostic than prior versions.
2. **If v0.7.2 fails**: the log will identify the failure mode. Likely
   candidates with fixes:
   - "spawn error (direct): ... ENOEXEC" + "spawn error (shell): ..." →
     macOS rejecting Cosmopolitan in all modes. Fallback path: cross-compile
     llama.cpp ourselves via osxcross with `-mmacosx-version-min=11.0`,
     bundle the resulting static `llama-server` instead of llamafile.
   - "[err] ... model load failed ..." → GGUF file corrupted, ask user to
     delete and re-download.
   - "[err] ... unsupported instruction set ..." → CPU lacks AVX2 (Haswell
     should have it, but verify). Switch to a non-AVX2 build of llamafile
     or compile our own with `-march=core2`.
3. **If v0.7.2 worked**: ready to start v0.8 (cloud-with-anonymisation,
   §8). Confirm scope with user before building.
4. **Always**: deliver builds via the `releases/` directory on the branch.
   Never via chat attachment (the original session died from this).

---

## 13. Authoritative source pins

- **Electron**: 28.3.3 (devDependencies in package.json). Do not upgrade
  without verifying Big Sur support.
- **llamafile**: 0.10.1 (LLAMAFILE_VERSION in src/main/config.js). Mozilla's
  GitHub releases at `mozilla-ai/llamafile`.
- **GGUF model**: Qwen2.5-7B-Instruct-Q4_K_M.gguf from
  `huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF`. ~4.7 GB.
- **Node**: 18.x or 20.x for build. Container in this session has 22.x and
  it works for electron-builder cross-build.

---

## 14. Known unknowns at this handoff

1. Does llamafile 0.10.1 actually start on macOS 11.7.10 in either direct
   or shell spawn mode? The v0.7.2 log will tell us.
2. If neither works, can we cross-compile llama.cpp ourselves in this
   Linux container? Requires osxcross + a macOS 11 SDK. Possible but
   involved.
3. Does the user want to provide the "Bones Data" icon as a standalone
   PNG, or carry on with the default Electron icon?
4. Are there other documents (PDFs, DOCX, etc.) on the user's Mac that
   make for a good first real test of summarisation once it's running?
