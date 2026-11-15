'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLocalIngest, inspectDest, hashStream } = require('../core/localcopy');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-lc-'));
async function setup() {
  const card = tmp(), dest = tmp();
  fs.mkdirSync(path.join(card, 'PRIVATE/CLIP'), { recursive: true });
  fs.writeFileSync(path.join(card, 'PRIVATE/CLIP/C1.MP4'), Buffer.alloc(3 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(card, 'PRIVATE/CLIP/C2.MP4'), Buffer.alloc(1000, 9));
  const files = [];
  for (const n of ['C1.MP4', 'C2.MP4']) {
    const rel = 'PRIVATE/CLIP/' + n; const p = path.join(card, rel);
    files.push({ relative_path: rel, size: fs.statSync(p).size, checksum: await hashStream(p), media_type: 'video' });
  }
  const manifest = { card: { fingerprint: 'AB-1', label: 'A' }, files };
  const job = (over = {}) => ({ manifest, cardRoot: card, selection: files, destRoot: dest, project: 'Shoot', dit: { day: '2026-11-15', group: 'Camera A', roll_prefix: 'A' }, subfolderMap: { video: 'Footage/Video' }, ...over });
  return { card, dest, files, job };
}

test('copies, verifies, assigns a roll and writes a report', async () => {
  const { dest, job } = await setup();
  const r = await runLocalIngest(job());
  assert.equal(r.state, 'done'); assert.equal(r.roll, 'A001');
  assert.ok(r.files.every((f) => f.state === 'verified'));
  const out = path.join(dest, 'Shoot/2026-11-15/Camera A/A001/PRIVATE/CLIP/C1.MP4');
  assert.equal(fs.statSync(out).size, 3 * 1024 * 1024);
  assert.ok(fs.existsSync(path.join(dest, 'Shoot/2026-11-15/Camera A/A001/Harbor offload report A001.json')));
  assert.equal(fs.readdirSync(path.dirname(out)).filter((n) => n.endsWith('.harbor-part')).length, 0);
});

test('re-running the same card skips finished files and keeps the roll', async () => {
  const { job } = await setup();
  const j = job(); await runLocalIngest(j);
  const r = await runLocalIngest(j);
  assert.equal(r.roll, 'A001'); assert.ok(r.files.every((f) => f.state === 'skipped')); assert.equal(r.state, 'done');
});

test('a different file with the same name is kept, never overwritten', async () => {
  const { dest, job } = await setup();
  const j = job({ dit: null });
  const dir = path.join(dest, 'Shoot/Footage/Video'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'C2.MP4'), 'someone else');
  const r = await runLocalIngest(j);
  assert.equal(r.state, 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'C2.MP4'), 'utf8'), 'someone else');
  assert.ok(fs.existsSync(path.join(dir, 'C2 (2).MP4')));
});

test('a second card gets the next roll', async () => {
  const { job } = await setup();
  await runLocalIngest(job());
  const other = job(); other.manifest = { ...other.manifest, card: { fingerprint: 'ZZ-9', label: 'B' } };
  assert.equal((await runLocalIngest(other)).roll, 'A002');
});

test('a card file that no longer matches the NAS checksum fails, and no partial file is left', async () => {
  const { card, dest, job } = await setup();
  fs.writeFileSync(path.join(card, 'PRIVATE/CLIP/C2.MP4'), Buffer.alloc(1000, 1));
  const r = await runLocalIngest(job());
  assert.equal(r.state, 'failed');
  assert.deepEqual(r.files.map((f) => f.state), ['verified', 'failed']);
  const dir = path.join(dest, 'Shoot/2026-11-15/Camera A/A001/PRIVATE/CLIP');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['C1.MP4']);
});

test('card pulled mid-job pauses instead of failing, and resuming finishes', async () => {
  const { card, job } = await setup();
  const hidden = card + '-away'; const j = job();
  let n = 0;
  const r = await runLocalIngest(j, (L) => { if (L.files[0] && L.files[0].state === 'verified' && !n++) fs.renameSync(card, hidden); });
  assert.equal(r.state, 'paused'); assert.equal(r.files[0].state, 'verified');
  fs.renameSync(hidden, card);
  const r2 = await runLocalIngest(j);
  assert.equal(r2.state, 'done'); assert.equal(r2.files[0].state, 'skipped'); assert.equal(r2.files[1].state, 'verified');
});

test('refuses without room, without a card, or when the destination is on the card', async () => {
  const { card, files, job } = await setup();
  const big = job({ selection: files.map((f) => ({ ...f, size: f.size })) });
  const orig = fs.statfsSync; fs.statfsSync = () => ({ bavail: 1, bsize: 1024 });
  try { const r = await runLocalIngest(big); assert.equal(r.state, 'failed'); assert.match(r.message, /Not enough room/); } finally { fs.statfsSync = orig; }
  assert.equal((await runLocalIngest(job({ cardRoot: null }))).state, 'paused');
  assert.match((await runLocalIngest(job({ destRoot: path.join(card, 'copy') }))).message, /on the card/);
  assert.equal((await runLocalIngest(job({ project: '../x' }))).state, 'failed');
  assert.equal(inspectDest('/definitely/not/here/yet').exists, false);
});

test('a nested project path lands in nested folders', async () => {
  const { dest, job } = await setup();
  const r = await runLocalIngest(job({ project: 'Client A/Shoot 5', dit: null }));
  assert.equal(r.state, 'done');
  assert.ok(fs.existsSync(path.join(dest, 'Client A', 'Shoot 5', 'Footage/Video', 'C1.MP4')));
  assert.equal((await runLocalIngest(job({ project: 'A/../B' }))).state, 'failed');
});
