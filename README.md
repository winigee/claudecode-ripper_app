# BonesAI

A personal macOS desktop tool that wraps the Anthropic Claude API for document summarisation and research.

This is the v0.6.0 source rebuild after the previous session became unrecoverable. See the build specification for full background and constraints.

## Target environment

- 2020 Intel Mac, macOS 11.7 Big Sur, x86_64
- Build is x86_64-only (`build-mac.sh`). For Apple Silicon, swap `--x64` for `--arm64` in `package.json` and the build script.

## Stack

- Electron 28.3.3 (Chromium 120, Node 18.18). Pinned to a release line that still officially supports macOS 10.15+ on Intel — Big Sur (11.x) is well within range. Do not upgrade Electron without re-verifying the macOS support floor in the Electron release notes.
- `@anthropic-ai/sdk` for Claude API calls.
- `pdf-parse` (pure JS) and `mammoth` (pure JS) for PDF and DOCX text extraction. No native modules — keeps the Intel build painless and avoids ABI mismatches.
- Brain is a JSON file under macOS Application Support (`~/Library/Application Support/BonesAI/brain.json`). API key lives in the same directory (`config.json`, chmod 600), or in the `ANTHROPIC_API_KEY` env var, never in the app bundle.

## Features

- **Running skeleton** — opens a window, talks to the Claude API. The Settings tab has a "Test connection" button that pings the model and prints the round-trip result.
- **Folder drops** — drag a folder (or files) onto the window. Reads `.txt`, `.md`, `.markdown`, `.rst`, `.json`, `.csv`, `.log` directly; `.pdf` via `pdf-parse`; `.docx` via `mammoth`. Walks subdirectories; caps at 200 files and 5 MB per file.
- **Summarise** — structured summary with `Purpose`, `Key facts`, `Open questions` sections.
- **Compact** — dense digest that preserves facts and drops filler. Suitable for feeding into a next research step.
- **Brain** — persistent local note store. Click "Save to Brain" after a summarise/compact to keep the output across sessions.

## Build on the Mac

On the 2020 Intel Mac, with Node.js 18.x or 20.x installed:

```sh
git clone <this repo>
cd claudecode-ripper_app
npm install
./scripts/build-mac.sh
```

The script produces:

- `dist/mac/BonesAI.app` — the unpacked bundle
- `dist/BonesAI-v0.6.0-mac-x64.app.zip` — the drag-to-Applications zip (made with `ditto`, so the bundle structure and symlinks are preserved correctly)
- `dist/BonesAI-v0.6.0-mac-x64.app.zip.sha256` — checksum, so a truncated or corrupted copy is caught before you try to open it

The script also ad-hoc signs the bundle (`codesign --force --deep --sign -`), which avoids the "damaged and can't be opened" Gatekeeper error on first launch.

## Install

```sh
unzip dist/BonesAI-v0.6.0-mac-x64.app.zip -d /tmp/bonesai
mv /tmp/bonesai/BonesAI.app /Applications/
xattr -cr /Applications/BonesAI.app
open /Applications/BonesAI.app
```

The `xattr -cr` step clears the macOS quarantine attribute applied to files copied between users or downloaded from the web. Ship this instruction with every build until the app is notarised by Apple.

## Run from source (development)

```sh
npm install
npm start
```

## Configuration

- **API key** — paste it into Settings on first run. Stored as plain JSON at `~/Library/Application Support/BonesAI/config.json` with file permissions `0600`. Alternatively, export `ANTHROPIC_API_KEY` before launching the app; the env var takes precedence over the stored key.
- **Model** — choose Sonnet 4.6 (default, balanced), Haiku 4.5 (faster, cheaper), or Opus 4.7 (highest quality) from the Settings tab.

## Privacy posture

BonesAI sends document content to the Anthropic Claude API. That API is a cloud service, billed separately from any Claude.ai subscription. **Do not feed it confidential or privileged material** unless you have separately assessed that your Anthropic API account's commercial terms (no-training, zero-retention if required) are adequate for that content. For confidential material, use the local llama.cpp fallback described in the build specification.

## Layout

```
src/
  main/         # Electron main process
    main.js       — window + IPC handlers
    preload.js    — contextBridge API surface
    claude.js     — Anthropic SDK wrapper (summarise, compact, ping)
    ingest.js     — folder walk + file readers (text, PDF, DOCX)
    brain.js      — persistent JSON note store
    config.js     — API key + model settings
  renderer/     # UI (Chromium)
    index.html
    renderer.js
    styles.css
scripts/
  build-mac.sh  # one-shot Big Sur Intel build
```

## Why these choices, briefly

- **Why not Tauri / Swift WKWebView?** The spec asked for an Electron build pinned to a Big-Sur-compatible version. Electron 28 still supports macOS 10.15+, so the original architecture stands. Switching to Tauri would have meant a stack change without a forcing reason yet.
- **Why no native modules?** `keytar` and `better-sqlite3` are obvious candidates for keychain storage and the Brain, but both require platform-specific prebuilt binaries. Skipping them keeps the x86_64 Big Sur build a single `npm install` away on any Mac, no node-gyp drama. JSON-on-disk is fine for a single-user personal tool.
- **Why ditto for the zip?** macOS `.app` bundles contain symlinks inside `Contents/Frameworks`. The system `zip` command mangles them. `ditto -c -k --sequesterRsrc --keepParent` preserves them correctly.
