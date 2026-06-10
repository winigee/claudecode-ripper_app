const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const config = require('./config');

let activeDownload = null;

function followRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const tryFetch = (currentUrl, redirectsLeft) => {
      const req = https.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            return reject(new Error('Too many redirects'));
          }
          res.resume();
          const next = new URL(res.headers.location, currentUrl).toString();
          return tryFetch(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(
              `HTTP ${res.statusCode} — this HuggingFace repo requires you to be logged in `
              + 'or to accept its terms. Try a different model, or open the URL in a browser to '
              + 'see what it needs.'
            ));
          }
          return reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`));
        }
        resolve(res);
      });
      req.on('error', reject);
    };
    tryFetch(url, maxRedirects);
  });
}

async function downloadOne({ url, dest, expectedMinBytes, onProgress, label }) {
  const tmp = dest + '.part';
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  let received = 0;
  let total = expectedMinBytes;
  let lastEmit = 0;

  const res = await followRedirects(url);
  if (res.headers['content-length']) {
    total = parseInt(res.headers['content-length'], 10) || total;
  }

  const out = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      if (activeDownload && activeDownload.cancelled) {
        res.destroy(new Error('cancelled'));
        out.destroy();
        return;
      }
      received += chunk.length;
      out.write(chunk);
      const now = Date.now();
      if (now - lastEmit > 400) {
        lastEmit = now;
        if (onProgress) onProgress({ label, received, total, pct: total ? received / total : 0 });
      }
    });
    res.on('end', () => out.end(resolve));
    res.on('error', reject);
    out.on('error', reject);
  });

  if (activeDownload && activeDownload.cancelled) {
    await fsp.unlink(tmp).catch(() => {});
    return { cancelled: true };
  }

  if (received < expectedMinBytes * 0.95) {
    await fsp.unlink(tmp).catch(() => {});
    return { error: `Download truncated: ${received} of ~${expectedMinBytes} bytes.` };
  }

  await fsp.rename(tmp, dest);
  if (onProgress) onProgress({ label, received, total: received, pct: 1 });
  return { ok: true, bytes: received, path: dest };
}

async function ensureLlamafile(onProgress) {
  if (config.llamafileInstalled()) return { ok: true, skipped: true };
  const res = await downloadOne({
    url: config.LLAMAFILE_URL,
    dest: config.llamafilePath(),
    expectedMinBytes: 30_000_000,
    onProgress,
    label: 'runtime',
  });
  if (res.ok) {
    try { fs.chmodSync(config.llamafilePath(), 0o755); } catch (_) {}
  }
  return res;
}

async function downloadModel(modelId, onProgress) {
  const m = config.findModel(modelId);
  if (!m) return { error: `Unknown model id: ${modelId}` };
  if (config.isModelInstalled(modelId)) return { ok: true, skipped: true };

  if (activeDownload) return { error: 'A download is already in progress.' };
  activeDownload = { cancelled: false };

  try {
    const runtimeRes = await ensureLlamafile(onProgress);
    if (runtimeRes.cancelled) { activeDownload = null; return { cancelled: true }; }
    if (runtimeRes.error) { activeDownload = null; return { error: 'Runtime: ' + runtimeRes.error }; }

    const modelRes = await downloadOne({
      url: m.url,
      dest: config.modelPath(modelId),
      expectedMinBytes: m.minBytes,
      onProgress,
      label: 'model',
    });
    activeDownload = null;
    if (modelRes.cancelled) return { cancelled: true };
    if (modelRes.error) return { error: 'Model: ' + modelRes.error };
    config.invalidateModelScan(); // new file on disk — drop the scan cache
    return { ok: true, modelId };
  } catch (err) {
    activeDownload = null;
    return { error: err.message };
  }
}

async function deleteModel(modelId) {
  const m = config.findModel(modelId);
  if (!m) return { error: 'Unknown model id' };
  // Delete whatever file is actually serving this model — could be the
  // canonical filename or a user-dropped one.
  const actual = config.activeModelPathFor
    ? config.activeModelPathFor(modelId)
    : null;
  const target = (typeof config.findInstalledFile === 'function'
    ? config.findInstalledFile(modelId)
    : null) || config.modelPath(modelId);
  try {
    fs.unlinkSync(target);
    config.invalidateModelScan(); // file gone — drop the scan cache
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true };
    return { error: err.message };
  }
}

function cancelDownload() {
  if (activeDownload) activeDownload.cancelled = true;
  return { ok: true };
}

// Back-compat: existing setup screen calls modelDownload() with no args. Route
// to recommended-model download.
async function startDownload(onProgress) {
  const recommended = config.getActiveModelId() || config.recommendModelId();
  return downloadModel(recommended, onProgress);
}

module.exports = { startDownload, downloadModel, deleteModel, cancelDownload };
