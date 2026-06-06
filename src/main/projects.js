// Projects — lightweight folders that chats can be filed into.
//
// Stored as a single projects.json in userData. A chat references a project by
// id (chat.project_id); deleting a project just unfiles its chats (they fall
// back to the Unfiled group), it never deletes the chats themselves.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() {
  return path.join(app.getPath('userData'), 'projects.json');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!Array.isArray(data.projects)) data.projects = [];
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return { projects: [] };
    throw err;
  }
}

function save(data) {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function newId() {
  return 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function list() {
  return load().projects.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function add(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return { error: 'empty' };
  const data = load();
  const project = { id: newId(), name: clean, created_at: new Date().toISOString() };
  data.projects.push(project);
  save(data);
  return project;
}

function rename(id, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return { error: 'empty' };
  const data = load();
  const p = data.projects.find((x) => x.id === id);
  if (!p) return { error: 'not found' };
  p.name = clean;
  save(data);
  return p;
}

function remove(id) {
  const data = load();
  const before = data.projects.length;
  data.projects = data.projects.filter((p) => p.id !== id);
  save(data);
  return { ok: data.projects.length !== before };
}

module.exports = { list, add, rename, remove };
