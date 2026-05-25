const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const config = require('./config');

let proc = null;
let port = null;
let ready = false;
let startError = null;
let logTail = [];
const LOG_TAIL_MAX = 500;

function logFilePath() {
  return path.join(app.getPath('userData'), 'llama-server.log');
}

// Append-only log file. Don't keep a long-lived write stream — just open,
// write, flush, close for every line. Robust against ordering across spawns.
function diskLog(line) {
  try {
    fs.appendFileSync(logFilePath(), line + '\n');
  } catch (_) {}
}

function logLine(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logTail.push(stamped);
  if (logTail.length > LOG_TAIL_MAX) logTail.shift();
  diskLog(stamped);
}

function llamafileBinary() {
  const runtimePath = config.llamafilePath();
  if (fs.existsSync(runtimePath)) return runtimePath;
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'llama-cpp', 'llamafile')
    : path.join(__dirname, '..', '..', 'vendor', 'llama-cpp', 'llamafile');
  if (fs.existsSync(bundled)) return bundled;
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

async function probeHealth(p, abortIfDead) {
  const deadline = Date.now() + 180_000; // 3 min absolute ceiling
  while (Date.now() < deadline) {
    if (abortIfDead && abortIfDead()) return false; // proc died — give up immediately
    try {
      const r = await fetch(`http://127.0.0.1:${p}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok') return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function buildArgs(model, p) {
  // Keep this list conservative — llamafile's argument parser is stricter than
  // upstream llama-server's. Flags removed in v0.7.4 because llamafile 0.10.1
  // rejected them: --nobrowser, --log-disable.
  return [
    '--server',
    '--host', '127.0.0.1',
    '--port', String(p),
    '-m', model,
    '-c', '8192',
    '--gpu', 'disable',
    '-t', String(Math.max(2, Math.floor(os.cpus().length / 2))),
  ];
}

function stripQuarantine(bin) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', bin], { stdio: 'ignore' });
    logLine(`xattr: removed com.apple.quarantine from ${bin}`);
  } catch (_) {
    // attribute absent — fine
  }
}

// Always invoke via bash. Cosmopolitan binaries start with an MZ (DOS) header
// followed by an APE shell prefix; bash reads the prefix, identifies the OS,
// and exec's the embedded Mach-O. Direct spawn() from Node sometimes fails
// silently on macOS — the kernel can't recognise the format and Node loses
// both the error and exit events. Bash invocation works on every macOS we
// have, confirmed by the user's terminal test.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function spawnLlamafile(bin, args) {
  const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const cmd = [bin, ...args].map(shellQuote).join(' ');
  logLine(`spawn via ${shellPath} -c: ${cmd}`);
  return spawn(shellPath, ['-c', `exec ${cmd} 2>&1`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function start() {
  if (proc) {
    logLine('start() called but proc already alive — returning existing');
    return { port, ready };
  }

  startError = null;
  const bin = llamafileBinary();
  if (!bin) {
    startError = new Error('llamafile binary not found.');
    logLine('start failed: ' + startError.message);
    throw startError;
  }
  const model = config.activeModelPath();
  if (!fs.existsSync(model)) {
    startError = new Error(`Model file not found at ${model}`);
    startError.code = 'NO_MODEL';
    logLine('start failed: ' + startError.message);
    throw startError;
  }
  logLine(`active model: ${config.getActiveModelId()}`);

  // Make sure the binary is executable and not quarantined.
  try {
    const stat = fs.statSync(bin);
    logLine(`bin size=${stat.size} mode=0o${(stat.mode & 0o777).toString(8)}`);
  } catch (e) {
    logLine('stat failed: ' + e.message);
  }
  try {
    fs.chmodSync(bin, 0o755);
    logLine(`chmod 0755 ok`);
  } catch (e) {
    logLine('chmod failed: ' + e.message);
  }
  stripQuarantine(bin);

  port = await pickFreePort();
  const args = buildArgs(model, port);
  logLine(`==> bin: ${bin}`);
  logLine(`==> model: ${model}`);
  logLine(`==> port: ${port}`);

  let exited = false;
  let exitInfo = null;

  try {
    proc = spawnLlamafile(bin, args);
  } catch (e) {
    logLine(`spawn threw synchronously: ${e.message}`);
    startError = new Error(`spawn threw: ${e.message}`);
    throw startError;
  }

  logLine(`spawn returned pid=${proc.pid || 'null'}`);

  proc.on('error', (err) => {
    logLine(`spawn error event: ${err.code || ''} ${err.message}`);
  });
  proc.on('spawn', () => {
    logLine(`spawn event fired (process truly started)`);
  });
  proc.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    logLine(`process exited code=${code} signal=${signal}`);
    proc = null;
    ready = false;
  });
  proc.stdout.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(`[out] ${l}`)));
  proc.stderr.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(`[err] ${l}`)));

  // Give the spawn event a tick to fire.
  await new Promise((r) => setTimeout(r, 100));

  ready = await probeHealth(port, () => exited);
  if (ready) {
    logLine(`server is healthy on port ${port}`);
    return { port, ready };
  }

  if (exited) {
    startError = new Error(`llamafile died before /health responded (code=${exitInfo?.code}, signal=${exitInfo?.signal}).`);
  } else {
    logLine(`server never went healthy — killing`);
    try { proc.kill('SIGTERM'); } catch (_) {}
    proc = null;
    startError = new Error('llamafile started but /health never responded within 3 min.');
  }
  throw startError;
}

function stop() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (_) {}
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
    llamafileInstalled: config.llamafileInstalled() || !!llamafileBinary(),
    modelInstalled: config.modelInstalled(),
    activeModelId: config.getActiveModelId(),
    modelPath: config.activeModelPath(),
    logFilePath: logFilePath(),
    error: startError ? { message: startError.message, code: startError.code || null } : null,
  };
}

function getPort() { return port; }
function tail() { return logTail.slice(); }

module.exports = { start, stop, status, getPort, tail };
