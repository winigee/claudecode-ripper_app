// Shared memory for BonesAI.
//
// "Memory" is a list of things the user has taught Bones — facts, preferences,
// standing instructions. Unlike Brain (which stores saved outputs you look at),
// memory is injected into the system prompt of *every* local model, so whatever
// you teach one model, all of them benefit from — Qwen, Saul, Phi, whatever is
// loaded.
//
// Storage location is either the app's local userData, or — if the user turns
// it on — a folder in iCloud Drive. Putting it in iCloud means every Mac you
// run BonesAI on reads and writes the same memory file, so teaching Bones on
// one machine shows up on the others (and the file is reachable from the Files
// app on iPhone/iPad too). Model files stay local; only this small JSON syncs.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const FILE = 'memory.json';
const ICLOUD_FOLDER = 'BonesAI';

// ~/Library/Mobile Documents/com~apple~CloudDocs is the on-disk home of iCloud
// Drive on macOS. If it exists, the user has iCloud Drive enabled.
function iCloudBase() {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}
function iCloudAvailable() {
  try {
    return fs.existsSync(iCloudBase());
  } catch (_) {
    return false;
  }
}
function iCloudDir() {
  return path.join(iCloudBase(), ICLOUD_FOLDER);
}

function localPath() {
  return path.join(app.getPath('userData'), FILE);
}
function iCloudPath() {
  return path.join(iCloudDir(), FILE);
}

function readFlag() {
  // We stash the iCloud preference inside the memory config via the main
  // config.json so it persists. Avoid a circular require by reading the file
  // directly here.
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    return !!cfg.memory_icloud;
  } catch (_) {
    return false;
  }
}
function writeFlag(on) {
  const p = path.join(app.getPath('userData'), 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  cfg.memory_icloud = !!on;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// The file we actually read/write right now.
function activePath() {
  if (readFlag() && iCloudAvailable()) return iCloudPath();
  return localPath();
}

function readStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.entries)) return data;
  } catch (_) {}
  return { version: 1, entries: [] };
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function list() {
  return readStore(activePath()).entries;
}

function add(text) {
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty' };
  const file = activePath();
  const store = readStore(file);
  const entry = { id: newId(), text: clean, created_at: new Date().toISOString() };
  store.entries.push(entry);
  writeStore(file, store);
  return entry;
}

function remove(id) {
  const file = activePath();
  const store = readStore(file);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.id !== id);
  writeStore(file, store);
  return { ok: store.entries.length !== before };
}

// Concatenated memory for prompt injection, newest last, capped so it can't
// blow the context budget.
function injectionText(maxChars = 4000) {
  const entries = list();
  if (entries.length === 0) return '';
  let out = '';
  for (const e of entries) {
    const line = '- ' + e.text.replace(/\s+/g, ' ').trim() + '\n';
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

function getConfig() {
  return {
    icloud: readFlag(),
    icloudAvailable: iCloudAvailable(),
    path: activePath(),
    count: list().length,
  };
}

// Toggle iCloud storage. Migrates the current entries to the new location so
// nothing is lost, then flips the pointer.
function setICloud(on) {
  const want = !!on;
  if (want && !iCloudAvailable()) {
    return { error: 'iCloud Drive not found on this Mac. Enable iCloud Drive in System Settings first.' };
  }
  const from = activePath();
  const fromStore = readStore(from);
  writeFlag(want);
  const to = activePath();
  if (to !== from) {
    // Merge: if the destination already has entries (e.g. another Mac wrote
    // them), keep both, de-duplicated by text.
    const toStore = readStore(to);
    const seen = new Set(toStore.entries.map((e) => e.text.trim().toLowerCase()));
    for (const e of fromStore.entries) {
      if (!seen.has(e.text.trim().toLowerCase())) {
        toStore.entries.push(e);
        seen.add(e.text.trim().toLowerCase());
      }
    }
    writeStore(to, toStore);
  }
  return getConfig();
}

module.exports = { list, add, remove, injectionText, getConfig, setICloud };
