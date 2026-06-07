# BonesAI — Session Dump / Resume Point

Read this first if you're a fresh session picking up BonesAI. It's the
single source of truth for where things stand. Keep it updated as you ship.
Last updated: after **v2.15.0** (BackBones encrypted P2P chat).

## Repo & branch

- Repo: `winigee/claudecode-ripper_app` (GitHub MCP tools restricted to this repo)
- Working branch: **`claude/bold-brahmagupta-oekyf`** — all commits go here. Never push elsewhere.
- User: Winston Green (winstongreen@gmail.com), founder of **WNSTNGRN Ltd**.

## How to ship a release (the ritual, every time)

```
cd /home/user/claudecode-ripper_app
node -e "const p=require('./package.json');p.version='X.Y.Z';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n');"
sed -i 's/id="brand-version">vPREV</id="brand-version">vX.Y.Z</' src/renderer/index.html
rm -rf dist
npx electron-builder --mac --x64 --dir 2>&1 | tail -2
APP=dist/mac/BonesAI.app
LB="$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
for d in "$LB"/*.lproj; do [ "$(basename "$d" .lproj)" != "en" ] && rm -rf "$d"; done
cd dist/mac && zip -9ryqX "../BonesAI-vX.Y.Z-mac-x64.app.zip" "BonesAI.app" && cd ..
SHA=$(sha256sum BonesAI-vX.Y.Z-mac-x64.app.zip | awk '{print $1}')
echo "$SHA  BonesAI-vX.Y.Z-mac-x64.app.zip" > BonesAI-vX.Y.Z-mac-x64.app.zip.sha256
cd /home/user/claudecode-ripper_app
rm -f releases/BonesAI-vPREV-mac-x64.app.zip releases/BonesAI-vPREV-mac-x64.app.zip.sha256
cp dist/BonesAI-vX.Y.Z-mac-x64.app.zip releases/ ; cp dist/BonesAI-vX.Y.Z-mac-x64.app.zip.sha256 releases/
git add -A && git commit -m "..." && git push -u origin claude/bold-brahmagupta-oekyf
```

- **Download link format** (the github.com/raw/ redirect chokes on 90 MB; use raw.githubusercontent pinned to the commit SHA):
  `https://raw.githubusercontent.com/winigee/claudecode-ripper_app/<SHORT_SHA>/releases/BonesAI-vX.Y.Z-mac-x64.app.zip`
  Always verify with `curl -sIL <url> | grep -iE "^HTTP|content-type"` → expect `HTTP/2 200`, `application/zip`.
- Only keep ONE release zip in `releases/` at a time (delete the previous).
- Build is unsigned (`mac.identity: null`). User installs by **right-click → Open** the first time (Sonoma Gatekeeper). prompt() is unsupported in Electron — use the in-app showInput() modal instead. confirm()/alert() are fine.
- Commit message footer: `https://claude.ai/code/session_01PiionwEvz4MiKx61i9eraD` (do NOT put the model id anywhere in commits/PRs/code).

## Current release

- **v2.15.0** — commit `0ef2c7e`.
- `releases/BonesAI-v2.15.0-mac-x64.app.zip` (~90 MB).

## Architecture map

```
src/main/
  main.js          Electron entry, ALL ipcMain handlers, BackBones session glue
  preload.js       contextBridge → window.bones.*
  config.js        config.json (mode 0600); model registry; hardware detect; context window (getContext/setContext, 4K/8K/16K/32K, default by RAM); defaultThreads; findInstalledFile (scans models dir for any matching .gguf)
  llama-server.js  spawns llamafile via /bin/bash; /health probe; log rotation (5MB→.old); status() exposes runtime {context,threads,hardware}
  llama.js         chatStream (temp param), summarise, compact, chat (injects memory), complete (non-streaming), ping
  ingest.js        file walker + readers (pdf-parse, mammoth); txt/md/json/csv/log/pdf/docx, ≤5MB, ≤200 files
  docsearch.js     "Find documents": query-expand → lexical rank → model judge; partial-on-cancel
  redact.js        regex + local-model NER de-identification; consistent [PERSON_1] placeholders; partial-on-cancel
  prompts.js       cannon prompt library: 8 builtins + user prompts; {{vars}}
  claude-api.js    Anthropic Messages SSE; send() takes {prompt,material} OR {messages:[...]}; key in config.json
  memory.js        shared Memory (injected into every local chat); local OR iCloud Drive (~/Library/Mobile Documents/com~apple~CloudDocs/BonesAI/memory.json); add/addMany(text,source)/remove/injectionText/setICloud
  absorb.js        turn docs → Memory facts; chunk → model extract → dedupe; partial-on-cancel
  prompt-engine.js Brain research-prompt engineer (local model builds a structured prompt)
  brain.js         saved briefs store (brain.json); addNote takes optional question/prompt/model/kind
  chats.js         chat CRUD; list() CACHED (invalidate() on every write); search(query) title+body+snippet; project_id; setProject
  projects.js      projects.json; add(name,parentId)/rename/remove(cascade); one-level nesting enforced
  model-download.js HF download w/ redirects; friendly 401/403; deleteModel uses findInstalledFile
  backbones.js     BackBonesSession: X25519 ephemeral + AES-256-GCM; in-RAM only; close() zeroises keys
  web-server.js    HTTP server for browser/PWA; STATIC_CACHE (in-mem); bones-session cookie auth; WebSocketServer at /ws/backbones; setBackBonesHandler

src/renderer/
  index.html       single page; tabs: Chat/Work/Absorb/Brain/BackBones/Settings/About; mobile bottom-nav (7 cols)
  renderer.js      ~2800 LOC, all UI logic; showInput()+showContextMenu() (Electron has no prompt); rAF-coalesced streaming bubble
  bones-http.js    HTTP/SSE transport when served to a browser; host-only stubs for desktop-only features
  styles.css       dark navy/cyan theme; ~1500 LOC
  icons/           GEOMETRIC svg skull (icon.svg) + generated PNGs. Source of inline skull = <symbol id="skull-svg"> in index.html
  manifest.webmanifest  PWA
scripts/make-icons.js   regenerates all icons from the geometric SVG (sharp). Run: node scripts/make-icons.js
build/icon.png          1024 macOS app icon (rounded skull) → electron-builder makes .icns
```

