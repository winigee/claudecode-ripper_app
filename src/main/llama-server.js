const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { app } = require('electron');

const config = require('./config');

let proc = null;
let port = null;
let ready = false;
let startError = null;
let logTail = [];
const LOG_TAIL_MAX = 300;

function logLine(line) {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_MAX) logTail.shift();
}

function llamafileBinary() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'llama-cpp', 'llamafile'));
  } else {
    candidates.push(path.join(__dirname, '..', '..', 'vendor', 'llama-cpp', 'llamafile'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitForHealth(p, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok') return true;
      }
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function start() {
  if (proc) return { port, ready };

  const bin = llamafileBinary();
  if (!bin) {
    startError = new Error(
      'llamafile binary not found. Expected at Resources/llama-cpp/llamafile (production) or vendor/llama-cpp/llamafile (dev).'
    );
    throw startError;
  }
  const model = config.modelPath();
  if (!fs.existsSync(model)) {
    startError = new Error(`Model file not found at ${model}.`);
    startError.code = 'NO_MODEL';
    throw startError;
  }

  // Llamafile needs +x. electron-builder usually preserves it from the source file,
  // but be defensive — calling chmod on a packaged Resources file is allowed.
  try {
    fs.chmodSync(bin, 0o755);
  } catch (_) {}

  port = await pickFreePort();
  const args = [
    '--server',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--nobrowser',
    '-m', model,
    '-c', '8192',
    '--gpu', 'disable',
    '-t', String(Math.max(4, Math.floor(require('os').cpus().length / 2))),
    '--log-disable',
  ];

  startError = null;
  proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(l)));
  proc.stderr.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(l)));
  proc.on('exit', (code, signal) => {
    logLine(`llamafile exited code=${code} signal=${signal}`);
    proc = null;
    ready = false;
  });

  ready = await waitForHealth(port);
  if (!ready) {
    startError = new Error('llamafile did not become healthy within 120s. Check Diagnostics log.');
    stop();
    throw startError;
  }
  return { port, ready };
}

function stop() {
  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
    proc = null;
  }
  ready = false;
}

function status() {
  return {
    running: !!proc,
    ready,
    port,
    binary: llamafileBinary(),
    modelInstalled: config.modelInstalled(),
    modelPath: config.modelPath(),
    error: startError ? { message: startError.message, code: startError.code || null } : null,
  };
}

function getPort() {
  return port;
}

function tail() {
  return logTail.slice();
}

module.exports = { start, stop, status, getPort, tail };
