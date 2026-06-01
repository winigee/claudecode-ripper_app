// JSON-file backed data store. Zero dependencies, in the spirit of BonesAI's
// "JSON on disk for everything". The whole database is one object held in
// memory and flushed to data/db.json on every write. Fine for a prototype;
// swap for SQLite/Postgres when this needs concurrency.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const COLLECTIONS = [
  'clients',
  'matters',
  'documents',
  'events',     // deadlines, hearings, tasks
  'intake',     // inbound email / new-business enquiries
  'timeEntries',
  'notes',      // matter notes / "brain"
  'activity',   // audit log of agent + user actions
];

let db = null;

function emptyDb() {
  const out = { _meta: { createdAt: new Date().toISOString(), seq: {} } };
  for (const c of COLLECTIONS) out[c] = [];
  return out;
}

function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
      if (!db._meta) db._meta = { seq: {} };
      if (!db._meta.seq) db._meta.seq = {};
      return db;
    }
  } catch (e) {
    console.error('[db] failed to read, starting fresh:', e.message);
  }
  db = emptyDb();
  return db;
}

let flushTimer = null;
function flush() {
  if (!db) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
// Debounced flush so a burst of writes hits disk once.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 50);
}

function id(prefix) {
  load();
  const seq = (db._meta.seq[prefix] || 0) + 1;
  db._meta.seq[prefix] = seq;
  return `${prefix}_${String(seq).padStart(4, '0')}`;
}

function all(collection) {
  load();
  return db[collection] || [];
}

function get(collection, recordId) {
  return all(collection).find((r) => r.id === recordId) || null;
}

function where(collection, predicate) {
  return all(collection).filter(predicate);
}

function insert(collection, record) {
  load();
  const now = new Date().toISOString();
  const recordId = record.id || id(collection.slice(0, 3));
  const row = { createdAt: now, updatedAt: now, ...record, id: recordId };
  db[collection].push(row);
  scheduleFlush();
  return row;
}

function update(collection, recordId, patch) {
  load();
  const row = get(collection, recordId);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  scheduleFlush();
  return row;
}

function remove(collection, recordId) {
  load();
  const before = db[collection].length;
  db[collection] = db[collection].filter((r) => r.id !== recordId);
  scheduleFlush();
  return db[collection].length < before;
}

// Append-only activity / audit log. Used by agents to record what they did.
function logActivity(entry) {
  return insert('activity', { ts: new Date().toISOString(), ...entry });
}

// Small key/value settings bag in _meta (e.g. configured TheWatcher URL).
function getSetting(key, def = null) {
  load();
  if (!db._meta.settings) db._meta.settings = {};
  return key in db._meta.settings ? db._meta.settings[key] : def;
}
function setSetting(key, val) {
  load();
  if (!db._meta.settings) db._meta.settings = {};
  db._meta.settings[key] = val;
  scheduleFlush();
  return val;
}

function reset() {
  db = emptyDb();
  flush();
  return db;
}

module.exports = {
  COLLECTIONS, DATA_DIR, DB_FILE,
  load, flush, reset, id,
  all, get, where, insert, update, remove, logActivity,
  getSetting, setSetting,
};
