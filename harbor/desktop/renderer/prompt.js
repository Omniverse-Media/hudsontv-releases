'use strict';
// Docked-card prompt. Builds DOM with textContent only (card names and paths are untrusted input).
const L = window.HarborLogic;
const S = { settings: null, daemon: { online: false, info: null }, cards: new Map(), statuses: new Map(), history: [], prompt: { fingerprint: null, claim: null },
  scope: 'new', project: '', root: '', group: '', day: '', dayEdited: false, groupEdited: false, mine: null, busy: false, error: null, fp: null };

const $root = () => document.getElementById('root');
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmtBytes = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const isMedia = (f) => (f.kind ? f.kind === 'media' : f.media_type !== 'other');
const clean = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function init() {
  const st = await window.harbor.getState();
  S.settings = st.settings; S.daemon = st.daemon; S.history = st.history; S.prompt = st.prompt || S.prompt;
  for (const m of st.cards) S.cards.set(m.card.fingerprint, m);
  S.fp = S.prompt.fingerprint;
  window.harbor.onEvent(onEvent);
  render();
}

function onEvent({ type, payload }) {
  if (type === 'card') S.cards.set(payload.manifest.card.fingerprint, payload.manifest);
  else if (type === 'card-gone') S.cards.delete(payload);
  else if (type === 'daemon') S.daemon = payload;
  else if (type === 'status') {
    S.statuses.set(payload.ticket_id, payload);
    // Once our own ingest is verified, leave the result up a moment, then get out of the way.
    if (payload.ticket_id === S.mine && L.allVerified(payload)) setTimeout(() => window.harbor.dismissPrompt(), 12000);
  }
  else if (type === 'prompt') {
    if (payload.fingerprint !== S.fp) Object.assign(S, { scope: 'new', project: '', group: '', dayEdited: false, groupEdited: false, mine: null, busy: false, error: null });
    S.prompt = payload; S.fp = payload.fingerprint;
  }
  render();
}

function destinations() {
  const info = S.daemon.info || {};
  if (Array.isArray(info.destinations) && info.destinations.length) return info.destinations;
  return (info.approved_roots || []).map((r) => ({ root: r, label: r, projects: [] }));
}

function selectionOf(m) {
  const media = m.files.filter(isMedia);
  const recent = media.filter((f) => f.recent);
  const scope = S.scope === 'new' && !recent.length ? 'all' : S.scope;
  return { media, recent, files: scope === 'all' ? media : recent, scope };
}

function defaultGroup(files) {
  const remembered = (S.settings.cardGroups || {})[S.fp];
  if (remembered) return remembered;
  const groups = S.settings.groups || [];
  const audioOnly = files.length && files.every((f) => f.media_type === 'audio');
  return (audioOnly ? groups.find((g) => /^(audio|sound)/i.test(g)) : groups.find((g) => !/^(audio|sound)/i.test(g))) || groups[0] || 'Camera A';
}

