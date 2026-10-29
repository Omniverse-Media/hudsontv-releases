'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, shell, nativeImage, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const share = require('./core/share');
const { buildTicket } = require('./core/ticket');
const { withSidecars } = require('./core/logic');
const { Poller } = require('./core/poller');
const { Store } = require('./core/store');

let win = null;
let tray = null;
let store = null;
let poller = null;
const latest = { cards: new Map(), daemon: { online: false, info: null }, share: { ok: false } };

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('harbor:event', { type, payload });
}

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

function notifyCard(manifest) {
  if (!Notification.isSupported() || manifest.role === 'ignored') return;
  if (manifest.role === 'unassigned') {
    const n = new Notification({
      title: 'USB drive found on the NAS',
      body: `${manifest.card.label || manifest.card.fingerprint}: is this a card to ingest? Choose in Harbor.`,
    });
    n.on('click', showWindow);
    n.show();
    return;
  }
  const recent = manifest.files.filter((f) => f.recent).length;
  const n = new Notification({
    title: 'Card detected in Harbor',
    body: `${manifest.card.label || manifest.card.fingerprint}: ${recent} new file${recent === 1 ? '' : 's'} (${manifest.files.length} total)`,
  });
  n.on('click', showWindow);
  n.show();
}

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
  }));

  ipcMain.handle('harbor:saveSettings', (_e, patch) => {
    const allowed = {};
    for (const k of ['shareRoot', 'machine', 'user', 'subfolderMap', 'lastRoot', 'organize', 'groups', 'cardGroups']) if (k in patch) allowed[k] = patch[k];
    const s = store.saveSettings(allowed);
    if ('shareRoot' in allowed) poller.tick();
    return s;
  });

  ipcMain.handle('harbor:pickShare', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select the mapped Harbor share' });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('harbor:submit', (_e, req) => {
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
    return ticket.ticket_id;
  });

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

  ipcMain.handle('harbor:openReport', async (_e, ticketId) => {
    if (!share.UUID.test(ticketId)) return false;
    const p = path.join(share.dirs(store.settings().shareRoot).logs, ticketId + '.report.json');
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
}

// Card previews live on the share; the renderer may load only files inside tickets/thumbs.
protocol.registerSchemesAsPrivileged([{ scheme: 'harbor-thumb', privileges: { standard: true, secure: true } }]);

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

function startPoller() {
  poller = new Poller(() => store.settings().shareRoot, (type, payload) => {
    if (type === 'card') {
      latest.cards.set(payload.manifest.card.fingerprint, payload.manifest);
      if (payload.isNew) notifyCard(payload.manifest);
    } else if (type === 'card-gone') latest.cards.delete(payload);
    else if (type === 'daemon') latest.daemon = payload;
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
    registerThumbProtocol();
    setupIpc();
    startPoller();
    createWindow();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
    tray.setToolTip('Harbor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Harbor', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  });
  // Stay in the tray so card notifications keep working with the window closed.
  app.on('window-all-closed', (e) => { if (process.platform === 'darwin') return; });
  app.on('activate', showWindow);
}
