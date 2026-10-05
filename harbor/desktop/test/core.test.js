'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const share = require('../core/share');
const { buildTicket, checkProjectName, checkSubfolder, allVerified } = require('../core/ticket');
const { Poller } = require('../core/poller');
const { Store } = require('../core/store');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-')); }
function makeShare() {
  const root = tmp();
  for (const d of ['tickets/incoming', 'tickets/status', 'tickets/cards', 'tickets/processed', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}
const manifest = (over = {}) => ({
  present: true, checksum_state: 'complete', scanned_at: 't', profile_matched: true, profiles_matched: ['Sony video'],
  card: { fingerprint: 'ABCD-1234', label: 'usbshare' },
  files: [
    { relative_path: 'PRIVATE/M4ROOT/CLIP/C1.MP4', size: 10, checksum: 'xxh64:aa', media_type: 'video', recent: true },
    { relative_path: 'DCIM/1/D1.ARW', size: 5, checksum: 'xxh64:bb', media_type: 'photo', recent: false },
  ], ...over,
});
const base = (m, over = {}) => ({
  manifest: m, selected: ['PRIVATE/M4ROOT/CLIP/C1.MP4'], projectName: 'Shoot A', approvedRoot: '/projects',
  subfolderMap: {}, clearCard: false, origin: { machine: 'mac', user: 'ed' }, ...over,
});

test('buildTicket produces the spec shape from the manifest', () => {
  const t = buildTicket(base(manifest()));
  assert.match(t.ticket_id, share.UUID);
  assert.deepEqual(t.source, { card_fingerprint: 'ABCD-1234' });
  assert.deepEqual(t.selection, [{ relative_path: 'PRIVATE/M4ROOT/CLIP/C1.MP4', size: 10, checksum: 'xxh64:aa' }]);
  assert.deepEqual(t.operation, { copy: true, verify: true, clear_card: false });
  assert.equal(t.destination.subfolder_map.video, 'Footage/Video');
  assert.equal(t.destination.subfolder_map.other, 'Footage/Other');
});

test('buildTicket refuses bad input before anything reaches the share', () => {
  assert.throws(() => buildTicket(base(manifest(), { projectName: '../evil' })), /cannot contain/);
  assert.throws(() => buildTicket(base(manifest(), { projectName: '' })), /project name/i);
  assert.throws(() => buildTicket(base(manifest(), { selected: [] })), /at least one/);
  assert.throws(() => buildTicket(base(manifest(), { selected: ['nope'] })), /no longer in the manifest/);
  assert.throws(() => buildTicket(base(manifest({ checksum_state: 'pending' }))), /still being scanned/);
  assert.throws(() => buildTicket(base(manifest(), { subfolderMap: { video: '../../etc' } })), /video folder/);
  assert.throws(() => buildTicket(base(manifest(), { approvedRoot: '' })), /destination/i);
});

test('validators', () => {
  assert.equal(checkProjectName('Good Name 1'), null);
  for (const bad of ['', '.', '..', '.hid', 'a/b', 'a\\b']) assert.ok(checkProjectName(bad), bad);
  assert.equal(checkSubfolder('A/B'), null);
  for (const bad of ['', '/abs', 'C:\\x', 'a//b', 'a/../b', './a']) assert.ok(checkSubfolder(bad), bad);
});

test('allVerified follows the spec green state', () => {
  assert.equal(allVerified({ state: 'done', files: [{ state: 'staged' }, { state: 'verified' }] }), true);
  assert.equal(allVerified({ state: 'in_progress', files: [{ state: 'staged' }] }), false);
  assert.equal(allVerified({ state: 'done', files: [{ state: 'staged' }, { state: 'failed' }] }), false);
  assert.equal(allVerified(null), false);
});

test('submitTicket writes atomically into incoming and leaves no temp files', () => {
  const root = makeShare();
  const t = buildTicket(base(manifest()));
  share.submitTicket(root, t);
  const names = fs.readdirSync(share.dirs(root).incoming);
  assert.deepEqual(names, [t.ticket_id + '.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(share.dirs(root).incoming, names[0]))), t);
  assert.throws(() => share.submitTicket(root, { ...t, ticket_id: '../x' }), /bad ticket id/);
});

test('clear confirm file shape', () => {
  const root = makeShare();
  const id = '11111111-1111-4111-8111-111111111111';
  share.submitClearConfirm(root, id, 'tok', { machine: 'm', user: 'u' });
  const j = JSON.parse(fs.readFileSync(path.join(share.dirs(root).incoming, id + '.clear.json')));
  assert.equal(j.type, 'clear_confirm'); assert.equal(j.token, 'tok'); assert.equal(j.ticket_id, id);
});

test('share checks, daemon liveness and card listing', () => {
  const root = makeShare();
  assert.equal(share.checkShare(root).ok, true);
  assert.equal(share.checkShare(path.join(root, 'nope')).ok, false);
  const cards = share.dirs(root).cards;
  fs.writeFileSync(path.join(cards, '_daemon.json'), JSON.stringify({ updated_at: new Date().toISOString(), approved_roots: ['/p'] }));
  assert.equal(share.readDaemonInfo(root).online, true);
  assert.equal(share.readDaemonInfo(root, Date.now() + 120000).online, false);
  fs.writeFileSync(path.join(cards, 'ABCD-1234.json'), JSON.stringify(manifest()));
  fs.writeFileSync(path.join(cards, 'broken.json'), '{half');
  assert.equal(share.listCards(root).length, 1);
});

test('poller emits card appearance (notify only after first scan), removal and status', () => {
  const root = makeShare();
  const events = [];
  const p = new Poller(() => root, (t, d) => events.push([t, d]));
  p.tick(); // first scan, empty
  const cards = share.dirs(root).cards;
  fs.writeFileSync(path.join(cards, 'ABCD-1234.json'), JSON.stringify(manifest()));
  p.tick();
  const card = events.find((e) => e[0] === 'card');
  assert.ok(card && card[1].isNew === true);
  p.tick(); // unchanged: no repeat
  assert.equal(events.filter((e) => e[0] === 'card').length, 1);
  fs.writeFileSync(path.join(cards, 'ABCD-1234.json'), JSON.stringify(manifest({ present: false })));
  p.tick();
  fs.writeFileSync(path.join(cards, 'ABCD-1234.json'), JSON.stringify(manifest({ present: true, scanned_at: 't2' })));
  p.tick();
  const cardEvents = events.filter((e) => e[0] === 'card');
  assert.equal(cardEvents[cardEvents.length - 1][1].isNew, true); // re-insert notifies again
  fs.unlinkSync(path.join(cards, 'ABCD-1234.json'));
  p.tick();
  assert.ok(events.some((e) => e[0] === 'card-gone'));

  const id = '22222222-2222-4222-8222-222222222222';
  p.watch(id);
  fs.writeFileSync(path.join(share.dirs(root).status, id + '.json'), JSON.stringify({ ticket_id: id, state: 'in_progress', files: [], progress: 0.2 }));
  p.tick();
  fs.writeFileSync(path.join(share.dirs(root).status, id + '.json'), JSON.stringify({ ticket_id: id, state: 'done', files: [], progress: 1 }));
  p.tick(); p.tick();
  assert.equal(events.filter((e) => e[0] === 'status').length, 2);
  p.tick();
  assert.equal(p.watched.has(id), false); // terminal and quiet: stops polling
});

test('poller does not stop watching a done job that is awaiting clear confirmation', () => {
  const root = makeShare();
  const p = new Poller(() => root, () => {});
  const id = '33333333-3333-4333-8333-333333333333';
  p.watch(id);
  fs.writeFileSync(path.join(share.dirs(root).status, id + '.json'),
    JSON.stringify({ ticket_id: id, state: 'done', files: [], progress: 1, clear: { state: 'awaiting_confirmation', token: 'x' } }));
  p.tick(); p.tick(); p.tick();
  assert.equal(p.watched.has(id), true);
});

test('store persists settings and caps history', () => {
  const s = new Store(tmp());
  assert.equal(s.settings().shareRoot, '');
  s.saveSettings({ shareRoot: '/Volumes/harbor' });
  assert.equal(s.settings().shareRoot, '/Volumes/harbor');
  for (let i = 0; i < 120; i++) s.addHistory({ ticket_id: 't' + i });
  assert.equal(s.history().length, 100);
  assert.equal(s.history()[0].ticket_id, 't119');
});
