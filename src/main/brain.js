const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BRAIN_FILENAME = 'brain.json';

function brainPath() {
  return path.join(app.getPath('userData'), BRAIN_FILENAME);
}

function load() {
  try {
    const raw = fs.readFileSync(brainPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.notes)) data.notes = [];
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { notes: [] };
    throw err;
  }
}

function save(data) {
  const p = brainPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function listNotes() {
  return load().notes;
}

function addNote({ title, body, source, question, prompt, model, kind }) {
  const data = load();
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    created_at: new Date().toISOString(),
    title: title || 'Untitled',
    body: body || '',
    source: source || null,
  };
  // Optional structured-brief fields. Notes without these stay readable as
  // plain notes — backwards-compatible with anything saved before v2.10.0.
  if (kind) note.kind = kind;
  if (question) note.question = question;
  if (prompt) note.prompt = prompt;
  if (model) note.model = model;
  data.notes.push(note);
  save(data);
  return note;
}

function deleteNote(id) {
  const data = load();
  const before = data.notes.length;
  data.notes = data.notes.filter((n) => n.id !== id);
  save(data);
  return data.notes.length !== before;
}

function clear() {
  save({ notes: [] });
}

module.exports = { listNotes, addNote, deleteNote, clear, brainPath };
