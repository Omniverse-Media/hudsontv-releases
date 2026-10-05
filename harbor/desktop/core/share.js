'use strict';
// All communication with the daemon is plain files on the mapped SMB share.
// No network service, no new credentials: the OS already authenticated the mount.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAEMON_STALE_MS = 45_000;

function dirs(shareRoot) {
  const t = path.join(shareRoot, 'tickets');
  return {
    incoming: path.join(t, 'incoming'),
    status: path.join(t, 'status'),
    cards: path.join(t, 'cards'),
    processed: path.join(t, 'processed'),
    logs: path.join(shareRoot, 'logs'),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Missing, or caught mid-write over SMB: treat as "not there yet"; the next poll retries.
    return null;
  }
}

function checkShare(shareRoot) {
  const d = dirs(shareRoot);
  if (!shareRoot || !fs.existsSync(d.cards)) {
    return { ok: false, error: 'Harbor share not found. Check that the drive is mapped and the path is correct.' };
  }
  if (!fs.existsSync(d.incoming)) {
    return { ok: false, error: 'tickets/incoming is missing on the share.' };
  }
  return { ok: true };
}

function readDaemonInfo(shareRoot, now = Date.now()) {
  const info = readJson(path.join(dirs(shareRoot).cards, '_daemon.json'));
  if (!info) return { online: false, info: null };
  const age = now - Date.parse(info.updated_at);
  return { online: Number.isFinite(age) && age < DAEMON_STALE_MS, info };
}

function listCards(shareRoot) {
  const d = dirs(shareRoot).cards;
  let names = [];
  try { names = fs.readdirSync(d); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.') || n.startsWith('_')) continue;
    const m = readJson(path.join(d, n));
    if (m && m.card && Array.isArray(m.files)) out.push(m);
  }
  return out;
}

function readStatus(shareRoot, ticketId) {
  if (!UUID.test(ticketId)) return null;
  return readJson(path.join(dirs(shareRoot).status, ticketId + '.json'));
}

// Atomic write: the daemon ignores dot-files, and a rename is atomic on SMB.
function writeAtomic(dir, name, obj) {
  const tmp = path.join(dir, '.' + name + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { flag: 'wx' });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } catch (e) { /* some SMB mounts do not support fsync */ } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(dir, name));
}

function submitTicket(shareRoot, ticket) {
  if (!UUID.test(ticket.ticket_id)) throw new Error('bad ticket id');
  writeAtomic(dirs(shareRoot).incoming, ticket.ticket_id + '.json', ticket);
  return ticket.ticket_id;
}

function submitClearConfirm(shareRoot, ticketId, token, origin) {
  if (!UUID.test(ticketId)) throw new Error('bad ticket id');
  writeAtomic(dirs(shareRoot).incoming, ticketId + '.clear.json', {
    type: 'clear_confirm',
    ticket_id: ticketId,
    token,
    created_at: new Date().toISOString(),
    origin,
  });
}

module.exports = { dirs, checkShare, readDaemonInfo, listCards, readStatus, submitTicket, submitClearConfirm, UUID, DAEMON_STALE_MS };