## Feature inventory (what exists, by tab)

- **Chat** — local-model streaming chat. Persistent history. Context-window meter at top (fresh/warm/tired/spent). **Ask Claude →** button (⌘⇧↩): redacts the whole convo, sends multi-turn to Claude, re-identifies the reply live, tags bubble in **Claude orange** with a spinning **Claude scintilla** (star) instead of the skull. Local replies tagged with active model id.
- **Work** — drop files (dup-detection: Replace/Keep both/Cancel). Summarise / Compact. **Find documents** (semantic). **Redact & send to Claude** (the "cannon"): regex+model redaction → review editable box → prompt library → stream → auto re-identify. Loaded-files card with per-row remove.
- **Absorb** — own tab + own dropzone. Extract facts from docs → review modal (tick to keep) → save to Memory with source attribution. Partial-on-cancel.
- **Brain** — research-prompt engine. Question → local model engineers a structured prompt → editable → send to Claude → brief streams in → save. List/compose/detail views. Saved briefs carry question+prompt+model+body.
- **BackBones** (v2.15.0) — encrypted ephemeral P2P chat between two BonesAI instances over Tailscale. X25519+AES-256-GCM, fresh keys/session, nothing persisted, terminal-style UI, verification fingerprint, 30-min idle timeout. Host-only (needs WS server).
- **Settings** — sub-nav PILLS act as tabs (one card shown at a time): Memory / Model / Performance / Models / Claude API / Sharing / Help & FAQ / Diagnostics. Memory (teach + iCloud toggle). Performance (context window). Available models (download/activate/delete + Re-scan + Open folder). Claude API key. Network sharing (token, localhost/LAN, URLs). Help & FAQ (accordion). Diagnostics (log tail + **Export log**).
- **About** — own top-level tab. Skull, version (live from app.getVersion), Founder portrait (`src/renderer/about/winston.jpg`), credits: Authored by Winston Green / Property of WNSTNGRN Ltd / All rights reserved © 2026.

## Models in the registry (config.js MODELS)

phi-3.5-mini, qwen-7b (default), **saul-7b** (legal, TheBloke ungated GGUF), qwen-14b, qwen-32b.
- HuggingFace is FIREWALLED in the build env — can't verify model URLs here. If a download 404/401s, user pastes the working GGUF URL and we patch config.js.
- `findInstalledFile()` scans the models folder for any `.gguf` matching the id tokens, so a manually-dropped file with a different name still gets detected (+ "Re-scan models folder" button + "Open folder").

## User state / hardware / preferences

- **Macs**: 2014 MBP (original host) and **2019 MBP 15" i9 8C/16T, 16 GB, Intel UHD 630, Sonoma 14.3.1** (current main). Both x64/AVX2/CPU-only. v2.6.0 auto-tunes: 16K context + 8 threads on the i9.
- **iPhone 16 Plus** (not Pro), iOS 18 — PWA install works (Add to Home Screen).
- Wants: iPhone + friend access. Plans an always-on Mac eventually (parked).
- **Claude API key persists** across installs (lives in config.json under userData, not the app bundle). Same for chats/brain/memory/models.
- **Aesthetic**: dark navy + cyan. Claude features = Claude **orange** (#d97757), NOT purple (user flagged purple as wrong). Logos are the GEOMETRIC SVG skull — user rejected the photographic Gemini artwork (had a grey box, looked bad). Folder open=filled, closed=outline.
- Legal practitioner (UK). Uses Bones for legal research/document work. Decided **against RAG**. Fine-tuning isn't feasible on Intel Mac (told them; Absorb is the local alternative).

## Open threads / parked

- Tailscale: user laid the groundwork but not confirmed installed. BackBones needs it for cross-internet.
- v2.15.0 BackBones not yet field-tested by user (needs a friend + both on Tailscale).
- Always-on Mac purchase — parked.
- Possible future: Work/Absorb over web (currently host-only), push notifications for long jobs, Tailscale auto-detect in Sharing UI.

## Working style the user likes

- Ship a real downloadable build for almost every change; give the SHA-pinned raw link + verify HTTP 200.
- Be honest about tradeoffs and limits (esp. privacy/security claims — never overstate).
- Test new main-process modules with a quick node script before shipping.
- Tight, focused commits with thorough multi-paragraph messages.
- Short chat replies; longer only when shipping/explaining a release.
- Update THIS file when context runs low.
