'use strict';
const { app, nativeTheme, powerSaveBlocker, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, shell, nativeImage, protocol, net, powerMonitor } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const share = require('./core/share');
const { buildTicket } = require('./core/ticket');
const { withSidecars } = require('./core/logic');
const { Poller } = require('./core/poller');
const { Store } = require('./core/store');
const playback = require('./core/playback');
const localcopy = require('./core/localcopy');
const announce = require('./core/announce');
const { execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

let win = null;
let promptWin = null;
let tray = null;
let store = null;
let poller = null;
const latest = { cards: new Map(), daemon: { online: false, info: null }, share: { ok: false } };
// The docked-card prompt: which card it is about, and any ticket (ours or another desktop's) already ingesting it.
const localJobs = new Map(); // id -> {id, fingerprint, project, label, destRoot, job, run, aborter}
const prompt = { fingerprint: null, claim: null, mineIds: new Set() };

function send(type, payload) {
  for (const w of [win, promptWin]) if (w && !w.isDestroyed()) w.webContents.send('harbor:event', { type, payload });
}

// A small window that comes to the front when a card is docked, so ingest is one glance and one click.
function showPrompt(manifest) {
  prompt.fingerprint = manifest.card.fingerprint;
  prompt.claim = null;
  send('prompt', promptInfo());
  if (promptWin && !promptWin.isDestroyed()) { promptWin.show(); promptWin.focus(); return; }
  promptWin = new BrowserWindow({
    width: 560, height: 700, minWidth: 460, minHeight: 520, title: 'Card docked', show: false,
    alwaysOnTop: true, fullscreenable: false, minimizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  promptWin.setAlwaysOnTop(true, 'floating');
  promptWin.loadFile(path.join(__dirname, 'renderer', 'prompt.html'));
  promptWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  promptWin.webContents.on('will-navigate', (e) => e.preventDefault());
  promptWin.once('ready-to-show', () => { promptWin.show(); promptWin.focus(); });
  promptWin.on('closed', () => { promptWin = null; prompt.fingerprint = null; prompt.claim = null; });
}

function closePrompt() { if (promptWin && !promptWin.isDestroyed()) promptWin.close(); }
function promptInfo() { return { fingerprint: prompt.fingerprint, claim: prompt.claim }; }

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600, title: 'Harbor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

// Cards announced but not yet acted on: drives the dock badge and the tray entry.
const waiting = new Map(); // fingerprint -> label
function refreshBadge() {
  const mode = announce.announceMode(store.settings());
  const n = mode === 'off' ? 0 : waiting.size;
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(announce.badgeText(n));
  else if (app.setBadgeCount) app.setBadgeCount(n);
  if (tray) {
    if (process.platform === 'darwin') tray.setTitle(n ? ` ${n}` : '');
    tray.setToolTip(n ? `Harbor: ${n} card${n === 1 ? '' : 's'} waiting` : 'Harbor');
    tray.setContextMenu(trayMenu());
  }
}
function clearWaiting(fp) { if (waiting.delete(fp)) refreshBadge(); }
function trayMenu() {
  const cards = [...waiting].map(([fp, label]) => ({ label: `Ingest ${label}…`, click: () => { const m = latest.cards.get(fp); if (m) showPrompt(m); else showWindow(); } }));
  return Menu.buildFromTemplate([...cards, ...(cards.length ? [{ type: 'separator' }] : []),
    { label: 'Open Harbor', click: showWindow }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]);
}

// The user chooses how a docked card shows up: pop-up window, system banner with buttons, badge only, or nothing.
function notifyCard(manifest, { test = false } = {}) {
  if (manifest.role === 'ignored') return;
  const settings = store.settings();
  const mode = announce.announceMode(settings);
  const sound = announce.soundOn(settings);
  const isCard = !manifest.role || manifest.role === 'card';
  const label = manifest.card.label || manifest.card.fingerprint;
  if (mode === 'off') return;
  if (isCard && !test) { waiting.set(manifest.card.fingerprint, label); refreshBadge(); }
  if (mode === 'badge') { if (!isCard && Notification.isSupported()) banner(manifest, label, sound); return; }
  if (isCard && mode === 'popup') { if (sound) shell.beep(); showPrompt(manifest); return; }
  if (Notification.isSupported()) banner(manifest, label, sound);
}

function banner(manifest, label, sound) {
  const isCard = !manifest.role || manifest.role === 'card';
  const recent = manifest.files.filter((f) => f.recent).length;
  const n = new Notification({
    title: isCard ? `${label} docked` : 'USB drive found on the NAS',
    body: isCard ? `${recent} new file${recent === 1 ? '' : 's'} · ${manifest.files.length} on the card` : `${label}: is this a card to ingest? Choose in Harbor.`,
    silent: !sound,
    ...(sound && process.platform === 'darwin' ? { sound: 'Glass' } : {}),
    ...(isCard ? { actions: [{ type: 'button', text: 'Ingest…' }], closeButtonText: 'Later' } : {}),
  });
  // Clicking the banner or "Ingest…" opens the prompt for that card, the same window as pop-up mode.
  const go = () => (isCard ? showPrompt(manifest) : showWindow());
  n.on('click', go);
  n.on('action', go);
  n.show();
}

// ---- local destination (copy to a folder on this computer) ----
function cardRootFor(fingerprint) {
  const manifest = latest.cards.get(fingerprint);
  return manifest ? playback.findCardRoot(manifest, { override: (store.settings().cardRoots || {})[fingerprint] }) : null;
}
function inspectLocal(fingerprint, dir) {
  const info = dir && path.isAbsolute(dir) ? localcopy.inspectDest(dir) : { exists: false, free: null, writable: false };
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch (e) { /* new folder */ }
  const manifest = latest.cards.get(fingerprint);
  return { ...info, projects, cardMounted: !!cardRootFor(fingerprint), cardShare: manifest ? playback.cardShareName(manifest) : null };
}
const publicLocal = (j) => ({ id: j.id, fingerprint: j.fingerprint, project: j.project, label: j.label, destRoot: j.destRoot, state: j.state });

function startLocal(req) {
  const manifest = latest.cards.get(req.fingerprint);
  if (!manifest || !manifest.present) throw new Error('That card is no longer present.');
  if (manifest.checksum_state !== 'complete') throw new Error('The card is still being scanned.');
  const byPath = new Map(manifest.files.map((f) => [f.relative_path, f]));
  const selection = withSidecars(manifest.files, req.selected).map((rel) => {
    const f = byPath.get(rel);
    return { relative_path: rel, size: f.size, checksum: f.checksum || null };
  });
  if (!selection.length) throw new Error('Select at least one file.');
  const dit = req.dit ? { day: req.dit.day, group: req.dit.group, roll_prefix: require('./core/logic').rollPrefix(req.dit.group) } : null;
  clearWaiting(req.fingerprint);
  const id = crypto.randomUUID();
  const j = { id, fingerprint: req.fingerprint, project: (req.projectName || '').trim(), label: manifest.card.label || req.fingerprint, destRoot: req.localRoot,
    job: { manifest, selection, destRoot: req.localRoot, project: req.projectName, dit, subfolderMap: req.subfolderMap, origin: origin() }, state: null, aborter: null };
  localJobs.set(id, j);
  runLocal(j);
  return id;
}

function resumeLocal(id) {
  const j = localJobs.get(id);
  if (!j || (j.aborter && !j.aborter.signal.aborted && j.state && j.state.state === 'running')) return false;
  j.job.manifest = latest.cards.get(j.fingerprint) || j.job.manifest;
  runLocal(j);
  return true;
}

// Files that made it to this computer are reported to the NAS, so the card doesn't keep offering them as new.
// Only files not yet reported (a resumed job reports the rest); best effort, the copy itself already succeeded.
function noteLocalIngest(j, res) {
  const ok = (res && res.files || []).filter((f) => f.state === 'verified' || f.state === 'skipped').map((f) => f.relative_path);
  const fresh = ok.filter((r) => !(j.noted || (j.noted = new Set())).has(r));
  if (!fresh.length) return;
  try {
    share.submitLocalIngest(store.settings().shareRoot, j.fingerprint, fresh, origin());
    fresh.forEach((r) => j.noted.add(r));
  } catch (e) { /* the NAS is unreachable right now: the copy is still good */ }
}

function runLocal(j) {
  j.aborter = new AbortController();
  j.job.cardRoot = cardRootFor(j.fingerprint);
  // Keep the computer awake while copying: sleep would drop the SMB mount mid-file.
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  localcopy.runLocalIngest(j.job, (st) => { j.state = { ...st, files: st.files.map((f) => ({ ...f })) }; send('local', publicLocal(j)); }, j.aborter.signal)
    .then((res) => noteLocalIngest(j, res))
    .catch((e) => { j.state = { state: 'failed', message: String(e.message || e), progress: 0, files: [] }; send('local', publicLocal(j)); })
    .finally(() => { powerSaveBlocker.stop(blocker); });
}

// Dark, light or follow the system: nativeTheme drives prefers-color-scheme in every window.
function applyTheme() { nativeTheme.themeSource = ['dark', 'light'].includes(store.settings().theme) ? store.settings().theme : store.settings().theme === 'auto' ? 'system' : 'dark'; }

function origin() {
  const s = store.settings();
  return { machine: s.machine, user: s.user };
}

function setupIpc() {
  ipcMain.handle('harbor:getState', () => ({
    settings: store.settings(),
    history: store.history(),
    cards: [...latest.cards.values()],
    daemon: latest.daemon,
    share: latest.share,
    reconnect: { busy: reconnect.busy, failed: reconnect.failed, url: store.settings().shareUrl || null },
    prompt: promptInfo(),
    localJobs: [...localJobs.values()].map(publicLocal),
  }));

  ipcMain.handle('harbor:openMain', (_e, fingerprint) => {
    showWindow();
    send('focus-card', fingerprint || null);
    if (fingerprint) clearWaiting(fingerprint);
    closePrompt();
  });
  ipcMain.handle('harbor:dismissPrompt', () => closePrompt());
  // "Try it" button in Settings: announces the card on screen (or a sample) the way a real dock would, without a badge.
  ipcMain.handle('harbor:testAnnounce', () => {
    const real = [...latest.cards.values()].find((m) => m.present && (!m.role || m.role === 'card'));
    notifyCard(real || { role: 'card', card: { fingerprint: 'TEST', label: 'Sample card' }, files: [{ recent: true }, { recent: true }, { recent: false }], present: true, checksum_state: 'complete' }, { test: true });
  });

  ipcMain.handle('harbor:saveSettings', (_e, patch) => {
    const allowed = {};
    for (const k of ['shareRoot', 'machine', 'user', 'subfolderMap', 'lastRoot', 'organize', 'groups', 'cardGroups', 'cardLooks', 'dockPrompt', 'theme', 'announce', 'announceSound', 'localRoot', 'destMode']) if (k in patch) allowed[k] = patch[k];
    const s = store.saveSettings(allowed);
    if ('shareRoot' in allowed) poller.tick();
    if ('announce' in allowed) refreshBadge();
    if ('theme' in allowed) applyTheme();
    return s;
  });

  ipcMain.handle('harbor:reconnect', () => tryReconnect(true));

  ipcMain.handle('harbor:pickShare', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select the mapped Harbor share' });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('harbor:submit', (_e, req) => submitNas(req));

  // Destination can be the NAS, a folder on this computer, or both. Local copies read the card over SMB.
  ipcMain.handle('harbor:ingest', (_e, req) => {
    const mode = req.mode || 'nas';
    if (!['nas', 'local', 'both'].includes(mode)) throw new Error('Unknown destination.');
    const out = { ticketId: null, localId: null };
    if (mode !== 'nas') {
      const lr = req.localRoot;
      if (!lr || !path.isAbsolute(lr)) throw new Error('Choose a folder on this computer.');
      const cur = inspectLocal(req.fingerprint, lr);
      if (!cur.cardMounted) throw new Error('This computer can\'t see the card yet. Press Connect card first.');
      store.saveSettings({ localRoot: lr });
    }
    if (mode !== 'local') out.ticketId = submitNas(req); // first, so a bad NAS request stops before any local copy
    if (mode !== 'nas') out.localId = startLocal(req);
    store.saveSettings({ destMode: mode });
    return out;
  });

  // "Browse…" for a NAS folder: the Finder-style dialog starts in the destination share as mounted on this
  // computer; the choice is turned back into a folder path inside that share (the NAS decides what is allowed).
  ipcMain.handle('harbor:browseNas', async (_e, label) => {
    const base = ['/Volumes', path.join(os.homedir(), 'Volumes')].map((d) => path.join(d, String(label || ''))).find((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
    if (!base) return { error: `Open the "${label}" share on this computer first (Finder > Go > Connect to Server), then try again.` };
    const r = await dialog.showOpenDialog(promptWin && promptWin.isFocused() ? promptWin : win, { properties: ['openDirectory', 'createDirectory'], defaultPath: base, title: `Choose a folder in ${label}` });
    if (r.canceled) return null;
    const rel = path.relative(base, r.filePaths[0]).split(path.sep).filter(Boolean);
    if (rel[0] === '..' || path.isAbsolute(path.relative(base, r.filePaths[0]))) return { error: `Pick a folder inside ${label}.` };
    if (!rel.length) return { error: `Pick a folder inside ${label}, not the share itself.` };
    return { project: rel.join('/'), exists: true };
  });

  ipcMain.handle('harbor:pickLocalDest', async () => {
    const r = await dialog.showOpenDialog(promptWin && promptWin.isFocused() ? promptWin : win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder on this computer' });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('harbor:localInfo', (_e, fingerprint, dir) => inspectLocal(fingerprint, dir));
  ipcMain.handle('harbor:resumeLocal', (_e, id) => resumeLocal(id));
  ipcMain.handle('harbor:revealLocal', (_e, id) => { const j = localJobs.get(id); if (j && j.state && j.state.dir) shell.showItemInFolder(j.state.dir); return !!(j && j.state && j.state.dir); });

  function submitNas(req) {
    const root = store.settings().shareRoot;
    // Build from the manifest on the share, not from anything the renderer claims about files.
    const manifest = share.listCards(root).find((m) => m.card.fingerprint === req.fingerprint);
    if (!manifest || !manifest.present) throw new Error('That card is no longer present.');
    const ticket = buildTicket({
      manifest, selected: withSidecars(manifest.files, req.selected), projectName: req.projectName, approvedRoot: req.approvedRoot,
      subfolderMap: req.subfolderMap, clearCard: !!req.clearCard && !!(latest.daemon.info && latest.daemon.info.allow_clear),
      origin: origin(), dit: req.dit || null,
    });
    share.submitTicket(root, ticket);
    const patch = { lastRoot: req.approvedRoot, subfolderMap: ticket.destination.subfolder_map };
    if (req.dit) patch.cardGroups = { ...store.settings().cardGroups, [req.fingerprint]: req.dit.group };
    store.saveSettings(patch);
    store.addHistory({
      ticket_id: ticket.ticket_id, project: ticket.destination.project_name, fingerprint: req.fingerprint,
      cardLabel: manifest.card.label, files: ticket.selection.length, group: req.dit ? req.dit.group : null,
      bytes: ticket.selection.reduce((a, f) => a + f.size, 0), created_at: ticket.created_at,
    });
    poller.watch(ticket.ticket_id);
    prompt.mineIds.add(ticket.ticket_id);
    clearWaiting(req.fingerprint);
    return ticket.ticket_id;
  }

  ipcMain.handle('harbor:confirmClear', (_e, ticketId) => {
    const root = store.settings().shareRoot;
    // The token comes from the daemon's status file; the renderer never supplies it.
    const st = share.readStatus(root, ticketId);
    if (!st || st.state !== 'done' || !st.clear || st.clear.state !== 'awaiting_confirmation') {
      throw new Error('This job is not ready to clear.');
    }
    share.submitClearConfirm(root, ticketId, st.clear.token, origin());
    poller.watch(ticketId);
  });

  ipcMain.handle('harbor:setVolumeRole', (_e, fingerprint, role) => {
    const root = store.settings().shareRoot;
    const manifest = share.listCards(root).find((m) => m.card.fingerprint === fingerprint);
    if (!manifest || !manifest.present) throw new Error('That USB drive is no longer present.');
    share.submitVolumeRole(root, fingerprint, role, origin());
  });

  // Playback: the renderer names a clip by card + relative path; only files in the card's manifest resolve.
  const clipFile = (fingerprint, rel) => {
    const manifest = latest.cards.get(fingerprint);
    const f = manifest && manifest.files.find((x) => x.relative_path === rel && playback.PREVIEWABLE.has(x.media_type));
    if (!f) throw new Error('That clip is not on the card.');
    const root = playback.findCardRoot(manifest, { override: (store.settings().cardRoots || {})[fingerprint] });
    return { manifest, f, root, file: root && playback.clipPath(root, rel) };
  };

  ipcMain.handle('harbor:resolveClip', (_e, fingerprint, rel) => {
    const { manifest, file } = clipFile(fingerprint, rel);
    const look = (store.settings().cardLooks || {})[fingerprint] || playback.guessLook(manifest);
    if (!file) return { mounted: false, share: playback.cardShareName(manifest), look };
    const token = crypto.randomBytes(12).toString('hex');
    if (mediaTokens.size > 50) mediaTokens.clear();
    mediaTokens.set(token, file);
    return { mounted: true, url: `harbor-media://clip/${token}`, inside: playback.canPlayInside(rel), look, image: playback.isImage(rel) };
  });

  ipcMain.handle('harbor:connectCard', async (_e, fingerprint) => {
    const manifest = latest.cards.get(fingerprint);
    const shareName = manifest && playback.cardShareName(manifest);
    let host = null;
    try { host = playback.smbHost(execFileSync('/sbin/mount', { encoding: 'utf8' }), store.settings().shareRoot); } catch (e) { /* not macOS */ }
    if (!shareName || !host) return false;
    // Finder mounts it with the Harbor share's saved login; it appears under /Volumes.
    await shell.openExternal(`smb://${host}/${encodeURIComponent(shareName)}`);
    return true;
  });

  ipcMain.handle('harbor:pickCardFolder', async (_e, fingerprint) => {
    const manifest = latest.cards.get(fingerprint);
    if (!manifest) return false;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select the card\'s folder on the NAS' });
    if (r.canceled) return false;
    if (!playback.findCardRoot(manifest, { override: r.filePaths[0], volumesDir: '/nonexistent' })) return false;
    store.saveSettings({ cardRoots: { ...(store.settings().cardRoots || {}), [fingerprint]: r.filePaths[0] } });
    return true;
  });

  ipcMain.handle('harbor:openClipExternally', async (_e, fingerprint, rel) => {
    const { file } = clipFile(fingerprint, rel);
    if (!file) return false;
    return (await shell.openPath(file)) === '';
  });

  ipcMain.handle('harbor:openReport', async (_e, ticketId) => {
    if (!share.UUID.test(ticketId)) return false;
    const p = path.join(share.dirs(store.settings().shareRoot).logs, ticketId + '.report.json');
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
}

// Card previews live on the share; the renderer may load only files inside tickets/thumbs.
protocol.registerSchemesAsPrivileged([
  { scheme: 'harbor-thumb', privileges: { standard: true, secure: true } },
  { scheme: 'harbor-media', privileges: { standard: true, secure: true, stream: true, corsEnabled: true, supportFetchAPI: true } },
]);

function registerThumbProtocol() {
  protocol.handle('harbor-thumb', (req) => {
    // harbor-thumb://card/<fingerprint>/<name>: the fingerprint goes in the path because hosts are lowercased.
    const parts = new URL(req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [fp, name] = parts.length === 2 ? parts : ['', ''];
    const root = store.settings().shareRoot;
    if (!root || !share.FINGERPRINT.test(fp) || !/^[0-9a-f]{20}\.jpg$/.test(name)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path.join(share.dirs(root).thumbs, fp, name)).toString());
  });
}

// harbor-media://clip/<token> streams one resolved clip with byte ranges, so the player can seek.
const mediaTokens = new Map();
function registerMediaProtocol() {
  protocol.handle('harbor-media', async (req) => {
    const file = mediaTokens.get(new URL(req.url).pathname.replace(/^\//, ''));
    let size;
    try { size = file && fs.statSync(file).size; } catch (e) { size = null; }
    if (!size) return new Response(null, { status: 404 });
    const type = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.png$/i.test(file) ? 'image/png' : /\.gif$/i.test(file) ? 'image/gif' : /\.webp$/i.test(file) ? 'image/webp'
      : /\.(mp3|wav|m4a|aac)$/i.test(file) ? 'audio/mp4' : 'video/mp4';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (!m) return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, 'Content-Length': String(size) } });
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206, headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  });
}

// After sleep or a network blip macOS drops the SMB mount. Remember the share's smb:// address while it
// works, and remount it quietly with the saved Keychain login when it goes missing.
const reconnect = { busy: false, lastTry: 0, failed: false };
function smbUrlFor(root) {
  try {
    for (const line of execFileSync('/sbin/mount', { encoding: 'utf8' }).split('\n')) {
      const m = /^\/\/(?:[^@/]+@)?([^/\s]+)\/(\S+) on (.+?) \(smbfs/.exec(line);
      if (m && path.resolve(m[3]) === path.resolve(root)) return `smb://${m[1]}/${m[2]}`;
    }
  } catch (e) { /* not macOS */ }
  return null;
}
function rememberShareUrl() {
  const s = store.settings();
  if (!s.shareRoot) return;
  const url = smbUrlFor(s.shareRoot);
  if (url && url !== s.shareUrl) store.saveSettings({ shareUrl: url });
}
function tryReconnect(force = false) {
  const url = store.settings().shareUrl;
  if (process.platform !== 'darwin' || !url || reconnect.busy) return false;
  if (!force && Date.now() - reconnect.lastTry < 60000) return false;
  reconnect.busy = true; reconnect.lastTry = Date.now();
  send('reconnect', { busy: true, url });
  // `mount volume` uses the Keychain login and shows no Finder window; it asks for a password only if none is saved.
  execFile('/usr/bin/osascript', ['-e', `mount volume ${JSON.stringify(url)}`], { timeout: 45000 }, (err) => {
    reconnect.busy = false; reconnect.failed = !!err;
    send('reconnect', { busy: false, failed: !!err, url });
    if (poller) poller.tick();
  });
  return true;
}

function startPoller() {
  poller = new Poller(() => store.settings().shareRoot, (type, payload) => {
    if (type === 'share') {
      if (payload.ok) { reconnect.failed = false; rememberShareUrl(); } else tryReconnect();
    }
    if (type === 'card') {
      latest.cards.set(payload.manifest.card.fingerprint, payload.manifest);
      if (payload.isNew) notifyCard(payload.manifest);
    } else if (type === 'card-gone') {
      latest.cards.delete(payload);
      clearWaiting(payload);
      if (payload === prompt.fingerprint && !prompt.mineIds.size && !prompt.claim) closePrompt();
    }
    else if (type === 'ticket') {
      // Another desktop (or this one) queued a job for the docked card: show who has it, and follow its progress.
      if (payload.fingerprint === prompt.fingerprint && !prompt.mineIds.has(payload.ticket_id)) {
        const me = origin();
        prompt.claim = { ...payload, by: payload.origin.user || payload.origin.machine || 'Another desktop',
          machine: payload.origin.machine || null, self: payload.origin.machine === me.machine && payload.origin.user === me.user };
        poller.watch(payload.ticket_id);
        send('prompt', promptInfo());
      }
      return;
    } else if (type === 'daemon') latest.daemon = payload;
    else if (type === 'share') latest.share = payload;
    send(type, payload);
  });
  // Resume watching jobs that were still open when the app last closed.
  for (const h of store.history().slice(0, 20)) poller.watch(h.ticket_id);
  poller.start();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    applyTheme();
    registerThumbProtocol();
    registerMediaProtocol();
    setupIpc();
    startPoller();
    createWindow();
    powerMonitor.on('resume', () => setTimeout(() => { if (poller) poller.tick(); }, 4000));
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
    tray.setToolTip('Harbor');
    tray.setContextMenu(trayMenu());
    // With a card waiting, a click on the tray icon goes straight to its prompt.
    tray.on('click', () => { const fp = [...waiting.keys()][0]; const m = fp && latest.cards.get(fp); if (m) showPrompt(m); else showWindow(); });
    refreshBadge();
  });
  // Stay in the tray so card notifications keep working with the window closed.
  app.on('window-all-closed', (e) => { if (process.platform === 'darwin') return; });
  app.on('activate', showWindow);
}
