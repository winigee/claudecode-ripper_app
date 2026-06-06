const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function chatsDir() {
  const p = path.join(app.getPath('userData'), 'chats');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function chatPath(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('invalid chat id');
  return path.join(chatsDir(), `${id}.json`);
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function titleFromFirstMessage(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const text = (firstUser.content || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function list() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(chatsDir());
  } catch (_) {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(chatsDir(), name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      out.push({
        id: data.id,
        title: data.title || 'Untitled',
        created_at: data.created_at,
        updated_at: data.updated_at,
        project_id: data.project_id || null,
        message_count: Array.isArray(data.messages) ? data.messages.length : 0,
      });
    } catch (_) {
      // skip corrupt file
    }
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return out;
}

// Full-text search across chat titles and message bodies. Returns matching
// chats (same shape as list()) plus a `snippet` showing the matched context.
function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list();
  const out = [];
  let entries;
  try { entries = fs.readdirSync(chatsDir()); } catch (_) { return out; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(chatsDir(), name), 'utf8'));
      const title = (data.title || '').toLowerCase();
      let snippet = '';
      let matched = title.includes(q);
      if (!matched && Array.isArray(data.messages)) {
        for (const m of data.messages) {
          const idx = (m.content || '').toLowerCase().indexOf(q);
          if (idx >= 0) {
            matched = true;
            const start = Math.max(0, idx - 30);
            snippet = (start > 0 ? '…' : '') + m.content.slice(start, idx + q.length + 40).replace(/\s+/g, ' ').trim() + '…';
            break;
          }
        }
      }
      if (matched) {
        out.push({
          id: data.id,
          title: data.title || 'Untitled',
          created_at: data.created_at,
          updated_at: data.updated_at,
          project_id: data.project_id || null,
          message_count: Array.isArray(data.messages) ? data.messages.length : 0,
          snippet,
        });
      }
    } catch (_) {}
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return out;
}

function load(id) {
  try {
    return JSON.parse(fs.readFileSync(chatPath(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function save(chat) {
  const id = chat.id || newId();
  const now = new Date().toISOString();
  // Preserve an existing chat's project assignment if the caller didn't pass
  // one (the renderer save path only sends id + messages).
  let project_id = chat.project_id !== undefined ? chat.project_id : null;
  if (chat.project_id === undefined && chat.id) {
    const existing = load(id);
    if (existing && existing.project_id) project_id = existing.project_id;
  }
  const data = {
    id,
    title: chat.title || titleFromFirstMessage(chat.messages || []),
    created_at: chat.created_at || now,
    updated_at: now,
    project_id,
    messages: chat.messages || [],
  };
  fs.writeFileSync(chatPath(id), JSON.stringify(data, null, 2));
  return data;
}

// Move a chat into a project (or out of one when projectId is null).
function setProject(id, projectId) {
  const data = load(id);
  if (!data) return null;
  data.project_id = projectId || null;
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(chatPath(id), JSON.stringify(data, null, 2));
  return data;
}

function remove(id) {
  try {
    fs.unlinkSync(chatPath(id));
    return true;
  } catch (_) {
    return false;
  }
}

function rename(id, title) {
  const data = load(id);
  if (!data) return null;
  data.title = title;
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(chatPath(id), JSON.stringify(data, null, 2));
  return data;
}

module.exports = { list, search, load, save, remove, rename, setProject, newId, titleFromFirstMessage };