function render() {
  const root = $root();
  // Don't rebuild under the user's cursor while they type; the status text updates in place below.
  if (root.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { refresh(); return; }
  root.replaceChildren(build());
  refresh();
}

function build() {
  const m = S.fp && S.cards.get(S.fp);
  if (!m || !m.present) {
    return h('div', { class: 'empty' }, S.mine || S.prompt.claim ? 'The card has been removed. Your ingest keeps going on the NAS.' : 'No card is docked.',
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => window.harbor.dismissPrompt() }, 'Close')));
  }
  const label = m.card.label || m.card.fingerprint;
  const sel = selectionOf(m);
  const claim = S.prompt.claim;
  const jobId = S.mine || (claim && claim.ticket_id);
  if (jobId) return jobView(m, label, jobId, claim && !S.mine ? claim : null);

  const dests = destinations();
  if (!dests.some((d) => d.root === S.root)) S.root = (dests.find((d) => d.root === S.settings.lastRoot) || dests[0] || {}).root || '';
  const dest = dests.find((d) => d.root === S.root) || { label: '', projects: [] };
  if (!S.groupEdited) S.group = defaultGroup(sel.files);
  if (!S.dayEdited) {
    const newest = sel.files.reduce((a, f) => (!a || f.timestamp > a ? f.timestamp : a), null);
    S.day = L.dayFolder(newest || new Date().toISOString());
  }
  const dit = S.settings.organize !== 'simple';
  const groups = S.settings.groups || [];
  const withThumb = sel.files.filter((f) => f.thumb).slice(0, 8);

  const strip = h('div', { class: 'strip' }, withThumb.map((f) => h('div', { class: 'th' },
    h('img', { src: `harbor-thumb://card/${encodeURIComponent(S.fp)}/${encodeURIComponent(f.thumb)}`, alt: '', draggable: 'false' }))),
    sel.files.length > withThumb.length ? h('div', { class: 'th more' }, `+${sel.files.length - withThumb.length}`) : null);

  const projectList = 'projects-list';
  const addGroup = h('input', { type: 'text', class: 'addgroup', placeholder: '+ Add group', onkeydown: (e) => {
    if (e.key !== 'Enter') return;
    const g = e.target.value.trim();
    if (!g || L.checkProjectName(g)) return;
    if (!groups.includes(g)) { S.settings.groups = [...groups, g]; window.harbor.saveSettings({ groups: S.settings.groups }); }
    S.group = g; S.groupEdited = true; render();
  } });

  const form = h('div', { class: 'card' },
    h('label', { class: 'f' }, 'Project', h('input', { id: 'f-project', type: 'text', list: projectList, placeholder: 'Pick an existing project or type a new name', value: S.project,
      oninput: (e) => { S.project = e.target.value; refresh(); } }), h('datalist', { id: projectList }, dest.projects.map((p) => h('option', { value: p })))),
    h('div', { class: 'row2' },
      h('label', { class: 'f' }, 'Save to', h('select', { onchange: (e) => { S.root = e.target.value; render(); } },
        dests.map((d) => h('option', { value: d.root, selected: d.root === S.root }, d.label)))),
      dit ? h('label', { class: 'f' }, 'Day', h('input', { id: 'f-day', type: 'text', value: S.day, oninput: (e) => { S.day = e.target.value; S.dayEdited = true; refresh(); } })) : h('div')),
    h('div', { id: 'space', class: 'hintline' }),
    dit ? h('div', { class: 'f' }, h('div', { class: 'chips' }, groups.map((g) => h('button', { class: S.group === g ? 'on' : '', onclick: () => { S.group = g; S.groupEdited = true; render(); } }, g)), addGroup)) : null,
    h('div', { id: 'where', class: 'preview' }));

  return h('div', { style: 'display:contents' },
    h('div', { class: 'dock' }, h('div', { class: 'icon' }, '⬇'),
      h('div', {}, h('h1', {}, `${label} docked`),
        h('div', { class: 'meta' }, `${(m.profiles_matched || []).join(' + ') || 'Card'} · ${sel.media.length} items on the card${m.last_ingest_at ? '' : ' · never ingested'}`))),
    strip,
    h('div', { class: 'seg' },
      h('button', { class: sel.scope === 'new' ? 'on' : '', onclick: () => { S.scope = 'new'; render(); } }, `New (${sel.recent.length})`),
      h('button', { class: sel.scope === 'all' ? 'on' : '', onclick: () => { S.scope = 'all'; render(); } }, `Everything (${sel.media.length})`)),
    m.checksum_state !== 'complete' ? h('div', { class: 'note warn' }, `Preparing the card (${Math.round((m.checksum_progress || 0) * 100)}%). Ingest unlocks when this finishes.`,
      h('div', { class: 'bar', style: 'margin-top:8px' }, h('div', { style: `width:${Math.round((m.checksum_progress || 0) * 100)}%` }))) : null,
    S.error ? h('div', { class: 'note bad' }, S.error) : null,
    form,
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => window.harbor.dismissPrompt() }, 'Not now'),
      h('button', { class: 'ghost', onclick: () => window.harbor.openMain(S.fp) }, 'Review files…'),
      h('button', { id: 'go', class: 'big', onclick: submit }, 'Ingest')));
}

