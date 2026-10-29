'use strict';
// Renderer: builds DOM with textContent only (card names and paths are untrusted input).

const MEDIA = ['video', 'audio', 'photo', 'other'];
const S = {
  settings: null, history: [], cards: new Map(), daemon: { online: false, info: null }, share: { ok: false },
  statuses: new Map(), view: null, // {kind:'card'|'volume'|'job', id}
  pendingRole: new Map(), // fingerprint -> role the user just picked, until the daemon publishes it
  ui: new Map(), // fingerprint -> {scope:'new'|'all'|null, type, selected:Set|null, project, root}
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

// Older daemons publish no role: everything they publish is a card.
const isCard = (m) => !m.role || m.role === 'card';
const viewFor = (m) => ({ kind: isCard(m) ? 'card' : 'volume', id: m.card.fingerprint });

function cardUi(fp) {
  if (!S.ui.has(fp)) S.ui.set(fp, { scope: null, type: 'all', selected: null, project: '', root: '', group: '', day: '', dayEdited: false });
  return S.ui.get(fp);
}

// ---------- boot ----------
async function init() {
  const st = await window.harbor.getState();
  S.settings = st.settings; S.history = st.history; S.daemon = st.daemon; S.share = st.share;
  for (const m of st.cards) S.cards.set(m.card.fingerprint, m);
  window.harbor.onEvent(onEvent);
  $('btn-settings').addEventListener('click', openSettings);
  const present = [...S.cards.values()].filter((m) => m.present && m.role !== 'ignored');
  const first = present.find(isCard) || present[0];
  if (first) S.view = viewFor(first);
  if (!S.settings.shareRoot) openSettings();
  renderAll();
}

function onEvent({ type, payload }) {
  if (type === 'card') {
    const m = payload.manifest;
    const fp = m.card.fingerprint;
    S.cards.set(fp, m);
    if (S.pendingRole.get(fp) === (m.role === 'card' ? 'card' : 'ignore')) S.pendingRole.delete(fp);
    if (!S.view && m.present && m.role !== 'ignored') S.view = viewFor(m);
    // A volume the user just marked as a card moves from the drive list to the card list.
    if (S.view && S.view.id === fp && S.view.kind !== 'job') S.view = viewFor(m);
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
  const present = [...S.cards.values()].filter((m) => m.present);
  const cards = present.filter(isCard);
  if (!cards.length) cl.append(h('div', { class: 'empty' }, 'No card inserted'));
  for (const m of cards) {
    const media = m.files.filter(isMedia);
    const recent = media.filter((f) => f.recent).length;
    cl.append(h('li', { class: sel('card', m.card.fingerprint), onclick: () => { S.view = { kind: 'card', id: m.card.fingerprint }; renderAll(); } },
      h('div', { class: 't' }, m.card.label || m.card.fingerprint),
      h('div', { class: 's' }, `${recent} new · ${media.length} items`)));
  }
  const vl = $('volume-list'); vl.replaceChildren();
  // New drives first: they are waiting for a decision.
  const volumes = present.filter((m) => !isCard(m)).sort((a, b) => (a.role === 'unassigned' ? 0 : 1) - (b.role === 'unassigned' ? 0 : 1));
  if (!volumes.length) vl.append(h('div', { class: 'empty' }, 'No other USB drives'));
  for (const m of volumes) {
    const ask = m.role === 'unassigned';
    vl.append(h('li', { class: sel('volume', m.card.fingerprint) + (ask ? ' ask' : ''), onclick: () => { S.view = viewFor(m); renderAll(); } },
      h('div', { class: 't' }, m.card.label || m.card.fingerprint),
      h('div', { class: 's' }, `${ask ? 'Card or server drive?' : 'Not a card'}${m.card.total_bytes ? ' · ' + fmtBytes(m.card.total_bytes) : ''}`)));
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
  // Rebuilding empties the pane, which would jump the grid back to the top on every click.
  const same = v.dataset.viewKey === (S.view ? S.view.kind + ':' + S.view.id : '');
  const top = v.scrollTop;
  v.replaceChildren();
  v.dataset.viewKey = S.view ? S.view.kind + ':' + S.view.id : '';
  if (!S.view) { v.append(h('div', { class: 'empty' }, 'Insert a card into the NAS USB port. Harbor will notify you when it is detected.')); return; }
  if (S.view.kind === 'card' || S.view.kind === 'volume') {
    const m = S.cards.get(S.view.id);
    if (!m || !m.present) { v.append(h('div', { class: 'empty' }, 'This card is no longer inserted.')); return; }
    if (isCard(m)) renderCard(v, m); else renderVolume(v, m);
  } else renderJob(v, S.view.id);
  if (same) v.scrollTop = top;
}

// ---------- USB drive view (not yet a card, or ruled out) ----------
function renderVolume(v, m) {
  const c = m.card;
  const fp = c.fingerprint;
  const pending = S.pendingRole.get(fp);
  v.append(h('h2', {}, c.label || fp));
  const size = c.total_bytes ? `${fmtBytes(c.used_bytes || 0)} used of ${fmtBytes(c.total_bytes)}` : 'size unknown';
  v.append(h('div', { class: 'meta' }, `${size} · ${c.fstype || 'unknown format'} · ${c.mount_path || ''} · ${fp}`));
  if (m.role === 'unassigned') {
    v.append(h('div', { class: 'note warn' }, 'The NAS found this USB drive. Is it a card (or card reader) to ingest from, or a drive that is part of the server? Harbor has not read anything on it yet and will remember your choice.'));
  } else {
    v.append(h('div', { class: 'note' }, 'You marked this drive as not a card. Harbor ignores it whenever it is attached.'));
  }
  if (pending) { v.append(h('div', { class: 'note' }, 'Waiting for the NAS to apply your choice…')); return; }
  v.append(h('div', { class: 'toolbar' },
    h('button', { onclick: () => chooseRole(fp, 'card') }, 'Use as card'),
    m.role === 'unassigned' ? h('button', { class: 'ghost', onclick: () => chooseRole(fp, 'ignore') }, 'Not a card') : null));
}

async function chooseRole(fp, role) {
  S.pendingRole.set(fp, role); renderAll();
  try { await window.harbor.setVolumeRole(fp, role); } catch (e) {
    S.pendingRole.delete(fp); renderAll();
    alertDialog('Could not save your choice', String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

// ---------- card view ----------
const TYPE_LABEL = { all: 'All', video: 'Video', photo: 'Photos', audio: 'Audio' };
const TYPE_ICON = { video: '▶', photo: '▣', audio: '♪', other: '•' };
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { timeStyle: 'short' });
// Files from daemons without `kind` are all treated as media.
const isMedia = (f) => (f.kind ? f.kind === 'media' : f.media_type !== 'other');

function renderCard(v, m) {
  const fp = m.card.fingerprint;
  const ui = cardUi(fp);
  const media = m.files.filter(isMedia);
  const extras = m.files.filter((f) => !isMedia(f) && !f.sidecar_of);
  const recentCount = media.filter((f) => f.recent).length;
  // Nothing new on the card: open on everything instead of an empty screen.
  if (ui.scope === null) ui.scope = recentCount ? 'new' : 'all';
  if (ui.selected === null) ui.selected = new Set(media.filter((f) => f.recent).map((f) => f.relative_path));
  const scoped = media.filter((f) => ui.scope === 'all' || f.recent);
  const counts = { all: scoped.length };
  for (const t of ['video', 'photo', 'audio']) counts[t] = scoped.filter((f) => f.media_type === t).length;
  if (ui.type !== 'all' && !counts[ui.type]) ui.type = 'all';
  const shown = scoped.filter((f) => ui.type === 'all' || f.media_type === ui.type)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // header
  const hashing = m.checksum_state !== 'complete';
  const lastIngest = m.last_ingest_at ? 'Last ingested ' + fmtTime(m.last_ingest_at) : 'Never ingested';
  v.append(h('div', { class: 'titlebar' },
    h('div', {}, h('h2', {}, m.card.label || fp),
      h('div', { class: 'meta' }, `${m.profiles_matched.join(' + ') || 'Card'} · ${media.length} items · ${lastIngest}`)),
    m.role ? h('button', { class: 'ghost small', disabled: S.pendingRole.has(fp), onclick: () => chooseRole(fp, 'ignore') }, 'Not a card') : null));
  if (hashing) {
    const pct = Math.round((m.checksum_progress || 0) * 100);
    v.append(h('div', { class: 'note warn' }, `Preparing the card (${pct}%). You can pick files now; Ingest unlocks when this finishes.`),
      h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })));
  }
  if (!recentCount && ui.scope === 'all') v.append(h('div', { class: 'note' }, m.last_ingest_at ? 'Nothing new since the last ingest. Showing everything on the card.' : `Nothing from the last ${Math.round((m.recent_window_hours || 72) / 24)} days. Showing everything on the card.`));

  // filters
  const seg = (val, label) => h('button', { class: ui.scope === val ? 'on' : '', onclick: () => { ui.scope = val; renderAll(); } }, label);
  v.append(h('div', { class: 'toolbar' },
    h('span', { class: 'seg' }, seg('new', `New (${recentCount})`), seg('all', `Everything (${media.length})`)),
    h('span', { class: 'chips' }, ['all', 'video', 'photo', 'audio'].filter((t) => t === 'all' || counts[t]).map((t) =>
      h('button', { class: ui.type === t ? 'on' : '', onclick: () => { ui.type = t; renderAll(); } }, `${TYPE_LABEL[t]} ${counts[t]}`))),
    h('span', { class: 'spacer' }),
    h('button', { class: 'ghost small', onclick: () => { shown.forEach((f) => ui.selected.add(f.relative_path)); renderAll(); } }, 'Select all shown'),
    h('button', { class: 'ghost small', onclick: () => { shown.forEach((f) => ui.selected.delete(f.relative_path)); renderAll(); } }, 'Clear')));

  // grid, grouped by day
  const days = [];
  for (const f of shown) {
    const k = dayKey(f.timestamp);
    if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, iso: f.timestamp, files: [] });
    days[days.length - 1].files.push(f);
  }
  const grid = h('div', { class: 'days' });
  for (const d of days) {
    const allOn = d.files.every((f) => ui.selected.has(f.relative_path));
    grid.append(h('div', { class: 'dayhead' },
      h('span', { class: 't' }, fmtDay(d.iso)), h('span', { class: 'meta' }, `${d.files.length} item${d.files.length === 1 ? '' : 's'}`),
      h('button', { class: 'ghost small', onclick: () => { d.files.forEach((f) => (allOn ? ui.selected.delete(f.relative_path) : ui.selected.add(f.relative_path))); renderAll(); } }, allOn ? 'Deselect day' : 'Select day')));
    grid.append(h('div', { class: 'grid' }, d.files.map((f) => tile(fp, f, ui))));
  }
  if (!shown.length) grid.append(h('div', { class: 'empty' }, 'No files match these filters.'));
  if (extras.length) {
    grid.append(h('details', { class: 'extras' }, h('summary', {}, `Other files on the card (${extras.length})`),
      h('ul', {}, extras.map((f) => h('li', {}, h('label', {}, h('input', { type: 'checkbox', checked: ui.selected.has(f.relative_path), onchange: (e) => { e.target.checked ? ui.selected.add(f.relative_path) : ui.selected.delete(f.relative_path); renderAll(); } }), ' ', f.relative_path, h('span', { class: 'meta' }, ' · ' + fmtBytes(f.size))))))));
  }
  v.append(grid);
  v.append(ingestBar(m, ui));
  updateSummary(m);
}

