'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULT_SUBFOLDERS } = require('./ticket');

const DEFAULTS = {
  shareRoot: '',
  machine: os.hostname(),
  user: safeUser(),
  subfolderMap: DEFAULT_SUBFOLDERS,
  lastRoot: '',
};

function safeUser() { try { return os.userInfo().username; } catch (e) { return 'unknown'; } }

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'harbor-settings.json');
    this.historyFile = path.join(dir, 'harbor-tickets.json');
    fs.mkdirSync(dir, { recursive: true });
  }
  _read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } }
  _write(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }
  settings() { return { ...DEFAULTS, ...this._read(this.file, {}) }; }
  saveSettings(patch) { const s = { ...this.settings(), ...patch }; this._write(this.file, s); return s; }
  history() { return this._read(this.historyFile, []); }
  addHistory(entry) {
    const h = [entry, ...this.history().filter((e) => e.ticket_id !== entry.ticket_id)].slice(0, 100);
    this._write(this.historyFile, h);
    return h;
  }
}

module.exports = { Store };
