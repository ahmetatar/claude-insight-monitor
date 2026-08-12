#!/usr/bin/env node
'use strict';

/**
 * One command, no flags: `cmon` brings the proxy up, points Claude Code at it,
 * and undoes both when you press Enter — or when the terminal goes away.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const store = require('../src/capture-store');
const settingsEnv = require('../src/settings-env');

const RUNTIME_DIR = store.RUNTIME_DIR;
const PID_FILE = path.join(RUNTIME_DIR, 'proxy.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'proxy.log');
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

/** Waits until the proxy answers, so the UI link is live when we print it. */
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
  if (existing) return { info: existing, weStarted: false };

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
  return { info, weStarted: true };
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

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
    rl.on('close', resolve);
    rl.on('SIGINT', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  // Piping our output into something that exits early (`| head`) must not turn
  // into a stack trace on the way out.
  process.stdout.on('error', (err) => {
    if (err.code !== 'EPIPE') throw err;
  });

  // A `kill -9` or a reboot can strand the settings key and quietly break every
  // later `claude`; nothing is running yet, so this is always safe to undo.
  if (!runningInfo()) settingsEnv.repair();

  const { info } = await startProxy();
  const url = `http://localhost:${info.port}`;
  await waitForListening(info.port);

  const patched = settingsEnv.apply(url);
  const viaSettings = patched.ok;

  console.log('');
  console.log(`  cmon is up — pid ${info.pid} · ${url}`);
  console.log('');
  if (viaSettings) {
    console.log(`  ${ENV_VAR} written to ~/.claude/settings.json`);
    console.log('  Every `claude` you start from now on goes through the proxy.');
    console.log('');
    console.log('  In your other terminal, just:');
    console.log('    claude');
  } else {
    console.log(`  ! ~/.claude/settings.json already sets ${ENV_VAR}=${patched.previous}`);
    console.log('    Leaving it alone — point Claude Code at the proxy yourself:');
    console.log('');
    console.log(`    export ${ENV_VAR}=${url}`);
    console.log('    claude');
  }
  console.log('');
  console.log(`  UI: ${url}`);
  console.log('');

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;

    console.log('');
    if (viaSettings) {
      const res = settingsEnv.revert();
      console.log(
        res.ok
          ? `  Removed ${ENV_VAR} from ~/.claude/settings.json.`
          : `  ! Left ${ENV_VAR}=${res.previous} in settings.json — it changed since we wrote it.`
      );
    }
    const stopped = stopProxy();
    console.log(stopped ? `  Stopped cmon (pid ${stopped.pid}).` : '  Proxy was already gone.');
    console.log(`  Captures: ${store.CAPTURES_DIR} · ${store.countAllTurns()} turns total`);
    if (!viaSettings) console.log(`  Run this where you exported it: unset ${ENV_VAR}`);
    console.log('');
  };

  // Ctrl-C, a closed terminal window (SIGHUP) and `kill` all have to undo the
  // settings write; only `exit` fires on its own.
  process.on('exit', finish);
  for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
    process.on(sig, () => {
      finish();
      process.exit(0);
    });
  }

  await waitForEnter('  Press Enter to stop the proxy and end the session… ');
  finish();
  process.exit(0);
}

main().catch((err) => {
  console.error(`cmon: ${err.message}`);
  process.exitCode = 1;
});
