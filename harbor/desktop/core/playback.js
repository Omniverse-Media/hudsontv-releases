'use strict';
// Playback reads the original clip from the card over SMB: DSM exports each USB disk as its own share
// (/volumeUSB6/usbshare -> "usbshare6"). The NAS is too slow to transcode, so nothing is converted.
const fs = require('node:fs');
const path = require('node:path');

const PLAYABLE = new Set(['video', 'audio']);
// Codecs the built-in player can decode. Everything else opens in the Mac's default app.
const NATIVE_EXT = new Set(['mp4', 'mov', 'm4v', 'mp3', 'wav', 'm4a', 'aac']);

function cardShareName(manifest) {
  if (manifest.card.share_name) return manifest.card.share_name;
  const m = /\/volumeUSB(\d+)\/usbshare(?:\/|$)/.exec(manifest.card.mount_path || '');
  return m ? 'usbshare' + m[1] : null;
}

// A file inside `root`, or null if the relative path tries to leave it.
function clipPath(root, rel) {
  const p = path.resolve(root, ...rel.split('/'));
  return p.startsWith(path.resolve(root) + path.sep) ? p : null;
}

function probe(manifest) {
  return manifest.files.find((f) => f.kind === 'media') || manifest.files[0];
}

// Where this card is mounted on this computer: a folder the user picked, else /Volumes/<share>(-n).
function findCardRoot(manifest, { override, volumesDir = '/Volumes' } = {}) {
  const share = cardShareName(manifest);
  const cands = [override];
  if (share) for (const s of ['', '-1', '-2', '-3']) cands.push(path.join(volumesDir, share + s));
  const f = probe(manifest);
  for (const c of cands) {
    if (!c) continue;
    const p = f && clipPath(c, f.relative_path);
    try { if (p && fs.statSync(p).size === f.size) return c; } catch (e) { /* not this one */ }
  }
  return null;
}

// The SMB server behind the mounted Harbor share, from `mount` output:
// "//user@Thriller._smb._tcp.local/Harbor on /Volumes/Harbor (smbfs, ...)"
function smbHost(mountOutput, shareRoot) {
  for (const line of mountOutput.split('\n')) {
    const m = /^\/\/(?:[^@/]+@)?([^/\s]+)\/\S+ on (.+?) \(smbfs/.exec(line);
    if (m && path.resolve(m[2]) === path.resolve(shareRoot)) return m[1];
  }
  return null;
}

// The log curve a camera most likely recorded in, as the player's starting view.
function guessLook(manifest) {
  const p = (manifest.profiles_matched || []).join(' ').toLowerCase();
  if (p.includes('sony')) return 'slog3';
  if (p.includes('canon')) return 'clog3';
  if (p.includes('panasonic') || p.includes('lumix')) return 'vlog';
  if (p.includes('arri')) return 'logc3';
  return 'none';
}

const ext = (rel) => (rel.split('.').pop() || '').toLowerCase();
const canPlayInside = (rel) => NATIVE_EXT.has(ext(rel));

module.exports = { PLAYABLE, cardShareName, clipPath, findCardRoot, smbHost, guessLook, canPlayInside };
