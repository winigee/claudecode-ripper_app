# BonesAI — Session Dump

Resume point for the next session in case this one hangs.
Updated by Claude at the user's request after v2.4.1.

## Repo & branch

- Repo: `winigee/claudecode-ripper_app`
- Working branch: `claude/bold-brahmagupta-oekyf` (all commits go here; never push elsewhere without explicit permission)
- Latest commit: v2.4.1 (`d09ddc3` — re-identification + rename CLEAN → REDACT)
- User: Winston Green (winstongreen@gmail.com)

## Latest release

- File: `releases/BonesAI-v2.4.1-mac-x64.app.zip` (~90 MB)
- Raw URL: `https://github.com/winigee/claudecode-ripper_app/raw/claude/bold-brahmagupta-oekyf/releases/BonesAI-v2.4.1-mac-x64.app.zip`
- Built unsigned (`mac.identity: null`). User installs by right-click → Open the first time to bypass Gatekeeper.

## Build & ship recipe

From repo root:

```
node -e "const p=require('./package.json');p.version='X.Y.Z';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n');"
rm -rf dist
npx electron-builder --mac --x64 --dir
# Strip every .lproj except en to keep the bundle small
APP=dist/mac/BonesAI.app
LB="$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
for d in "$LB"/*.lproj; do [ "$(basename "$d" .lproj)" != "en" ] && rm -rf "$d"; done
cd dist/mac && zip -9ryqX "../BonesAI-vX.Y.Z-mac-x64.app.zip" "BonesAI.app" && cd ..
SHA=$(sha256sum BonesAI-vX.Y.Z-mac-x64.app.zip | awk '{print $1}')
echo "$SHA  BonesAI-vX.Y.Z-mac-x64.app.zip" > BonesAI-vX.Y.Z-mac-x64.app.zip.sha256
# Replace previous release in /releases, commit, push to claude/bold-brahmagupta-oekyf.
```

GitHub warns about >50 MB file size (`GH001`). Ignore — user is OK with this for now and doesn't want LFS.

## What ships in BonesAI today (v2.4.1)

A local-first macOS Electron app. All the inference work runs on the user's Mac via llamafile + a downloadable local model. One feature deliberately reaches the network (Claude API). Tabs: Chat / Work / Brain / Settings.

### Chat tab
- Streaming chat against the local model
- Persistent chat history (`chats.js` → `~/Library/Application Support/BonesAI/chats/*.json`)
- Sidebar list with delete, new-chat button
- ⌘↩ to send, spinning skull while replying

### Work tab
1. **Drop / pick files or folder** → `ingest.js` (txt/md/json/csv/log/pdf/docx, ≤5 MB, ≤200 files)
2. **Find documents** (semantic search, v2.3.0)
   - `docsearch.js` — three-stage pipeline:
     1. Local model expands the query into related terms
     2. Lexical ranking over every loaded doc (chunked, term-coverage + phrase bonuses)
     3. Local model judges the top candidates: strong / possible / weak / none
   - "Expand query with related terms" checkbox — off = literal only
3. **Redact & send to Claude** (the "cannon", v2.4.0 + v2.4.1 re-identification)
   - **REDACT button**: `redact.js`. Two passes:
     - Deterministic regex: emails, phones (digit-count gated), street addresses, PO boxes, UK postcodes, companies with legal suffixes (Ltd/Inc/LLC/PLC/GmbH…), titled people (Mr/Dr/Ms…)
     - Optional local-model NER pass for plain names regex misses (toggle)
   - Consistent pseudonyms: same entity → same `[PERSON_1]` / `[COMPANY_2]` token throughout
   - Editable redacted-text box (review before sending)
   - **Renderer holds `state.redactMap` = `{placeholder: original}` in memory only — never written to disk, wiped on reload/quit/re-redact**
   - **Prompt library** (`prompts.js`): 8 built-in prompts + user-saved ones (in `config.json` under `prompts`). `{{variable}}` syntax → renderer renders a labelled field per variable.
   - **Send to Claude** (`claude-api.js`): streams the Anthropic Messages SSE (`content_block_delta`). API key in `config.json` mode 0600.
   - Models exposed: Opus 4.8 / Sonnet 4.6 / Haiku 4.5 (default Sonnet 4.6).
   - **Auto re-identification**: after the response, `[TYPE_N]` tokens are swapped back to real names. Toggle button to flip between redacted/re-identified views. Save-to-Brain saves whichever view is on screen.
