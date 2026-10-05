'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const share = require('./core/share');
const { buildTicket } = require('./core/ticket');
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
  if (!Notification.isSupported()) return;
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
    for (const k of ['shareRoot', 'machine', 'user', 'subfolderMap', 'lastRoot']) if (k in patch) allowed[k] = patch[k];
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
      manifest, selected: req.selected, projectName: req.projectName, approvedRoot: req.approvedRoot,
      subfolderMap: req.subfolderMap, clearCard: !!req.clearCard && !!(latest.daemon.info && latest.daemon.info.allow_clear),
      origin: origin(),
    });
    share.submitTicket(root, ticket);
    store.saveSettings({ lastRoot: req.approvedRoot, subfolderMap: ticket.destination.subfolder_map });
    store.addHistory({
      ticket_id: ticket.ticket_id, project: ticket.destination.project_name, fingerprint: req.fingerprint,
      cardLabel: manifest.card.label, files: ticket.selection.length,
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

  ipcMain.handle('harbor:openReport', async (_e, ticketId) => {
    if (!share.UUID.test(ticketId)) return false;
    const p = path.join(share.dirs(store.settings().shareRoot).logs, ticketId + '.report.json');
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
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
