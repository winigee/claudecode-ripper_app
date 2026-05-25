The llamafile binary lives here at build time.

To stage it, run: scripts/fetch-llama.sh
(downloads from https://github.com/mozilla-ai/llamafile/releases)

The binary is gitignored. electron-builder picks it up via the
"extraResources" config in package.json and embeds it into the .app
at Contents/Resources/llama-cpp/llamafile.