// Re-renders reuse the same <img> nodes, so previews do not blink while the card view refreshes.
const thumbNodes = new Map();
function thumbImg(src) {
  let el = thumbNodes.get(src);
  if (!el) {
    el = h('img', { src, alt: '', loading: 'lazy', draggable: 'false' });
    if (thumbNodes.size > 3000) thumbNodes.clear();
    thumbNodes.set(src, el);
  }
  return el;
}

function tile(fp, f, ui) {
  const on = ui.selected.has(f.relative_path);
  const toggle = () => { on ? ui.selected.delete(f.relative_path) : ui.selected.add(f.relative_path); renderAll(); };
  const pic = f.thumb ? thumbImg(`harbor-thumb://card/${encodeURIComponent(fp)}/${encodeURIComponent(f.thumb)}`)
    : h('div', { class: 'ph ' + f.media_type }, h('span', { class: 'ico' }, TYPE_ICON[f.media_type] || '•'),
      h('span', { class: 'ext' }, (f.relative_path.split('.').pop() || '').toUpperCase()));
  return h('div', { class: 'tile' + (on ? ' on' : '') + (f.recent ? ' recent' : ''), title: f.relative_path, onclick: toggle },
    h('div', { class: 'pic' }, pic,
      h('span', { class: 'check' }, on ? '✓' : ''),
      f.recent ? h('span', { class: 'badge new' }, 'NEW') : null,
      f.duration != null ? h('span', { class: 'badge dur' }, fmtDur(f.duration)) : null,
      f.media_type === 'video' || f.media_type === 'audio'
        ? h('button', { class: 'playbtn', title: 'Play', onclick: (e) => { e.stopPropagation(); playClip(fp, f); } }, '▶') : null),
    h('div', { class: 'name' }, f.filename || f.relative_path.split('/').pop()),
    h('div', { class: 'meta' }, `${fmtClock(f.timestamp)} · ${fmtBytes(f.size)}`));
}

