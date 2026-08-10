'use strict';

/**
 * Claude Code reads `env` out of ~/.claude/settings.json at startup, so writing
 * ANTHROPIC_BASE_URL there is the closest thing to a global switch: it reaches
 * every `claude` you launch afterwards, in any terminal, with no export.
 *
 * The flip side is that a stale key silently points every future session at a
 * dead proxy, so every write is journalled to `.cxt-proxy/settings-patch.json`
 * and `repair()` removes an orphaned key when the proxy is not running.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./capture-store');

const KEY = 'ANTHROPIC_BASE_URL';
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const PATCH_FILE = path.join(store.RUNTIME_DIR, 'settings-patch.json');

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.cxt-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function currentValue() {
  const settings = readJson(SETTINGS_FILE);
  return settings && settings.env ? settings.env[KEY] : undefined;
}

function patchState() {
  return readJson(PATCH_FILE);
}

/**
 * Points settings.json at `url`. Refuses to touch a value this tool did not
 * write. Returns { ok, reason, previous }.
 */
function apply(url) {
  const existing = currentValue();
  const state = patchState();

  if (existing !== undefined && !(state && state.value === existing)) {
    return { ok: false, reason: 'foreign-value', previous: existing };
  }
  if (existing === url) {
    return { ok: true, reason: 'already-set', previous: existing };
  }

  const settings = readJson(SETTINGS_FILE) || {};
  if (!settings.env || typeof settings.env !== 'object') settings.env = {};
  settings.env[KEY] = url;

  store.ensureDirs();
  writeJsonAtomic(SETTINGS_FILE, settings);
  writeJsonAtomic(PATCH_FILE, { file: SETTINGS_FILE, key: KEY, value: url, at: new Date().toISOString() });

  return { ok: true, reason: 'written', previous: existing };
}

/**
 * Removes the key again — but only the exact value we journalled, so a value
 * you set yourself in the meantime survives. Returns { ok, reason }.
 */
function revert() {
  const state = patchState();
  const existing = currentValue();

  if (existing === undefined) {
    if (fs.existsSync(PATCH_FILE)) fs.unlinkSync(PATCH_FILE);
    return { ok: true, reason: 'nothing-to-do' };
  }
  if (!state || state.value !== existing) {
    return { ok: false, reason: 'foreign-value', previous: existing };
  }

  const settings = readJson(SETTINGS_FILE) || {};
  if (settings.env) {
    delete settings.env[KEY];
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  writeJsonAtomic(SETTINGS_FILE, settings);
  fs.unlinkSync(PATCH_FILE);

  return { ok: true, reason: 'removed' };
}

/**
 * Safety net: a key left behind by a crash, a reboot, or a `kill -9` would
 * break every later `claude`. Call this whenever the proxy is known to be
 * down. Returns { repaired, value } .
 */
function repair() {
  const state = patchState();
  const existing = currentValue();
  if (!state || existing === undefined || state.value !== existing) return { repaired: false };
  const res = revert();
  return { repaired: res.ok, value: existing };
}

module.exports = { KEY, SETTINGS_FILE, apply, revert, repair, currentValue, patchState };
