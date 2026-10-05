'use strict';
const share = require('./share');

// Polls the share (inotify/FSEvents are unreliable over SMB) and emits changes.
class Poller {
  constructor(getShareRoot, emit, intervalMs = 2000) {
    this.getShareRoot = getShareRoot;
    this.emit = emit;
    this.intervalMs = intervalMs;
    this.cards = new Map(); // fingerprint -> signature string
    this.watched = new Map(); // ticketId -> last status JSON string
    this.timer = null;
    this.shareOk = null;
    this.daemonOnline = null;
    this.firstScan = true;
  }

  start() { this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); }
  watch(ticketId) { if (!this.watched.has(ticketId)) this.watched.set(ticketId, ''); }

  tick() {
    const root = this.getShareRoot();
    const chk = root ? share.checkShare(root) : { ok: false, error: 'Set the Harbor share path in Settings.' };
    if (this.shareOk !== chk.ok || !chk.ok) {
      this.shareOk = chk.ok;
      this.emit('share', chk);
    }
    if (!chk.ok) return;

    const d = share.readDaemonInfo(root);
    const dsig = JSON.stringify([d.online, d.info && d.info.approved_roots, d.info && d.info.allow_clear]);
    if (dsig !== this.daemonSig) { this.daemonSig = dsig; this.emit('daemon', d); }

    const seen = new Set();
    for (const m of share.listCards(root)) {
      const fp = m.card.fingerprint;
      seen.add(fp);
      const sig = [m.present, m.checksum_state, m.scanned_at, Math.round((m.checksum_progress || 0) * 100), m.files.length].join('|');
      const prev = this.cards.get(fp);
      if (prev !== sig) {
        this.cards.set(fp, sig);
        const isNew = prev === undefined || (m.present && prev.startsWith('false'));
        this.emit('card', { manifest: m, isNew: isNew && !this.firstScan && m.present });
      }
    }
    for (const fp of [...this.cards.keys()]) if (!seen.has(fp)) { this.cards.delete(fp); this.emit('card-gone', fp); }
    this.firstScan = false;

    for (const [id, last] of this.watched) {
      const st = share.readStatus(root, id);
      if (!st) continue;
      const cur = JSON.stringify(st);
      if (cur !== last) { this.watched.set(id, cur); this.emit('status', st); continue; }
      if (isTerminal(st)) this.watched.delete(id); // unchanged and nothing more is expected
    }
  }
}

function isTerminal(st) {
  if (st.state === 'failed') return true;
  if (st.state !== 'done') return false;
  if (!st.clear) return true;
  return st.clear.state === 'cleared';
}

module.exports = { Poller, isTerminal };
