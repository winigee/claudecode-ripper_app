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
const LOG_TAIL_MAX = 200;

function logLine(line) {
  logTail.push(line);
  if (logTail.length > LOG_TAIL_MAX) logTail.shift();
}

function llamaServerBinary() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'llama-cpp', 'llama-server'));
  } else {
    candidates.push(path.join(__dirname, '..', '..', 'vendor', 'llama-cpp', 'llama-server'));
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

async function waitForHealth(p, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && (j.status === 'ok' || j.status === 'loading model — please wait' || j.status === 'no slot available')) {
          if (j.status === 'ok') return true;
        }
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

  const bin = llamaServerBinary();
  if (!bin) {
    startError = new Error(
      'llama-server binary not found. Place it at vendor/llama-cpp/llama-server (dev) or Resources/llama-cpp/llama-server (production).'
    );
    throw startError;
  }
  const model = config.modelPath();
  if (!fs.existsSync(model)) {
    startError = new Error(`Model file not found at ${model}. Download it first via the setup screen.`);
    startError.code = 'NO_MODEL';
    throw startError;
  }

  const libDir = path.dirname(bin);
  port = await pickFreePort();
  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--model', model,
    '--ctx-size', '8192',
    '--n-gpu-layers', '0',
    '--threads', String(Math.max(4, Math.floor(require('os').cpus().length / 2))),
    '--no-warmup',
  ];

  proc = spawn(bin, args, {
    cwd: libDir,
    env: { ...process.env, DYLD_LIBRARY_PATH: libDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(l)));
  proc.stderr.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(l)));
  proc.on('exit', (code, signal) => {
    logLine(`llama-server exited code=${code} signal=${signal}`);
    proc = null;
    ready = false;
  });

  ready = await waitForHealth(port);
  if (!ready) {
    startError = new Error('llama-server did not become healthy within 90s. See log.');
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
    binary: llamaServerBinary(),
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
