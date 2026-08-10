#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const store = require('../src/capture-store');
const settingsEnv = require('../src/settings-env');

const RUNTIME_DIR = store.RUNTIME_DIR;
const PID_FILE = path.join(RUNTIME_DIR, 'proxy.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'proxy.log');
const RUN_SCRIPT = path.join(__dirname, '..', 'src', 'run.js');

const ENV_VAR = 'ANTHROPIC_BASE_URL';

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

/** Starts the proxy unless it is already up. Returns { info, weStarted }. */
function startProxy(port) {
  store.ensureDirs();
  const existing = runningInfo();
  if (existing) return { info: existing, weStarted: false };

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [RUN_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, CXT_PROXY_PORT: String(port) },
  });
  child.unref();

  const info = { pid: child.pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
  return { info, weStarted: true };
}

function stopProxy() {
  const info = readPidInfo();
  if (!info || !isAlive(info.pid)) {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    return null;
  }
  process.kill(info.pid, 'SIGTERM');
  fs.unlinkSync(PID_FILE);
  return info;
}

function baseUrl(port) {
  return `http://localhost:${port}`;
}

/** Best-effort clipboard write; returns true when the platform tool exists. */
function copyToClipboard(text) {
  const candidates =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
      ? [['clip', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];
  for (const [bin, args] of candidates) {
    const res = spawnSync(bin, args, { input: text });
    if (!res.error && res.status === 0) return true;
  }
  return false;
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
    rl.on('SIGINT', () => {
      rl.close();
      resolve();
    });
  });
}

/* -------------------------------------------------------------- commands */

function cmdStart(port) {
  const { info, weStarted } = startProxy(port);
  console.log(
    weStarted
      ? `Started ctx-proxy (pid ${info.pid}) on ${baseUrl(info.port)}`
      : `Already running (pid ${info.pid}) on ${baseUrl(info.port)}`
  );
  if (weStarted) console.log(`Logs: ${LOG_FILE}`);
  console.log('');
  console.log('Point Claude Code at it in another shell, then run `claude`:');
  console.log(`  export ${ENV_VAR}=${baseUrl(info.port)}`);
  console.log(`UI: ${baseUrl(info.port)}`);
  console.log('');
  console.log('`ctx-proxy session` does the wiring and the cleanup for you.');
}

function cmdStop() {
  const info = stopProxy();
  const fixed = settingsEnv.repair();

  if (!info) console.log('Not running.');
  else console.log(`Stopped (pid ${info.pid}). Captures kept in ${store.CAPTURES_DIR}`);

  if (fixed.repaired) {
    console.log(`Removed ${ENV_VAR} from ${settingsEnv.SETTINGS_FILE}.`);
  } else if (settingsEnv.currentValue() !== undefined) {
    console.log(`! ${ENV_VAR}=${settingsEnv.currentValue()} still set in settings.json (not written by us).`);
  } else {
    console.log(`Remember to unset ${ENV_VAR} in any shell where you exported it by hand.`);
  }
}

function cmdStatus() {
  const info = runningInfo();
  console.log(`Running: ${!!info}`);
  if (info) {
    console.log(`PID: ${info.pid}`);
    console.log(`Port: ${info.port}`);
    console.log(`Started at: ${info.startedAt}`);
  }
  console.log(`Captured turns: ${store.countAllTurns()}`);

  const value = settingsEnv.currentValue();
  if (!info && value !== undefined) {
    // a crash or a reboot can strand the key; a stale one breaks every `claude`
    const fixed = settingsEnv.repair();
    console.log(
      fixed.repaired
        ? `settings.json: removed stale ${ENV_VAR}=${fixed.value} (proxy is down)`
        : `settings.json: ${ENV_VAR}=${value} — set by hand, left alone`
    );
  } else if (value !== undefined) {
    console.log(`settings.json: ${ENV_VAR}=${value}`);
  } else {
    console.log('settings.json: clean');
  }
}

/**
 * Interactive session for the "two terminals" workflow: brings the proxy up,
 * hands you the export line (on the clipboard when possible), and tears
 * everything down on Enter. A child process cannot reach into the shell that
 * runs `claude`, so the unset line is handed back the same way.
 */
