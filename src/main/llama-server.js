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
  return [
    '--server',
    '--host', '127.0.0.1',
    '--port', String(p),
    '--nobrowser',
    '-m', model,
    '-c', '8192',
    '--gpu', 'disable',
    '-t', String(Math.max(2, Math.floor(os.cpus().length / 2))),
    '--log-disable',
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

// Try direct spawn first, then shell-mediated spawn if that fails. Cosmopolitan
// binaries should work directly on macOS via the embedded Mach-O, but some
// kernel/AMFI configurations reject the MZ prefix and we fall back to letting
// /bin/sh interpret the APE shell prefix at the top of the file.
function trySpawn(bin, args, mode) {
  logLine(`spawn attempt: mode=${mode}`);
  let p;
  if (mode === 'direct') {
    p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    // Shell mode: invoke via bash since the APE prefix uses bash builtins.
    const shellPath = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const quoted = [bin, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    p = spawn(shellPath, ['-c', `exec ${quoted}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  p.stdout.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(`[out] ${l}`)));
  p.stderr.on('data', (b) => b.toString().split('\n').forEach((l) => l && logLine(`[err] ${l}`)));
  p.on('error', (err) => logLine(`spawn error (${mode}): ${err.code || ''} ${err.message}`));
  return p;
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
  const model = config.modelPath();
  if (!fs.existsSync(model)) {
    startError = new Error(`Model file not found at ${model}`);
    startError.code = 'NO_MODEL';
    logLine('start failed: ' + startError.message);
    throw startError;
  }

  // Make sure the binary is executable and not quarantined.
  let stat;
  try {
    stat = fs.statSync(bin);
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
  logLine(`==> args: ${args.join(' ')}`);

  for (const mode of ['direct', 'shell']) {
    let exited = false;
    let exitInfo = null;
    proc = trySpawn(bin, args, mode);
    proc.on('exit', (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      logLine(`llamafile exited (${mode}) code=${code} signal=${signal}`);
      proc = null;
      ready = false;
    });

    ready = await probeHealth(port, () => exited);
    if (ready) {
      logLine(`server became healthy via ${mode}`);
      return { port, ready };
    }

    // Server didn't come up. If proc died, try next mode. If proc is alive but
    // /health never went green, kill it and bail — switching modes won't help.
    if (!exited) {
      logLine(`server hung (${mode}) — killing`);
      try { proc.kill('SIGTERM'); } catch (_) {}
      proc = null;
      startError = new Error(`llamafile started but did not become healthy via ${mode}.`);
      throw startError;
    }
    logLine(`spawn ${mode} died; will try next mode if any`);
  }

  startError = new Error('llamafile failed to start under any spawn mode. See llama-server.log.');
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
    modelPath: config.modelPath(),
    logFilePath: logFilePath(),
    error: startError ? { message: startError.message, code: startError.code || null } : null,
  };
}

function getPort() { return port; }
function tail() { return logTail.slice(); }

module.exports = { start, stop, status, getPort, tail };