function playClip(fp, f) {
  window.HarborPlayer.open({ h, fingerprint: fp, file: f, onLook: async (look) => {
    S.settings = await window.harbor.saveSettings({ cardLooks: { ...(S.settings.cardLooks || {}), [fp]: look } });
  } });
}

function destinations() {
  const info = S.daemon.info || {};
  if (Array.isArray(info.destinations) && info.destinations.length) return info.destinations;
  return (info.approved_roots || []).map((r) => ({ root: r, label: r, projects: [] }));
}

function defaultGroup(m, ui) {
  const remembered = (S.settings.cardGroups || {})[m.card.fingerprint];
  if (remembered) return remembered;
  const groups = S.settings.groups || [];
  const sel = m.files.filter((f) => ui.selected.has(f.relative_path));
  const audioOnly = sel.length && sel.every((f) => f.media_type === 'audio');
  return (audioOnly ? groups.find((g) => /^(audio|sound)/i.test(g)) : groups.find((g) => !/^(audio|sound)/i.test(g))) || groups[0] || 'Camera A';
}

function defaultDay(m, ui) {
  const sel = m.files.filter((f) => ui.selected.has(f.relative_path) && isMedia(f));
  const newest = sel.reduce((a, f) => (!a || f.timestamp > a ? f.timestamp : a), null);
  return window.HarborLogic.dayFolder(newest || new Date().toISOString());
}

