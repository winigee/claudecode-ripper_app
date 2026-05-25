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

async function startDownload(onProgress) {
  if (activeDownload) {
    return { error: 'A download is already in progress.' };
  }
  activeDownload = { cancelled: false };

  try {
    // 1) Download llamafile if not already installed (~42 MB).
    if (!config.llamafileInstalled()) {
      const res = await downloadOne({
        url: config.LLAMAFILE_URL,
        dest: config.llamafilePath(),
        expectedMinBytes: 30_000_000,
        onProgress,
        label: 'runtime',
      });
      if (res.cancelled) { activeDownload = null; return { cancelled: true }; }
      if (res.error) { activeDownload = null; return { error: 'Runtime download failed: ' + res.error }; }
      try { fs.chmodSync(config.llamafilePath(), 0o755); } catch (_) {}
    }

    // 2) Download the GGUF model (~4.7 GB).
    if (!config.modelInstalled()) {
      const res = await downloadOne({
        url: config.DEFAULT_MODEL_URL,
        dest: config.modelPath(),
        expectedMinBytes: config.DEFAULT_MODEL_BYTES,
        onProgress,
        label: 'model',
      });
      if (res.cancelled) { activeDownload = null; return { cancelled: true }; }
      if (res.error) { activeDownload = null; return { error: 'Model download failed: ' + res.error }; }
    }

    activeDownload = null;
    return { ok: true };
  } catch (err) {
    activeDownload = null;
    return { error: err.message };
  }
}

function cancelDownload() {
  if (activeDownload) activeDownload.cancelled = true;
  return { ok: true };
}

module.exports = { startDownload, cancelDownload };
