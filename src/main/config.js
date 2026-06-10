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
    id: 'saul-7b',
    name: 'SaulLM 7B Instruct (legal)',
    short: 'saul-7b',
    sizeLabel: '4.4 GB',
    filename: 'saul-instruct-v1.Q4_K_M.gguf',
    url: 'https://huggingface.co/TheBloke/Saul-Instruct-v1-GGUF/resolve/main/saul-instruct-v1.Q4_K_M.gguf',
    bytes: 4368439584,
    minBytes: 4_000_000_000,
    minRamGB: 10,
    notes: 'Legal-domain model (Mistral-7B base, trained on contracts/case law/statutes). Fluent in legalese. Verify output — local models still hallucinate citations.',
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
// Remember which directories we've already ensured this process, so the hot
// modelsDir()/runtimeDir() calls don't issue an mkdirSync syscall every time.
const _ensuredDirs = new Set();
function ensureDir(p) {
  if (!_ensuredDirs.has(p)) {
    fs.mkdirSync(p, { recursive: true });
    _ensuredDirs.add(p);
  }
  return p;
}
function modelsDir() {
  return ensureDir(path.join(app.getPath('userData'), 'models'));
}
function modelPath(idOrFilename) {
  const m = findModel(idOrFilename);
  return path.join(modelsDir(), m ? m.filename : idOrFilename);
}
function runtimeDir() {
  return ensureDir(path.join(app.getPath('userData'), 'runtime'));
}
function llamafilePath() {
  return path.join(runtimeDir(), 'llamafile');
}

// --- Settings file ---
//
// config.json is read on many code paths (status(), memory flags, web/api
// settings…). Cache the parsed object in memory so repeated reads don't hit
// disk; writeConfig refreshes the cache. The contract: callers treat the
// returned object as read-modify-write and call writeConfig when they change
// it — they never mutate it and leave it unsaved.

let _configCache = null;
function readConfig() {
  if (_configCache) return _configCache;
  try {
    _configCache = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') { _configCache = {}; return _configCache; }
    throw err;
  }
  return _configCache;
}
function writeConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  _configCache = cfg; // keep the cache coherent with what we just wrote
}

// --- Hardware detection & recommendation ---

// Hardware doesn't change at runtime, so detect once and reuse. Saves an
// os.cpus() + os.totalmem() pair on every status()/runtime query.
let _hwCache = null;
function detectHardware() {
  if (_hwCache) return _hwCache;
  const ramGB = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  // arch: 'x64' (Intel) | 'arm64' (Apple Silicon)
  _hwCache = { ramGB, arch: process.arch, cpus: os.cpus().length };
  return _hwCache;
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
//
// We want two flows to both work:
//   1. The in-app downloader writes to the canonical filename (m.filename) in
//      the models dir. Simple, one exact path.
//   2. The user downloads a .gguf manually from HuggingFace and drops it in
//      the models folder. The filename varies wildly across uploaders
//      (Saul-7B-Instruct-v1.Q4_K_M.gguf vs saul-7b-instruct-v1-q4_k_m.gguf
//      vs mobeetle's repo conventions, etc).
//
// So: first try the canonical path; if nothing's there, scan the folder for
// any .gguf whose lowercased name contains all the distinguishing tokens of
// the model id (e.g. ["saul", "7b"] for saul-7b). Returns the real on-disk
// path so llama-server gets pointed at whatever's actually there.

function modelMatchTokens(id) {
  return String(id).toLowerCase()
    .split(/[-_.]/)
    .filter((t) => t.length >= 2);
}

// The model folder is scanned (readdir + per-file stat) on every status(),
// listModels(), getActiveModelId() and activeModelPath() — i.e. constantly.
// Cache the resolved path per id for a short window so a burst of those calls
// shares one disk scan. The contents only change on download/delete/manual
// drop; the first two call invalidateModelScan(), the last is picked up
// within the TTL or via the "Re-scan models folder" button.
const MODEL_SCAN_TTL_MS = 3000;
let _modelScan = { at: 0, byId: new Map() };
function invalidateModelScan() { _modelScan = { at: 0, byId: new Map() }; }

function findInstalledFile(id) {
  const now = Date.now();
  if (now - _modelScan.at > MODEL_SCAN_TTL_MS) _modelScan = { at: now, byId: new Map() };
  if (_modelScan.byId.has(id)) return _modelScan.byId.get(id);

  const result = _resolveInstalledFile(id);
  _modelScan.byId.set(id, result);
  return result;
}

function _resolveInstalledFile(id) {
  const m = findModel(id);
  if (!m) return null;
  // 1. Canonical filename
  const canonical = path.join(modelsDir(), m.filename);
  try {
    const st = fs.statSync(canonical);
    if (st.size > m.minBytes) return canonical;
  } catch (_) {}
  // 2. Scan for any .gguf containing all the id tokens, big enough
  const tokens = modelMatchTokens(id);
  let entries;
  try { entries = fs.readdirSync(modelsDir()); } catch (_) { return null; }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    const lc = name.toLowerCase();
    if (!tokens.every((t) => lc.includes(t))) continue;
    const full = path.join(modelsDir(), name);
    try {
      const st = fs.statSync(full);
      if (st.size > m.minBytes) return full;
    } catch (_) {}
  }
  return null;
}

function isModelInstalled(id) {
  return !!findInstalledFile(id);
}

function listModels() {
  return MODELS.map((m) => {
    const installedPath = findInstalledFile(m.id);
    return {
      ...m,
      installed: !!installedPath,
      path: installedPath || modelPath(m.id),
      installedPath, // null if not installed; differs from canonical when user dropped a file
    };
  });
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
  const id = getActiveModelId();
  return findInstalledFile(id) || modelPath(id);
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
  findInstalledFile,
  invalidateModelScan,
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