function ingestBar(m, ui) {
  const dests = destinations();
  if (!dests.some((d) => d.root === ui.root)) ui.root = (dests.find((d) => d.root === S.settings.lastRoot) || dests[0] || {}).root || '';
  const dest = dests.find((d) => d.root === ui.root) || { label: '', projects: [] };
  const dit = S.settings.organize !== 'simple';
  if (!ui.group) ui.group = defaultGroup(m, ui);
  if (!ui.dayEdited) ui.day = defaultDay(m, ui);
  const listId = 'projects-' + m.card.fingerprint.replace(/[^A-Za-z0-9_-]/g, '_');
  const project = h('input', { type: 'text', list: listId, placeholder: 'New or existing project folder', value: ui.project, oninput: (e) => { ui.project = e.target.value; updateSummary(m); } });
  const rootSel = h('select', { onchange: (e) => { ui.root = e.target.value; renderAll(); } }, dests.map((d) => h('option', { value: d.root, selected: d.root === ui.root }, d.label)));
  const canClear = !!(S.daemon.info && S.daemon.info.allow_clear);
  const organize = (val) => { S.settings.organize = val; window.harbor.saveSettings({ organize: val }); renderAll(); };

  const groups = S.settings.groups || [];
  const addGroup = h('input', { type: 'text', class: 'addgroup', placeholder: '+ Add group', onkeydown: (e) => {
    if (e.key !== 'Enter') return;
    const g = e.target.value.trim();
    if (!g || window.HarborLogic.checkProjectName(g)) return;
    if (!groups.includes(g)) { S.settings.groups = [...groups, g]; window.harbor.saveSettings({ groups: S.settings.groups }); }
    ui.group = g; e.target.value = ''; e.target.blur(); renderAll();
  } });
  const ditRow = h('div', { class: 'ditrow' },
    h('span', { class: 'seg' },
      h('button', { class: dit ? 'on' : '', onclick: () => organize('dit') }, 'DIT rolls'),
      h('button', { class: dit ? '' : 'on', onclick: () => organize('simple') }, 'By type')),
    dit ? h('span', { class: 'chips' }, groups.map((g) => h('button', { class: ui.group === g ? 'on' : '', onclick: () => { ui.group = g; renderAll(); } }, g))) : null,
    dit ? addGroup : null,
    dit ? h('label', { class: 'inline' }, 'Day ', h('input', { type: 'text', class: 'day', value: ui.day, oninput: (e) => { ui.day = e.target.value; ui.dayEdited = true; updateSummary(m); } })) : null,
    dit ? null : h('span', { class: 'meta' }, 'Files go into the Video / Audio / Photo subfolders set in Settings.'));

  return h('div', { class: 'ingestbar' }, ditRow,
    h('div', { class: 'row' },
      h('div', { class: 'sel' }, h('div', { id: 'sum', class: 't' }), h('div', { id: 'where', class: 'meta' })),
      h('label', { class: 'field' }, h('span', {}, 'Save to'), rootSel, h('span', { id: 'space', class: 'space' })),
      h('label', { class: 'field grow' }, h('span', {}, 'Project'), project, h('datalist', { id: listId }, dest.projects.map((p) => h('option', { value: p })))),
      canClear ? h('label', { class: 'field' }, h('span', {}, 'Afterwards'), h('label', {}, h('input', { type: 'checkbox', checked: !!ui.clear, onchange: (e) => { ui.clear = e.target.checked; } }), ' Offer to clear card')) : null,
      h('button', { id: 'btn-ingest', onclick: () => submit(m) }, 'Ingest')));
}

