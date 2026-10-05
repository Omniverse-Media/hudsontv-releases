'use strict';
// Renderer: builds DOM with textContent only (card names and paths are untrusted input).

const MEDIA = ['video', 'audio', 'photo', 'other'];
const S = {
  settings: null, history: [], cards: new Map(), daemon: { online: false, info: null }, share: { ok: false },
  statuses: new Map(), view: null, // {kind:'card'|'job', id}
  ui: new Map(), // fingerprint -> {showAll, types:Set, selected:Set|null, project, root}
};

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed by CSP; style attributes are not
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmtBytes = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const fmtDur = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

function cardUi(fp) {
  if (!S.ui.has(fp)) S.ui.set(fp, { showAll: false, types: new Set(MEDIA), selected: null, project: '', root: '' });
  return S.ui.get(fp);
}

// ---------- boot ----------
async function init() {
  const st = await window.harbor.getState();
  S.settings = st.settings; S.history = st.history; S.daemon = st.daemon; S.share = st.share;
  for (const m of st.cards) S.cards.set(m.card.fingerprint, m);
  window.harbor.onEvent(onEvent);
  $('btn-settings').addEventListener('click', openSettings);
  const firstCard = [...S.cards.values()].find((m) => m.present);
  if (firstCard) S.view = { kind: 'card', id: firstCard.card.fingerprint };
  if (!S.settings.shareRoot) openSettings();
  renderAll();
}

function onEvent({ type, payload }) {
  if (type === 'card') {
    S.cards.set(payload.manifest.card.fingerprint, payload.manifest);
    if (!S.view) S.view = { kind: 'card', id: payload.manifest.card.fingerprint };
  } else if (type === 'card-gone') S.cards.delete(payload);
  else if (type === 'daemon') S.daemon = payload;
  else if (type === 'share') S.share = payload;
  else if (type === 'status') S.statuses.set(payload.ticket_id, payload);
  renderAll();
}

// ---------- chrome ----------
function renderAll() {
  const pill = $('daemon-pill');
  pill.textContent = S.daemon.online ? 'Daemon online' : 'Daemon offline';
  pill.className = 'pill ' + (S.daemon.online ? 'on' : 'off');
  const b = $('banner');
  if (!S.share.ok) { b.textContent = S.share.error || 'Harbor share not connected.'; b.className = 'banner bad'; }
  else if (!S.daemon.online) { b.textContent = 'The Harbor daemon is not responding. You can queue nothing until it is back.'; b.className = 'banner warn'; }
  else b.className = 'banner hidden';
  renderNav();
  renderView();
}

function renderNav() {
  const cl = $('card-list'); cl.replaceChildren();
  const cards = [...S.cards.values()].filter((m) => m.present);
  if (!cards.length) cl.append(h('div', { class: 'empty' }, 'No card inserted'));
  for (const m of cards) {
    const recent = m.files.filter((f) => f.recent).length;
    cl.append(h('li', { class: sel('card', m.card.fingerprint), onclick: () => { S.view = { kind: 'card', id: m.card.fingerprint }; renderAll(); } },
      h('div', { class: 't' }, m.card.label || m.card.fingerprint),
      h('div', { class: 's' }, `${recent} new · ${m.files.length} total`)));
  }
  const jl = $('job-list'); jl.replaceChildren();
  if (!S.history.length) jl.append(h('div', { class: 'empty' }, 'No jobs yet'));
  for (const j of S.history.slice(0, 30)) {
    const st = S.statuses.get(j.ticket_id);
    jl.append(h('li', { class: sel('job', j.ticket_id), onclick: () => { S.view = { kind: 'job', id: j.ticket_id }; renderAll(); } },
      h('div', { class: 't' }, j.project),
      h('div', { class: 's' }, `${st ? stateLabel(st) : 'queued'} · ${j.files} files · ${fmtTime(j.created_at)}`)));
  }
}
const sel = (kind, id) => (S.view && S.view.kind === kind && S.view.id === id ? 'sel' : '');
function stateLabel(st) {
  if (st.state === 'done') return window.HarborLogic.allVerified(st) ? 'verified' : 'done';
  return st.state.replace('_', ' ');
}

