# BonesAI v0.7.0

A local-first macOS desktop tool for document summarisation and research.

All inference runs on the Mac via `llama.cpp` + Qwen2.5-7B-Instruct. Nothing leaves the machine during ordinary use. Cloud calls to the Claude API are not present in this version — they will return in v0.8.0, gated behind an explicit per-request anonymisation review step.

## Target environment

- 2020 Intel Mac, macOS 11.7 Big Sur, x86_64
- Build is x86_64-only.

## Stack

- Electron 28.3.3 (Chromium 120, Node 18.18). Pinned for macOS 10.15+ support.
- `llama.cpp` (your existing local build), spawned as a child process by the main process. Listens on `127.0.0.1` only, on a randomly chosen port.
- Qwen2.5-7B-Instruct Q4_K_M GGUF (~4.7 GB). Downloaded on first run from Hugging Face (bartowski's repackaging) into `~/Library/Application Support/BonesAI/models/`. Not bundled in the `.app`.
- `pdf-parse` + `mammoth` for PDF and DOCX text extraction. No native modules.
- Brain notes persist as JSON under Application Support.

## Build on the Mac

You need llama.cpp built somewhere this Mac can find — `~/llama.cpp/build/bin/llama-server` is the default search path (`fetch-llama.sh` also checks `../llama.cpp/`, `$LLAMA_CPP_DIR`, and a Homebrew install).

If you haven't built llama.cpp yet:

```sh
cd ~/llama.cpp     # or wherever you have the source
mkdir -p build && cd build
cmake ..
cmake --build . --config Release -j
```

Then build BonesAI:

```sh
cd ~/wherever/claudecode-ripper_app
npm install
./scripts/build-mac.sh
```

The build script:
1. Runs `npm install` if needed
2. Calls `scripts/fetch-llama.sh` to copy `llama-server` and its dylibs into `vendor/llama-cpp/`
3. Runs `electron-builder --mac --x64`, which embeds `vendor/llama-cpp/` into the `.app` at `Contents/Resources/llama-cpp/`
4. Ad-hoc codesigns the `.app`
5. Packages with `ditto` (preserves bundle symlinks correctly)
6. Emits a SHA-256 checksum alongside the zip

## Install

```sh
unzip dist/BonesAI-v0.7.0-mac-x64.app.zip -d /tmp/bonesai
mv /tmp/bonesai/BonesAI.app /Applications/
xattr -cr /Applications/BonesAI.app
open /Applications/BonesAI.app
```

## First run

The app detects the missing model file and shows a setup screen. Click **Download model**. A 4.7 GB download starts from Hugging Face with a progress bar. On completion, `llama-server` spins up automatically and the main UI becomes active.

Second launch onward: straight into the UI, no setup screen.

## Features

- **Drag-and-drop ingest** — folders or individual files. Reads `.txt`, `.md`, `.markdown`, `.rst`, `.json`, `.csv`, `.log`, `.pdf`, `.docx`. Walks subdirectories. Capped at 200 files and 5 MB per file.
- **Summarise** — structured summary with `Purpose`, `Key facts`, `Open questions` sections. Streams tokens as the local model generates them.
- **Compact** — dense digest that preserves facts and drops filler.
- **Brain** — persistent local note store; click "Save to Brain" after any run.
- **Cancel** — stop a run mid-stream if it's taking too long or going off-track.
- **Diagnostics** — Settings tab shows the llama-server log tail for troubleshooting.

## Performance expectations

On a 2020 Intel Mac with Qwen2.5-7B Q4_K_M at 8K context:
- Cold start (model load): ~10-30 seconds, first launch each session.
- Inference: ~5-10 tokens/second on CPU. A typical summary takes 30-90 seconds.
- RAM: ~6 GB resident when the model is loaded.

If this is too slow on your hardware, the smaller Phi-3.5-mini (Q4_K_M, ~2.4 GB) can be dropped into the same `models/` directory and pointed at via a future Settings option — not yet exposed in v0.7.0.

## Privacy posture

No outbound network connections are made during inference. The only network use is:
- The one-time model download from Hugging Face on first run.
- Optional Hugging Face check for newer model files (not implemented in v0.7.0).

The `llama-server` child process binds to `127.0.0.1` only. The Electron renderer is `contextIsolation: true, nodeIntegration: false, sandbox: false`, with a CSP that restricts to `'self'` origins.

This is suitable for confidential and privileged material, subject to your own diligence on the model weights and llama.cpp binary.

## What's next — v0.8.0

The original spec's cloud path returns as an explicit, gated action. Pseudocode:

1. User clicks "Summarise with Claude" (only enabled if an Anthropic API key is configured).
2. Local Qwen scans the input and proposes redactions: people, organisations, dates, locations, identifiers — each replaced with placeholder tokens (`[PERSON_1]`, `[ORG_2]`).
3. The renderer shows a diff: original vs redacted, plus the entity map. Nothing has left the Mac yet.
4. User approves, edits, or cancels.
5. On approve: redacted text goes to Claude. Response comes back. Placeholders are reversed locally so it's readable.

The invariant is that no content leaves the Mac unless the user has seen exactly what would leave and clicked Approve.

## Layout

```
src/
  main/
    main.js              — Electron main: window, IPC, lifecycle
    preload.js           — contextBridge API
    llama-server.js      — child process manager for llama-server
    llama.js             — HTTP client + streaming + prompts
    model-download.js    — first-run Hugging Face fetch
    config.js            — paths and model metadata
    ingest.js            — folder walk + readers (text, PDF, DOCX)
    brain.js             — persistent JSON note store
  renderer/              — UI (Chromium)
scripts/
  fetch-llama.sh         — stages llama-server + dylibs from local build
  build-mac.sh           — one-shot Big Sur Intel build
build/
  icon.png               — optional 1024x1024 app icon (not checked in)
vendor/
  llama-cpp/             — staged llama-server binary (not checked in)
```

## Why these choices

- **Electron over Tauri / Swift** — the spec asked for an Electron build on Big Sur, and Electron 28 still supports macOS 10.15+. No reason to rip out the shell.
- **External llama.cpp over a Node binding** — `node-llama-cpp` has native bindings that complicate the cross-version build story on Intel + Big Sur. Spawning the official `llama-server` as a child process is the simplest, most debuggable path, and is what the original spec's Appendix described.
- **No native modules** — `pdf-parse`, `mammoth`, JSON-on-disk for everything. The whole runtime dependency tree is pure JavaScript.
- **Model not in bundle** — 4.7 GB GGUF would balloon every release zip and re-download on every update. First-run fetch with a progress bar is the standard pattern.
- **Streaming output** — local CPU inference is slow enough that a blank-screen-then-wall-of-text feels broken. Streaming tokens makes the latency feel like work-in-progress rather than a freeze.
