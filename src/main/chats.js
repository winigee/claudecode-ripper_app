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
        message_count: Array.isArray(data.messages) ? data.messages.length : 0,
      });
    } catch (_) {
      // skip corrupt file
    }
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
  const data = {
    id,
    title: chat.title || titleFromFirstMessage(chat.messages || []),
    created_at: chat.created_at || now,
    updated_at: now,
    messages: chat.messages || [],
  };
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

module.exports = { list, load, save, remove, rename, newId, titleFromFirstMessage };
