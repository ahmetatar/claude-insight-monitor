'use strict';

/**
 * cmon no longer writes ~/.claude/settings.json: it hands ANTHROPIC_BASE_URL to
 * the claude it launches, and to nothing else. Versions up to 0.1.1 did write
 * it there, journalled in `.cmon/settings-patch.json`, and running Claude Code
 * sessions picked the change up too. A key such a version left behind points
 * every claude at a dead proxy, so `repair()` removes exactly the journalled
 * value, and never one you set yourself.
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
  // A machine that has never run `claude` has no ~/.claude yet, and the atomic
  // write lands in that directory before the rename does.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cmon-tmp`;
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

module.exports = { KEY, SETTINGS_FILE, revert, repair, currentValue, patchState };
