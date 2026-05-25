const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_FILENAME = 'config.json';

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return JSON.parse(raw);
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

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const cfg = readConfig();
  return cfg.anthropic_api_key || null;
}

function setApiKey(key) {
  const cfg = readConfig();
  if (key) cfg.anthropic_api_key = key;
  else delete cfg.anthropic_api_key;
  writeConfig(cfg);
}

function getModel() {
  const cfg = readConfig();
  return cfg.model || 'claude-sonnet-4-6';
}

function setModel(model) {
  const cfg = readConfig();
  cfg.model = model;
  writeConfig(cfg);
}

module.exports = { getApiKey, setApiKey, getModel, setModel };
