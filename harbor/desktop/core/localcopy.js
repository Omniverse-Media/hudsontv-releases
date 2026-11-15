'use strict';
// Copies selected files from the card (mounted on this computer over SMB) to a folder on this computer.
// Same guarantees as the NAS daemon: never overwrite a different file, verify by hashing, resumable by re-running.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { checkProjectName, rollPrefix } = require('./logic');
const { clipPath } = require('./playback');

const CHUNK = 4 * 1024 * 1024;
const SPACE_MARGIN = 1024 ** 3; // keep 1 GiB free
const PART = '.harbor-part';

let xxhPromise = null;
function xxh() { return (xxhPromise = xxhPromise || require('xxhash-wasm')()); }
const hex = (big) => big.toString(16).padStart(16, '0');

// Hash a file (optionally while copying it to `out`). Returns 'xxh64:<hex>'.
async function hashStream(src, out, onBytes, signal) {
  const api = await xxh();
  const h = api.create64();
  const rs = fs.createReadStream(src, { highWaterMark: CHUNK });
  const ws = out ? fs.createWriteStream(out, { flags: 'wx' }) : null;
  try {
    for await (const chunk of rs) {
      if (signal && signal.aborted) throw new Error('cancelled');
      h.update(chunk);
      if (ws && !ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
      if (onBytes) onBytes(chunk.length);
    }
    if (ws) {
      await new Promise((res, rej) => { ws.end((e) => (e ? rej(e) : res())); });
      const fd = await fsp.open(out, 'r');
      try { await fd.sync(); } catch (e) { /* not supported on some volumes */ } finally { await fd.close(); }
    }
  } catch (e) {
    rs.destroy(); if (ws) ws.destroy();
    throw e;
  }
  return 'xxh64:' + hex(h.digest());
}

// Where the files will go on this computer, so the UI can show the path before anything is copied.
function layout({ destRoot, project, dit, roll, subfolderMap, relDir, mediaType }) {
  const base = path.join(destRoot, project.trim());
  if (dit) return path.join(base, dit.day, dit.group, roll, ...relDir.split('/').filter(Boolean));
  return path.join(base, ...(subfolderMap[mediaType] || 'Footage/Other').split('/'));
}

function within(root, p) { const r = path.resolve(root) + path.sep; return path.resolve(p).startsWith(r); }

// Free space and writability of a folder (or its nearest existing parent), checked before and while copying.
function inspectDest(dir) {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const out = { exists: fs.existsSync(dir), checked: probe, free: null, writable: false };
  try { const s = fs.statfsSync(probe); out.free = Number(s.bavail) * Number(s.bsize); } catch (e) { /* unknown */ }
  try { fs.accessSync(probe, fs.constants.W_OK); out.writable = true; } catch (e) { /* read-only or no permission */ }
  return out;
}

// One roll folder per card per day/group, remembered in the group folder so re-ingesting the same card reuses it.
function assignRoll(groupDir, fingerprint, prefix) {
  const book = path.join(groupDir, '.harbor-rolls.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(book, 'utf8')); } catch (e) { /* none yet */ }
  if (map[fingerprint]) return map[fingerprint];
  let max = 0;
  try {
    for (const n of fs.readdirSync(groupDir)) { const m = new RegExp('^' + prefix + '(\\d{3,})$').exec(n); if (m) max = Math.max(max, Number(m[1])); }
  } catch (e) { /* group folder is new */ }
  for (const v of Object.values(map)) { const m = new RegExp('^' + prefix + '(\\d{3,})$').exec(v); if (m) max = Math.max(max, Number(m[1])); }
  const roll = prefix + String(max + 1).padStart(3, '0');
  fs.mkdirSync(groupDir, { recursive: true });
  map[fingerprint] = roll;
  fs.writeFileSync(book, JSON.stringify(map, null, 2));
  return roll;
}

function uniqueName(file) {
  const ext = path.extname(file); const stem = file.slice(0, file.length - ext.length);
  for (let i = 2; i < 1000; i++) if (!fs.existsSync(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
  throw new Error('too many name conflicts for ' + file);
}

/**
 * job: { manifest, cardRoot, selection:[{relative_path,size,checksum}], destRoot, project, dit|null, subfolderMap, origin }
 * onUpdate(job) is called as files change state. Resolves with the final job.
 * state: done | paused (card/disk went away; run again to resume) | failed
 */
async function runLocalIngest(job, onUpdate = () => {}, signal = null) {
  const L = { state: 'running', message: null, progress: 0, roll: null, dir: null, files: [], started_at: new Date().toISOString() };
  const emit = () => { L.progress = progressOf(L); onUpdate(L); };
  const fail = (state, message) => { L.state = state; L.message = message; emit(); return L; };

  const err = checkProjectName(job.project);
  if (err) return fail('failed', err);
  if (job.dit) for (const v of [job.dit.day, job.dit.group]) { const e = checkProjectName(v); if (e) return fail('failed', 'Day or group name is not valid.'); }
  if (!job.destRoot || !path.isAbsolute(job.destRoot)) return fail('failed', 'Choose a folder on this computer.');
  if (!job.cardRoot) return fail('paused', 'The card is not connected to this computer. Connect it, then resume.');
  if (within(job.cardRoot, path.join(job.destRoot, 'x')) || path.resolve(job.destRoot) === path.resolve(job.cardRoot)) return fail('failed', 'The destination is on the card itself.');

  const total = job.selection.reduce((a, f) => a + f.size, 0);
  const space = inspectDest(job.destRoot);
  if (!space.writable) return fail('failed', `This computer can't write to ${space.checked}. Pick another folder or fix its permissions.`);
  if (space.free != null && total + SPACE_MARGIN > space.free) return fail('failed', `Not enough room on this computer: need ${fmt(total)}, ${fmt(space.free)} free.`);

  const mediaOf = (rel) => ((job.manifest.files.find((x) => x.relative_path === rel) || {}).media_type) || 'other';
  try {
    if (job.dit) {
      const gdir = path.join(job.destRoot, job.project.trim(), job.dit.day, job.dit.group);
      L.roll = assignRoll(gdir, job.manifest.card.fingerprint, job.dit.roll_prefix || rollPrefix(job.dit.group));
    }
    L.files = job.selection.map((f) => ({ relative_path: f.relative_path, size: f.size, state: 'pending', dest: null, checksum: null, done: 0 }));
    emit();
  } catch (e) { return fail('failed', `Can't create folders there: ${e.code || e.message}`); }

  const report = [];
  for (let i = 0; i < job.selection.length; i++) {
    const sel = job.selection[i]; const st = L.files[i];
    if (signal && signal.aborted) return fail('paused', 'Stopped.');
    const src = clipPath(job.cardRoot, sel.relative_path);
    if (!src) { st.state = 'failed'; st.error = 'path leaves the card'; emit(); continue; }
    try {
      let s;
      try { s = await fsp.stat(src); } catch (e) { return fail('paused', 'The card went away (pulled or asleep). Reconnect it and resume; finished files are kept.'); }
      if (s.size !== sel.size) { st.state = 'failed'; st.error = 'file changed on the card'; emit(); continue; }
      const dir = layout({ destRoot: job.destRoot, project: job.project, dit: job.dit, roll: L.roll, subfolderMap: job.subfolderMap || {}, relDir: path.posix.dirname(sel.relative_path) === '.' ? '' : path.posix.dirname(sel.relative_path), mediaType: mediaOf(sel.relative_path) });
      if (!within(path.join(job.destRoot, job.project.trim()), path.join(dir, 'x'))) { st.state = 'failed'; st.error = 'path leaves the project folder'; emit(); continue; }
      await fsp.mkdir(dir, { recursive: true });
      L.dir = L.dir || (job.dit ? path.join(job.destRoot, job.project.trim(), job.dit.day, job.dit.group, L.roll) : path.join(job.destRoot, job.project.trim()));
      let final = path.join(dir, path.basename(sel.relative_path));
      const want = sel.checksum && sel.checksum.startsWith('xxh64:') ? sel.checksum : null;

      // Already there? Same bytes means a re-run (skip). Different bytes means a name clash (keep both, never overwrite).
      if (fs.existsSync(final)) {
        let same = false;
        if (fs.statSync(final).size === sel.size) {
          const have = await hashStream(final, null, null, signal);
          same = want ? have === want : have === (await hashStream(src, null, null, signal));
          if (same) { st.state = 'skipped'; st.checksum = have; st.dest = final; st.done = sel.size; emit(); report.push(entry(sel, st)); continue; }
        }
        final = uniqueName(final);
      }

      st.state = 'copying'; st.dest = final; emit();
      const part = final + PART;
      await fsp.rm(part, { force: true });
      let last = 0;
      const got = await hashStream(src, part, (n) => { st.done += n; if (Date.now() - last > 400) { last = Date.now(); emit(); } }, signal);
      if (want && got !== want) { await fsp.rm(part, { force: true }); st.state = 'failed'; st.error = 'card data did not match the checksum from the NAS'; st.done = 0; emit(); continue; }
      st.state = 'copied'; emit();
      const back = await hashStream(part, null, null, signal);
      if (back !== got) { await fsp.rm(part, { force: true }); st.state = 'failed'; st.error = 'copy did not verify on this computer'; st.done = 0; emit(); continue; }
      await fsp.rename(part, final);
      try { await fsp.utimes(final, s.atime, s.mtime); } catch (e) { /* cosmetic */ }
      st.state = 'verified'; st.checksum = got; emit(); report.push(entry(sel, st));
    } catch (e) {
      if (e.message === 'cancelled') return fail('paused', 'Stopped.');
      if (e.code === 'ENOSPC') return fail('failed', 'This computer ran out of disk space. Free some room and resume.');
      if (['ENOENT', 'EIO', 'ENOTCONN', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN'].includes(e.code)) return fail('paused', 'Lost the connection to the card. Reconnect it and resume; finished files are kept.');
      if (e.code === 'EACCES' || e.code === 'EPERM') { st.state = 'failed'; st.error = 'no permission to write here'; emit(); continue; }
      st.state = 'failed'; st.error = String(e.code || e.message); emit();
    }
  }
  const bad = L.files.filter((f) => f.state === 'failed').length;
  if (L.dir && report.length) {
    try {
      await fsp.writeFile(path.join(L.dir, `Harbor offload report${L.roll ? ' ' + L.roll : ''}.json`), JSON.stringify({
        card: job.manifest.card.label || job.manifest.card.fingerprint, fingerprint: job.manifest.card.fingerprint, roll: L.roll,
        origin: job.origin || null, started_at: L.started_at, finished_at: new Date().toISOString(), algorithm: 'xxh64', files: report,
      }, null, 2));
    } catch (e) { /* report is best effort */ }
  }
  L.state = bad ? 'failed' : 'done';
  L.message = bad ? `${bad} file${bad === 1 ? '' : 's'} could not be copied. Run it again to retry them.` : null;
  emit();
  return L;
}

const entry = (sel, st) => ({ relative_path: sel.relative_path, size: sel.size, checksum: st.checksum, saved_as: st.dest, state: st.state });
const fmt = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
function progressOf(L) {
  const total = L.files.reduce((a, f) => a + f.size, 0) || 1;
  // Copy is the first half, read-back verify the second.
  const w = { pending: 0, copying: 0, copied: 0.5, verified: 1, skipped: 1, failed: 0 };
  return L.files.reduce((a, f) => a + f.size * (f.state === 'copying' ? 0.5 * (f.done / (f.size || 1)) : w[f.state]), 0) / total;
}

module.exports = { runLocalIngest, inspectDest, assignRoll, layout, hashStream, SPACE_MARGIN };
