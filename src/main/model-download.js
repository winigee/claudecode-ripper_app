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

async function startDownload(onProgress) {
  if (activeDownload) {
    return { error: 'A download is already in progress.' };
  }

  const dest = config.modelPath();
  const tmp = dest + '.part';
  const url = config.DEFAULT_MODEL_URL;
  const expectedBytes = config.DEFAULT_MODEL_BYTES;

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  activeDownload = { cancelled: false };

  let received = 0;
  let total = expectedBytes;
  let lastEmit = 0;

  try {
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
        if (now - lastEmit > 500) {
          lastEmit = now;
          if (onProgress) onProgress({ received, total, pct: total ? received / total : 0 });
        }
      });
      res.on('end', () => {
        out.end(resolve);
      });
      res.on('error', reject);
      out.on('error', reject);
    });

    if (activeDownload && activeDownload.cancelled) {
      await fsp.unlink(tmp).catch(() => {});
      activeDownload = null;
      return { cancelled: true };
    }

    if (received < expectedBytes * 0.95) {
      await fsp.unlink(tmp).catch(() => {});
      activeDownload = null;
      return { error: `Download truncated: ${received} of ~${expectedBytes} bytes.` };
    }

    await fsp.rename(tmp, dest);
    if (onProgress) onProgress({ received, total: received, pct: 1 });
    activeDownload = null;
    return { ok: true, bytes: received, path: dest };
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    activeDownload = null;
    return { error: err.message };
  }
}

function cancelDownload() {
  if (activeDownload) activeDownload.cancelled = true;
  return { ok: true };
}

module.exports = { startDownload, cancelDownload };
