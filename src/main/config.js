const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const CONFIG_FILENAME = 'config.json';

// --- Model registry ---

const MODELS = [
  {
    id: 'phi-3.5-mini',
    name: 'Phi-3.5 Mini Instruct',
    short: 'phi-3.5-mini',
    sizeLabel: '2.4 GB',
    filename: 'Phi-3.5-mini-instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
    bytes: 2393232416,
    minBytes: 2_200_000_000,
    minRamGB: 6,
    notes: 'Fastest. Smaller, weaker at long reasoning. Good for older Macs and quick chat.',
  },
  {
    id: 'qwen-7b',
    name: 'Qwen2.5 7B Instruct',
    short: 'qwen-7b',
    sizeLabel: '4.7 GB',
    filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    bytes: 4683074816,
    minBytes: 4_400_000_000,
    minRamGB: 10,
    notes: 'Balanced quality. Sweet spot on 16 GB Macs.',
  },
  {
    id: 'qwen-14b',
    name: 'Qwen2.5 14B Instruct',
    short: 'qwen-14b',
    sizeLabel: '8.8 GB',
    filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    bytes: 8988111584,
    minBytes: 8_500_000_000,
    minRamGB: 16,
    appleSiliconRecommended: true,
    notes: 'Higher quality. Real CPU/RAM appetite. Apple Silicon recommended.',
  },
  {
    id: 'qwen-32b',
    name: 'Qwen2.5 32B Instruct',
    short: 'qwen-32b',
    sizeLabel: '20 GB',
    filename: 'Qwen2.5-32B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF/resolve/main/Qwen2.5-32B-Instruct-Q4_K_M.gguf',
    bytes: 19851351776,
    minBytes: 19_000_000_000,
    minRamGB: 28,
    appleSiliconRecommended: true,
    notes: 'Best quality. Needs 32 GB+ RAM and Apple Silicon to be usable.',
  },
];

function findModel(id) {
  return MODELS.find((m) => m.id === id);
}

// --- Paths ---

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}
function modelsDir() {
  const p = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function modelPath(idOrFilename) {
  const m = findModel(idOrFilename);
  return path.join(modelsDir(), m ? m.filename : idOrFilename);
}
function runtimeDir() {
  const p = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function llamafilePath() {
  return path.join(runtimeDir(), 'llamafile');
}

// --- Settings file ---

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}
function writeConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

// --- Hardware detection & recommendation ---

function detectHardware() {
  const ramBytes = os.totalmem();
  const ramGB = Math.round(ramBytes / 1024 / 1024 / 1024);
  // arch: 'x64' (Intel) | 'arm64' (Apple Silicon)
  return { ramGB, arch: process.arch, cpus: os.cpus().length };
}

// --- Context window (n_ctx for llamafile) ---
//
// llamafile's RAM appetite scales noticeably with context: a 7B model at 16K
// context allocates ~1.6 GB of KV cache on top of the weights, ~3 GB at 32K.
// We default by RAM so a 16 GB machine gets useful headroom for document work
// without crashing low-memory Macs.

const CONTEXT_CHOICES = [4096, 8192, 16384, 32768];

function defaultContext() {
  const { ramGB } = detectHardware();
  if (ramGB >= 32) return 16384;   // bigger contexts hurt token speed even with RAM
  if (ramGB >= 16) return 16384;
  if (ramGB >= 12) return 8192;
  return 4096;
}

function getContext() {
  const cfg = readConfig();
  const v = Number(cfg.context);
  if (CONTEXT_CHOICES.includes(v)) return v;
  return defaultContext();
}

function setContext(n) {
  const v = Number(n);
  if (!CONTEXT_CHOICES.includes(v)) throw new Error(`unsupported context: ${n}`);
  const cfg = readConfig();
  cfg.context = v;
  writeConfig(cfg);
  return v;
}

// Physical-core count is the right thread default for llama.cpp on x86 — more
// threads via hyper-threading typically hurt due to cache contention. macOS
// reports logical cores from os.cpus(), so we halve it.
function defaultThreads() {
  return Math.max(2, Math.floor(detectHardware().cpus / 2));
}

function recommendModelId() {
  const { ramGB, arch } = detectHardware();
  const isAppleSilicon = arch === 'arm64';
  if (ramGB >= 32 && isAppleSilicon) return 'qwen-14b'; // 32b too slow even on M-series; 14b safer default
  if (ramGB >= 16 && isAppleSilicon) return 'qwen-14b';
  if (ramGB >= 16 && !isAppleSilicon) return 'qwen-7b';
  if (ramGB >= 12) return 'qwen-7b';
  return 'phi-3.5-mini';
}

// --- Installed-model checks ---

function isModelInstalled(id) {
  const m = findModel(id);
  if (!m) return false;
  try {
    const st = fs.statSync(modelPath(id));
    return st.size > m.minBytes;
  } catch (_) {
    return false;
  }
}

function listModels() {
  return MODELS.map((m) => ({
    ...m,
    installed: isModelInstalled(m.id),
    path: modelPath(m.id),
  }));
}

// --- Active model: which is currently selected ---

function getActiveModelId() {
  const cfg = readConfig();
  if (cfg.active_model && findModel(cfg.active_model)) return cfg.active_model;
  // Migration: if there's a previously-installed model with no explicit choice,
  // pick the first one we find installed.
  for (const m of MODELS) {
    if (isModelInstalled(m.id)) return m.id;
  }
  return recommendModelId();
}
function setActiveModelId(id) {
  if (!findModel(id)) throw new Error(`unknown model id: ${id}`);
  const cfg = readConfig();
  cfg.active_model = id;
  writeConfig(cfg);
}

// --- Convenience for legacy callers ---

function activeModelPath() {
  return modelPath(getActiveModelId());
}
function modelInstalled() {
  return isModelInstalled(getActiveModelId());
}

// --- llamafile ---

const LLAMAFILE_VERSION = '0.10.1';
const LLAMAFILE_URL = `https://github.com/mozilla-ai/llamafile/releases/download/${LLAMAFILE_VERSION}/llamafile-${LLAMAFILE_VERSION}-thin`;
const LLAMAFILE_MIN_BYTES = 30_000_000;

function llamafileInstalled() {
  try {
    const st = fs.statSync(llamafilePath());
    return st.size > LLAMAFILE_MIN_BYTES;
  } catch (_) {
    return false;
  }
}

module.exports = {
  readConfig,
  writeConfig,
  modelsDir,
  modelPath,
  activeModelPath,
  modelInstalled,
  runtimeDir,
  llamafilePath,
  llamafileInstalled,
  listModels,
  findModel,
  getActiveModelId,
  setActiveModelId,
  isModelInstalled,
  recommendModelId,
  detectHardware,
  getContext,
  setContext,
  defaultContext,
  defaultThreads,
  CONTEXT_CHOICES,
  MODELS,
  LLAMAFILE_VERSION,
  LLAMAFILE_URL,
};
