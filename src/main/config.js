const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILENAME = 'config.json';
const DEFAULT_MODEL_FILENAME = 'Qwen2.5-7B-Instruct-Q4_K_M.gguf';
const DEFAULT_MODEL_URL =
  'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf';
const DEFAULT_MODEL_BYTES = 4683074816;

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

function modelsDir() {
  const p = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function modelPath() {
  return path.join(modelsDir(), DEFAULT_MODEL_FILENAME);
}

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
  try {
    fs.chmodSync(p, 0o600);
  } catch (_) {}
}

function modelInstalled() {
  try {
    const st = fs.statSync(modelPath());
    return st.size > 1_000_000_000;
  } catch (_) {
    return false;
  }
}

const LLAMAFILE_VERSION = '0.10.1';
const LLAMAFILE_URL = `https://github.com/mozilla-ai/llamafile/releases/download/${LLAMAFILE_VERSION}/llamafile-${LLAMAFILE_VERSION}-thin`;
const LLAMAFILE_MIN_BYTES = 30_000_000;

function runtimeDir() {
  const p = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function llamafilePath() {
  return path.join(runtimeDir(), 'llamafile');
}

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
  modelInstalled,
  runtimeDir,
  llamafilePath,
  llamafileInstalled,
  DEFAULT_MODEL_FILENAME,
  DEFAULT_MODEL_URL,
  DEFAULT_MODEL_BYTES,
  LLAMAFILE_VERSION,
  LLAMAFILE_URL,
};