function renderView() {
  const v = $('view');
  // Keep scroll/typing state: only rebuild when nothing in the form has focus.
  if (v.contains(document.activeElement) && document.activeElement.type === 'text' && S.view && S.view.kind === 'card') return;
  v.replaceChildren();
  if (!S.view) { v.append(h('div', { class: 'empty' }, 'Insert a card into the NAS USB port. Harbor will notify you when it is detected.')); return; }
  if (S.view.kind === 'card') {
    const m = S.cards.get(S.view.id);
    if (!m || !m.present) { v.append(h('div', { class: 'empty' }, 'This card is no longer inserted.')); return; }
    renderCard(v, m);
  } else renderJob(v, S.view.id);
}

// ---------- card view ----------
function renderCard(v, m) {
  const ui = cardUi(m.card.fingerprint);
  const hashing = m.checksum_state !== 'complete';
  const visible = m.files.filter((f) => (ui.showAll || f.recent) && ui.types.has(f.media_type));
  if (ui.selected === null) ui.selected = new Set(m.files.filter((f) => f.recent).map((f) => f.relative_path));
  const roots = (S.daemon.info && S.daemon.info.approved_roots) || [];
  if (!ui.root) ui.root = roots.includes(S.settings.lastRoot) ? S.settings.lastRoot : roots[0] || '';

  v.append(h('h2', {}, m.card.label || m.card.fingerprint));
  v.append(h('div', { class: 'meta' }, `Card ${m.card.fingerprint} · ${m.profiles_matched.join(', ') || 'unknown structure'} · ${m.last_ingest_at ? 'last ingested ' + fmtTime(m.last_ingest_at) : 'never ingested'}`));
  if (!m.profile_matched) v.append(h('div', { class: 'note warn' }, 'Unknown card structure. Harbor is showing every file on the card so nothing is missed. Check the file types below.'));
  if (m.card.fingerprint_source === 'synthesized') v.append(h('div', { class: 'note warn' }, 'This card has no readable volume serial, so its identity is estimated. "New file" tracking may be less reliable.'));
  if (hashing) {
    const pct = Math.round((m.checksum_progress || 0) * 100);
    v.append(h('div', { class: 'note warn' }, `Scanning card: calculating checksums (${pct}%). You can pick files now; ingest unlocks when this finishes.`),
      h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })));
  }

  v.append(h('div', { class: 'toolbar' },
    h('label', {}, h('input', { type: 'checkbox', checked: ui.showAll, onchange: (e) => { ui.showAll = e.target.checked; renderAll(); } }), ' Show everything on the card'),
    h('span', { class: 'chips' }, MEDIA.map((t) => h('button', { class: ui.types.has(t) ? 'on' : '', onclick: () => { ui.types.has(t) ? ui.types.delete(t) : ui.types.add(t); renderAll(); } }, t))),
    h('span', { class: 'spacer' }),
    h('button', { class: 'ghost', onclick: () => { visible.forEach((f) => ui.selected.add(f.relative_path)); renderAll(); } }, 'Select shown'),
    h('button', { class: 'ghost', onclick: () => { visible.forEach((f) => ui.selected.delete(f.relative_path)); renderAll(); } }, 'Clear shown')));

  const body = h('tbody');
  for (const f of visible) {
    body.append(h('tr', { class: f.recent ? 'recent' : '' },
      h('td', {}, h('input', { type: 'checkbox', checked: ui.selected.has(f.relative_path), onchange: (e) => { e.target.checked ? ui.selected.add(f.relative_path) : ui.selected.delete(f.relative_path); updateSummary(m); } })),
      h('td', { class: 'path' }, f.relative_path),
      h('td', {}, f.media_type),
      h('td', { class: 'num' }, fmtBytes(f.size)),
      h('td', { class: 'num' }, fmtDur(f.duration)),
      h('td', { class: 'num' }, fmtTime(f.timestamp))));
  }
  v.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'File'), h('th', {}, 'Type'), h('th', {}, 'Size'), h('th', {}, 'Length'), h('th', {}, 'Time'))), body)));
  if (!visible.length) v.append(h('div', { class: 'empty' }, ui.showAll ? 'No files match.' : 'No new files since the last ingest. Turn on "Show everything on the card" to see all files.'));

  // destination form
  const project = h('input', { type: 'text', placeholder: 'e.g. 2026-10 Hudson Wedding', value: ui.project, oninput: (e) => { ui.project = e.target.value; updateSummary(m); } });
  const rootSel = h('select', { onchange: (e) => { ui.root = e.target.value; } }, roots.map((r) => h('option', { value: r, selected: r === ui.root }, r)));
  const folders = h('details', {}, h('summary', {}, 'Subfolders'), h('div', { class: 'folders' }, MEDIA.flatMap((t) => [h('label', {}, t),
    h('input', { type: 'text', value: S.settings.subfolderMap[t], onchange: (e) => { S.settings.subfolderMap[t] = e.target.value; window.harbor.saveSettings({ subfolderMap: S.settings.subfolderMap }); } })])));
  const canClear = !!(S.daemon.info && S.daemon.info.allow_clear);
  const clearBox = h('input', { type: 'checkbox', checked: !!ui.clear, onchange: (e) => { ui.clear = e.target.checked; } });
  v.append(h('div', { class: 'form' },
    h('label', {}, 'Project folder'), project,
    h('label', {}, 'Destination'), rootSel,
    h('label', {}, 'Folders'), folders,
    canClear ? h('label', {}, 'After verifying') : null, canClear ? h('label', {}, clearBox, ' Allow clearing this card afterwards (you will confirm separately)') : null,
    h('span'), h('div', {}, h('button', { id: 'btn-ingest', onclick: () => submit(m) }, 'Ingest'), ' ', h('span', { id: 'sum', class: 'meta' }))));
  updateSummary(m);
}

