#!/usr/bin/env node
'use strict';

/**
 * `cmon [claude args…]` brings the proxy up and runs `claude` as its child with
 * ANTHROPIC_BASE_URL set in that child's environment only. Sessions already
 * open elsewhere are never touched. When claude exits, so does cmon, and the
 * proxy stops once no other cmon is still using it.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../src/capture-store');
const settingsEnv = require('../src/settings-env');

const RUNTIME_DIR = store.RUNTIME_DIR;
const PID_FILE = path.join(RUNTIME_DIR, 'proxy.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'proxy.log');
const CLIENTS_DIR = path.join(RUNTIME_DIR, 'clients');
const RUN_SCRIPT = path.join(__dirname, '..', 'src', 'run.js');

const ENV_VAR = 'ANTHROPIC_BASE_URL';
const FIRST_PORT = 8787;

function readPidInfo() {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningInfo() {
  const info = readPidInfo();
  return info && isAlive(info.pid) ? info : null;
}

/** First free port at or after `from`, so nothing has to be configured. */
async function freePort(from) {
  for (let port = from; port < from + 50; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port between ${from} and ${from + 49}.`);
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** Waits until the proxy answers, so claude's first request has somewhere to go. */
function waitForListening(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function startProxy() {
  store.ensureDirs();
  const existing = runningInfo();
  if (existing) return existing;

  const port = await freePort(FIRST_PORT);
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUN_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, CMON_PORT: String(port) },
  });
  child.unref();

  const info = { pid: child.pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
  return info;
}

function stopProxy() {
  const info = readPidInfo();
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  if (!info || !isAlive(info.pid)) return null;
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    return null;
  }
  return info;
}

/*
 * Several cmon windows can share one proxy. Each registers its pid here, and
 * the last one out stops the proxy; a client that died without cleaning up
 * is ignored because its pid is no longer alive.
 */
function registerClient() {
  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLIENTS_DIR, String(process.pid)), '');
}

function unregisterClient() {
  fs.rmSync(path.join(CLIENTS_DIR, String(process.pid)), { force: true });
}

function otherLiveClients() {
  if (!fs.existsSync(CLIENTS_DIR)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(CLIENTS_DIR)) {
    const pid = Number(name);
    if (!pid || pid === process.pid) continue;
    if (isAlive(pid)) count += 1;
    else fs.rmSync(path.join(CLIENTS_DIR, name), { force: true });
  }
  return count;
}

async function main() {
  process.stdout.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err;
  });

  // Versions up to 0.1.1 wrote the URL into ~/.claude/settings.json; a key a
  // crash left behind would still point every claude at a dead proxy.
  if (!runningInfo()) settingsEnv.repair();

  const info = await startProxy();
  const url = `http://localhost:${info.port}`;
  if (!(await waitForListening(info.port))) {
    throw new Error(`proxy did not come up on ${url} — see ${LOG_FILE}`);
  }
  registerClient();

  console.log('');
  console.log(`  cmon is up — pid ${info.pid} · UI: ${url}`);
  const foreign = settingsEnv.currentValue();
  if (foreign !== undefined) {
    console.log(`  ! ~/.claude/settings.json sets ${ENV_VAR}=${foreign}.`);
    console.log('    If Claude Code applies it over the environment, this session bypasses the proxy.');
  }
  console.log('');

  const child = spawn('claude', process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, [ENV_VAR]: url },
    shell: process.platform === 'win32',
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unregisterClient();

    console.log('');
    if (otherLiveClients() > 0) {
      console.log('  Proxy left running — another cmon is still using it.');
    } else {
      const stopped = stopProxy();
      console.log(stopped ? `  Stopped cmon (pid ${stopped.pid}).` : '  Proxy was already gone.');
    }
    console.log(`  Captures: ${store.CAPTURES_DIR} · ${store.countAllTurns()} turns total`);
    console.log(`  UI was: ${url}`);
    console.log('');
  };
  process.on('exit', finish);

  // Ctrl-C reaches claude directly through the terminal; claude decides what
  // it means, and cmon follows when claude exits.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGHUP', 'SIGTERM']) {
    process.on(sig, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      finish();
      process.exit(128 + os.constants.signals[sig]);
    });
  }

  child.on('error', (err) => {
    console.error(
      err.code === 'ENOENT'
        ? '\ncmon: `claude` was not found on PATH.'
        : `\ncmon: could not start claude: ${err.message}`
    );
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + os.constants.signals[signal] : code ?? 0);
  });
}

main().catch((err) => {
  console.error(`cmon: ${err.message}`);
  process.exitCode = 1;
});