4. **Summarise / Compact** (older, still there) — structured summary or dense compaction, streams locally, save-to-Brain.

### Brain tab
- Stored notes (`brain.js` → `notes.json`)
- Title, body, source files, created_at; delete

### Settings tab
- Active model status + restart server
- **Network sharing** (v2.2.0): HTTP server (`web-server.js`) on `8765`, token-protected, localhost-only or 0.0.0.0 LAN. URLs list per interface (Wi-Fi, Tailscale).
- **Claude API** (v2.4.0): paste key (sk-ant-…), choose model. Last-4 shown after save.
- **Available models**: download/switch/delete Phi-3.5-mini / Qwen 7B / Qwen 14B / Qwen 32B.
- Diagnostics: llama-server log tail.

### Mobile / web (v2.2.0)
- Same renderer served via in-app HTTP. Detects browser vs Electron at `index.html` top — falls back to `bones-http.js` HTTP/SSE client when `window.bones` isn't injected by preload.
- Mobile-responsive CSS ≤760 px: sidebar slides off behind hamburger toggle.
- Browser stubs: Work, model management, docsearch, redact, cannon, prompt library, API settings, sharing UI all return "host only" — those features only work in the desktop app.

## Architecture map

```
src/main/
  main.js          — Electron entry, IPC handlers
  preload.js       — context bridge exposing window.bones
  config.js        — config.json (mode 0600), model registry, hw detect
  llama-server.js  — spawns llamafile via /bin/bash, /health probe loop
  llama.js         — chat/summarise/compact/ping + complete() helper
  ingest.js        — file walker + readers (pdf-parse, mammoth)
  docsearch.js     — semantic doc search pipeline (v2.3.0)
  redact.js        — regex + local-model NER de-identification
  prompts.js       — built-in + user prompt library, {{vars}}
  claude-api.js    — Anthropic Messages SSE streaming cannon
  brain.js         — notes CRUD
  chats.js         — chat history CRUD
  model-download.js
  web-server.js    — HTTP server for browser/mobile (v2.2.0)

src/renderer/
  index.html       — single page, all tabs, Electron-or-browser detect
  renderer.js      — all UI logic
  bones-http.js    — HTTP fallback transport for browser
  styles.css       — dark theme, skull SVG, mobile breakpoints
```

## User state / preferences

- **Hardware**: 2014 MBP currently the host. Planning to add an always-on Mac later (Mac mini in mind, parked). Wants iPhone + other Macs to reach BonesAI.
- **Has not yet reported testing v2.4.1**. Last confirmed install was v2.1.x. The CLEAN→REDACT rename, re-identification, semantic search, prompt library, and Anthropic cannon all shipped this session and are awaiting their first real-world test from the user.
- **Tailscale path**: laid out but not yet installed. Plan is install Tailscale on MBP + iPhone, then the URL in the Settings → Network sharing list with the Tailscale interface name is the "from anywhere" URL.
- **Always-on Mac decision**: parked. Brevity hosting migration (separate context) also parked.

## Open / pending decisions

- **v2.5.0 candidates** (none committed):
  - More entity types in REDACT (US ZIPs, IBANs, dates of birth, NINOs, SSNs)
  - Better folder ingest UX (progress bar for big folders, recurse depth control)
  - Push notifications when a long Claude response finishes (would need a service worker on the iPhone PWA — non-trivial)
  - Work tab over the web (requires shipping a host-side file picker via HTTP, plus thinking through privacy of doing redact remotely)
  - Tailscale auto-detect that picks Tailscale URL by default in the Settings sharing UI
- **Real-world feedback wanted** on:
  - REDACT recall: what names slip through the regex + local-model pass on real docs
  - Find documents tuning: too strict / too loose, snippet positioning
  - The 7B model on the 2014 MBP — speed, RAM headroom

## House style I've been following

- Local-first by default; the cannon is the one deliberate exception.
- No unnecessary comments. Only where the WHY isn't obvious from the code.
- Tight, focused commits. Big multi-paragraph commit messages explaining intent.
- No `gh` CLI in this environment — use the `mcp__github__*` tools for GitHub operations (PR commenting, etc.).
- User asked for short, direct responses; long explanations only when shipping a release.
- Don't push without testing — usually a syntax check + a node-level unit test of any new module.

## How to resume

1. `git log --oneline -10` — see recent commits.
2. `git status` — should be clean if v2.4.1 push went through.
3. Ask the user what they want next; don't assume.
4. If continuing this STATE.md, update it as work progresses so it stays current.