function updateSummary(m) {
  const ui = cardUi(m.card.fingerprint);
  const files = m.files.filter((f) => ui.selected.has(f.relative_path));
  const bytes = files.reduce((a, f) => a + f.size, 0);
  const err = window.HarborLogic.checkProjectName(ui.project);
  const btn = $('btn-ingest'); if (!btn) return;
  btn.disabled = !files.length || !!err || m.checksum_state !== 'complete' || !S.daemon.online || !ui.root;
  $('sum').textContent = `${files.length} files, ${fmtBytes(bytes)}` + (err && ui.project ? ' · ' + err : '');
}

async function submit(m) {
  const ui = cardUi(m.card.fingerprint);
  const btn = $('btn-ingest'); btn.disabled = true;
  try {
    const id = await window.harbor.submit({
      fingerprint: m.card.fingerprint, selected: [...ui.selected], projectName: ui.project,
      approvedRoot: ui.root, subfolderMap: S.settings.subfolderMap, clearCard: !!ui.clear,
    });
    S.history = (await window.harbor.getState()).history;
    S.view = { kind: 'job', id };
    ui.selected = null; ui.project = '';
    renderAll();
  } catch (e) {
    alertDialog('Could not queue the ingest', String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    btn.disabled = false;
  }
}

// ---------- job view ----------
function renderJob(v, id) {
  const j = S.history.find((x) => x.ticket_id === id);
  const st = S.statuses.get(id);
  v.append(h('h2', {}, j ? j.project : id), h('div', { class: 'meta' }, j ? `${j.files} files · ${fmtBytes(j.bytes)} · from ${j.cardLabel || j.fingerprint} · ${fmtTime(j.created_at)}` : ''));
  if (!st) { v.append(h('div', { class: 'note warn' }, 'Waiting for the daemon to pick up this job…')); return; }
  const verified = window.HarborLogic.allVerified(st);
  if (verified) v.append(h('div', { class: 'note ok' }, '✓ All files verified on the server'));
  if (st.state === 'failed') v.append(h('div', { class: 'note bad' }, st.error || 'Job failed.'));
  if (st.message && st.state !== 'done') v.append(h('div', { class: 'note warn' }, st.message));
  v.append(h('div', { class: 'bar' + (verified ? ' ok' : '') }, h('div', { style: `width:${Math.round(st.progress * 100)}%` })));
  v.append(h('div', { class: 'meta' }, `${stateLabel(st)} · ${Math.round(st.progress * 100)}%`));

  const body = h('tbody');
  for (const f of st.files) body.append(h('tr', {}, h('td', { class: 'path' }, f.relative_path), h('td', {}, h('span', { class: 'st ' + f.state }, f.state))));
  v.append(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'State'))), body)));

  const c = st.clear;
  const actions = h('div', { class: 'toolbar' }, h('button', { class: 'ghost', onclick: () => window.harbor.openReport(id) }, 'Show log'));
  if (verified && c && c.state === 'awaiting_confirmation') actions.append(h('button', { class: 'danger', onclick: () => confirmClear(id, st) }, 'Clear card…'));
  v.append(actions);
  if (c && c.state === 'clearing') v.append(h('div', { class: 'note warn' }, 'Clearing card…'));
  if (c && c.state === 'cleared') v.append(h('div', { class: 'note ok' }, `Card cleared (${c.deleted} files removed).`));
  if (c && c.last_error) v.append(h('div', { class: 'note bad' }, 'Clear refused, nothing was deleted: ' + c.last_error));
}

