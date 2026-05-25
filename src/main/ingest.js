const fs = require('fs').promises;
const path = require('path');

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.rst', '.json', '.csv', '.log']);
const PDF_EXTS = new Set(['.pdf']);
const DOCX_EXTS = new Set(['.docx']);

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_FOLDER = 200;

async function readTextFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function readPdfFile(filePath) {
  const pdfParse = require('pdf-parse');
  const buf = await fs.readFile(filePath);
  const result = await pdfParse(buf);
  return result.text;
}

async function readDocxFile(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return 'text';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (DOCX_EXTS.has(ext)) return 'docx';
  return null;
}

async function readFile(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    return { path: filePath, skipped: true, reason: `Skipped (>${MAX_FILE_BYTES / 1024 / 1024}MB)` };
  }
  const kind = classify(filePath);
  if (!kind) {
    return { path: filePath, skipped: true, reason: 'Unsupported file type' };
  }
  try {
    let text;
    if (kind === 'text') text = await readTextFile(filePath);
    else if (kind === 'pdf') text = await readPdfFile(filePath);
    else if (kind === 'docx') text = await readDocxFile(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      kind,
      bytes: stat.size,
      text: text || '',
    };
  } catch (err) {
    return { path: filePath, skipped: true, reason: `Read error: ${err.message}` };
  }
}

async function walkFolder(folderPath) {
  const results = [];
  async function recurse(dir) {
    if (results.length >= MAX_FILES_PER_FOLDER) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES_PER_FOLDER) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        if (classify(full)) results.push(full);
      }
    }
  }
  await recurse(folderPath);
  return results;
}

async function ingestPaths(paths) {
  const files = [];
  const skipped = [];
  for (const p of paths) {
    let stat;
    try {
      stat = await fs.stat(p);
    } catch (err) {
      skipped.push({ path: p, reason: err.message });
      continue;
    }
    if (stat.isDirectory()) {
      const found = await walkFolder(p);
      for (const f of found) {
        const r = await readFile(f);
        if (r.skipped) skipped.push(r);
        else files.push(r);
      }
    } else if (stat.isFile()) {
      const r = await readFile(p);
      if (r.skipped) skipped.push(r);
      else files.push(r);
    }
  }
  return { files, skipped };
}

module.exports = { ingestPaths, readFile };