async function cmdSession(port) {
  const { info, weStarted } = startProxy(port);
  const url = baseUrl(info.port);

  const patched = settingsEnv.apply(url);
  if (!patched.ok) {
    console.log('');
    console.log(`  ! ${settingsEnv.SETTINGS_FILE} already sets ${ENV_VAR}=${patched.previous}`);
    console.log('    Leaving it alone — falling back to the export line.');
  }
  const viaSettings = patched.ok;

  console.log('');
  console.log(`  ctx-proxy is ${weStarted ? 'up' : 'already up'} — pid ${info.pid} · ${url}`);
  console.log('');
  if (viaSettings) {
    console.log(`  ${ENV_VAR} written to ~/.claude/settings.json`);
    console.log('  Every `claude` you start from now on goes through the proxy — no export needed.');
    console.log('');
    console.log('  In your other terminal, just:');
    console.log('    claude');
  } else {
    const exportLine = `export ${ENV_VAR}=${url}`;
    const copied = copyToClipboard(exportLine);
    console.log('  In your other terminal:');
    console.log(`    ${exportLine}`);
    console.log('    claude');
    console.log('');
    console.log(copied ? '  (that export line is on your clipboard)' : '  (copy the line above by hand)');
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
    if (weStarted) {
      const stopped = stopProxy();
      console.log(stopped ? `  Stopped ctx-proxy (pid ${stopped.pid}).` : '  Proxy was already gone.');
    } else {
      console.log(`  Left ctx-proxy running (pid ${info.pid}) — this session did not start it.`);
    }
    console.log(`  Captures: ${store.CAPTURES_DIR} · ${store.countAllTurns()} turns total`);

    if (!viaSettings) {
      const unsetLine = `unset ${ENV_VAR}`;
      const copiedUnset = copyToClipboard(unsetLine);
      console.log('');
      console.log(`  Run this in the other terminal: ${unsetLine}`);
      if (copiedUnset) console.log('  (already on your clipboard)');
    }
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
}

/**
 * Leak-free variant: the variable only ever exists inside the child process,
 * so there is nothing to clean up afterwards.
 */
function cmdExec(port, argv) {
  const sep = argv.indexOf('--');
  let command;
  if (sep !== -1) {
    command = argv.slice(sep + 1);
  } else {
    // tolerate `exec [--port N] claude ...` without the separator
    const portIdx = argv.indexOf('--port');
    command = portIdx === -1 ? argv.slice() : argv.slice(0, portIdx).concat(argv.slice(portIdx + 2));
  }
  if (!command.length) {
    console.log('Usage: ctx-proxy exec [--port 8787] -- <command> [args...]');
    console.log('Example: ctx-proxy exec -- claude');
    process.exitCode = 1;
    return;
  }

  const { info, weStarted } = startProxy(port);
  const url = baseUrl(info.port);
  console.log(`ctx-proxy ${weStarted ? 'started' : 'already running'} on ${url} — running: ${command.join(' ')}`);

  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [ENV_VAR]: url },
  });

  const shutdown = () => {
    if (!weStarted) {
      console.log(`\nctx-proxy left running (pid ${info.pid}) — this command did not start it.`);
      return;
    }
    const stopped = stopProxy();
    if (stopped) console.log(`\nStopped ctx-proxy (pid ${stopped.pid}). Captures: ${store.CAPTURES_DIR}`);
  };

  child.on('exit', (code, signal) => {
    shutdown();
    process.exitCode = signal ? 1 : code ?? 0;
  });
  child.on('error', (err) => {
    console.error(`Failed to run ${command[0]}: ${err.message}`);
    shutdown();
    process.exitCode = 1;
  });
}

function parsePort(args) {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) return Number(args[idx + 1]);
  return 8787;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'session':
      cmdSession(parsePort(rest));
      break;
    case 'exec':
      cmdExec(parsePort(rest), rest);
      break;
    case 'start':
      cmdStart(parsePort(rest));
      break;
    case 'stop':
      cmdStop();
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      console.log('Usage: ctx-proxy <command> [--port 8787]');
      console.log('');
      console.log('  session          start the proxy, wire up Claude Code, undo both on Enter');
      console.log('  exec -- <cmd>    run <cmd> against the proxy, stop it when <cmd> exits');
      console.log('');
      console.log('  start            leave the proxy running in the background');
      console.log('  stop             stop it and clean up');
      console.log('  status           running? turns captured? settings clean?');
      process.exitCode = 1;
  }
}

main();