function updateSummary(m) {
  const ui = cardUi(m.card.fingerprint);
  const L = window.HarborLogic;
  const files = m.files.filter((f) => ui.selected.has(f.relative_path));
  const bytes = files.reduce((a, f) => a + f.size, 0);
  const dit = S.settings.organize !== 'simple';
  const err = L.checkProjectName(ui.project) || (dit && L.checkProjectName(ui.day) ? 'Enter a day folder name.' : null);
  const btn = $('btn-ingest'); if (!btn) return;
  const dest = destinations().find((d) => d.root === ui.root);
  const free = dest && Number.isFinite(dest.free_bytes) ? dest.free_bytes : null;
  const tooBig = free != null && bytes + 2 * 1024 ** 3 > free;
  btn.disabled = !files.length || !!err || tooBig || m.checksum_state !== 'complete' || !S.daemon.online || !ui.root;
  $('sum').textContent = files.length ? `${files.length} selected · ${fmtBytes(bytes)}` : 'Nothing selected';
  const space = $('space');
  if (space) {
    space.textContent = free == null ? '' : tooBig ? `Won't fit: ${fmtBytes(free)} free on ${dest.label}` : `${fmtBytes(free)} free`;
    space.className = 'space' + (tooBig ? ' bad' : free != null && free < 500 * 1024 ** 3 ? ' low' : '');
  }
  const name = ui.project.trim();
  const exists = dest && dest.projects.includes(name);
  const base = `${dest ? dest.label : ui.root} › ${name}${exists ? '' : ' (new)'}`;
  $('where').textContent = !name ? 'Pick or type a project folder' : err ? err
    : dit ? `${base} › ${ui.day.trim()} › ${ui.group} › next ${L.rollPrefix(ui.group)} roll` : base;
}

async function submit(m) {
  const ui = cardUi(m.card.fingerprint);
  const btn = $('btn-ingest'); btn.disabled = true;
  const dit = S.settings.organize !== 'simple' ? { day: ui.day.trim(), group: ui.group } : null;
  try {
    const id = await window.harbor.submit({
      fingerprint: m.card.fingerprint, selected: [...ui.selected], projectName: ui.project,
      approvedRoot: ui.root, subfolderMap: S.settings.subfolderMap, clearCard: !!ui.clear, dit,
    });
    const st = await window.harbor.getState();
    S.history = st.history; S.settings = st.settings;
    S.view = { kind: 'job', id };
    ui.selected = null; ui.dayEdited = false;
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
  const folders = {};
  for (const t of MEDIA) folders[t] = h('input', { type: 'text', value: S.settings.subfolderMap[t] });
  dlg.replaceChildren(h('h3', {}, 'Settings'),
    h('p', { class: 'meta' }, 'Choose the mapped Harbor share. Harbor talks to the NAS only through files on this share, using your existing SMB login.'),
    h('div', { class: 'form', style: 'grid-template-columns:110px 1fr' },
      h('label', {}, 'Harbor share'), h('div', {}, share, ' ', h('button', { class: 'ghost', onclick: async () => { const p = await window.harbor.pickShare(); if (p) share.value = p; } }, 'Browse')),
      h('label', {}, 'Your name'), user, h('label', {}, 'This computer'), machine),
    h('p', { class: 'meta' }, 'Inside each project folder, files are sorted into these subfolders:'),
    h('div', { class: 'form', style: 'grid-template-columns:110px 1fr' }, MEDIA.flatMap((t) => [h('label', {}, t), folders[t]])),
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { onclick: async () => { const subfolderMap = {}; for (const t of MEDIA) subfolderMap[t] = folders[t].value.trim();
        S.settings = await window.harbor.saveSettings({ shareRoot: share.value.trim(), user: user.value.trim(), machine: machine.value.trim(), subfolderMap }); dlg.close(); renderAll(); } }, 'Save')));
  dlg.showModal();
}

window.addEventListener('DOMContentLoaded', init);