// Live bits (button label, validation, path preview) that change while typing without rebuilding the form.
function refresh() {
  const go = document.getElementById('go'); if (!go) return;
  const m = S.cards.get(S.fp); if (!m) return;
  const sel = selectionOf(m);
  const files = sel.files;
  const bytes = files.reduce((a, f) => a + f.size, 0);
  const dit = S.settings.organize !== 'simple';
  const name = S.project.trim();
  const dests = destinations();
  const dest = dests.find((d) => d.root === S.root);
  const exists = !!(dest && dest.projects.includes(name));
  const free = dest && Number.isFinite(dest.free_bytes) ? dest.free_bytes : null;
  const tooBig = free != null && bytes + 2 * 1024 ** 3 > free;
  const err = L.checkProjectName(S.project) || (dit && L.checkProjectName(S.day) ? 'Enter a day folder name.' : null);
  go.disabled = S.busy || !files.length || !!err || tooBig || m.checksum_state !== 'complete' || !S.daemon.online || !S.root;
  go.textContent = !files.length ? 'Nothing to ingest' : `Ingest ${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}`;
  const where = document.getElementById('where');
  if (where) where.textContent = !name ? 'Choose where these files go, then Ingest.' : err ? err
    : `${dest ? dest.label : S.root} › ${name}${exists ? '' : ' (new folder)'}${dit ? ` › ${S.day.trim()} › ${S.group} › next ${L.rollPrefix(S.group)} roll` : ''}`;
  const space = document.getElementById('space');
  if (space) {
    space.textContent = !S.daemon.online ? 'The NAS isn’t responding right now.' : free == null ? '' : tooBig ? `Won’t fit: only ${fmtBytes(free)} free on ${dest.label}` : `${fmtBytes(free)} free on ${dest.label}`;
    space.className = 'hintline' + (!S.daemon.online || tooBig ? ' bad' : free != null && free < 500 * 1024 ** 3 ? ' low' : '');
  }
}

async function submit() {
  const m = S.cards.get(S.fp); if (!m) return;
  S.busy = true; S.error = null; refresh();
  try {
    const sel = selectionOf(m);
    const dit = S.settings.organize !== 'simple' ? { day: S.day.trim(), group: S.group } : null;
    S.mine = await window.harbor.submit({
      fingerprint: S.fp, selected: sel.files.map((f) => f.relative_path), projectName: S.project, approvedRoot: S.root,
      subfolderMap: S.settings.subfolderMap, clearCard: false, dit,
    });
    S.project = S.project.trim();
  } catch (e) { S.error = clean(e); }
  S.busy = false;
  render();
}

function jobView(m, label, id, claim) {
  const st = S.statuses.get(id);
  const hist = S.history.find((j) => j.ticket_id === id);
  const project = claim ? claim.project : S.project;
  const files = claim ? claim.files : (hist ? hist.files : selectionOf(m).files.length);
  const verified = L.allVerified(st);
  const failed = st && st.state === 'failed';
  const pct = st ? Math.round(st.progress * 100) : 0;
  const who = claim ? `${claim.by}${claim.machine && claim.machine !== claim.by ? ` (${claim.machine})` : ''}` : null;
  const title = verified ? 'Ingest verified' : failed ? 'Ingest failed' : who ? `${who} is ingesting this card` : `Ingesting ${label}`;
  return h('div', { style: 'display:contents' },
    h('div', { class: 'dock' + (verified ? ' ok' : '') }, h('div', { class: 'icon' }, verified ? '✓' : failed ? '!' : '⇅'),
      h('div', {}, h('h1', {}, title), h('div', { class: 'meta' }, `${files} file${files === 1 ? '' : 's'} → ${project}${claim ? '' : ''}`))),
    verified ? h('div', { class: 'note ok' }, '✓ Every file copied and verified on the server. You can pull the card.') : null,
    failed ? h('div', { class: 'note bad' }, st.error || 'The job failed. Open Harbor for details.') : null,
    st && st.message && !verified && !failed ? h('div', { class: 'note warn' }, st.message) : null,
    !st ? h('div', { class: 'note' }, 'Waiting for the NAS to pick this up…') : null,
    h('div', { class: 'bar' + (verified ? ' ok' : '') }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'meta' }, st ? `${st.state.replace('_', ' ')} · ${pct}%` : 'queued'),
    claim && !verified && !failed ? h('div', { class: 'note' }, 'Nothing else to do here. If this is wrong, open Harbor to ingest the card yourself.') : null,
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => window.harbor.dismissPrompt() }, 'Close'),
      h('button', { class: verified ? 'big' : 'ghost', onclick: () => window.harbor.openMain(S.fp) }, 'Open Harbor')));
}

window.addEventListener('DOMContentLoaded', init);