function confirmClear(id, st) {
  const dlg = $('dlg'); dlg.replaceChildren(
    h('h3', {}, 'Clear the card?'),
    h('p', {}, `Harbor will re-check all ${st.files.length} files against the copies on the server, then permanently delete exactly those ${st.files.length} files from the card. Other files on the card are not touched. This cannot be undone.`),
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'danger', onclick: async () => { dlg.close(); try { await window.harbor.confirmClear(id); } catch (e) { alertDialog('Could not request clear', String(e.message || e)); } } }, 'Delete from card')));
  dlg.showModal();
}

function alertDialog(title, msg) {
  const dlg = $('dlg'); dlg.replaceChildren(h('h3', {}, title), h('p', {}, msg), h('div', { class: 'actions' }, h('button', { onclick: () => dlg.close() }, 'OK')));
  dlg.showModal();
}

// ---------- settings ----------
function openSettings() {
  const dlg = $('dlg');
  const share = h('input', { type: 'text', value: S.settings.shareRoot, placeholder: '/Volumes/harbor or Z:\\' });
  const user = h('input', { type: 'text', value: S.settings.user });
  const machine = h('input', { type: 'text', value: S.settings.machine });
  dlg.replaceChildren(h('h3', {}, 'Settings'),
    h('p', { class: 'meta' }, 'Choose the mapped Harbor share. Harbor talks to the NAS only through files on this share, using your existing SMB login.'),
    h('div', { class: 'form', style: 'grid-template-columns:110px 1fr' },
      h('label', {}, 'Harbor share'), h('div', {}, share, ' ', h('button', { class: 'ghost', onclick: async () => { const p = await window.harbor.pickShare(); if (p) share.value = p; } }, 'Browse')),
      h('label', {}, 'Your name'), user, h('label', {}, 'This computer'), machine),
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { onclick: async () => { S.settings = await window.harbor.saveSettings({ shareRoot: share.value.trim(), user: user.value.trim(), machine: machine.value.trim() }); dlg.close(); renderAll(); } }, 'Save')));
  dlg.showModal();
}

window.addEventListener('DOMContentLoaded', init);
