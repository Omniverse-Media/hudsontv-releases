'use strict';
// Docked-card prompt. Builds DOM with textContent only (card names and paths are untrusted input).
const L = window.HarborLogic;
const S = { settings: null, daemon: { online: false, info: null }, cards: new Map(), statuses: new Map(), history: [], prompt: { fingerprint: null, claim: null },
  scope: 'new', project: '', root: '', group: '', day: '', dayEdited: false, groupEdited: false, mine: null, busy: false, error: null, fp: null,
  mode: 'nas', localRoot: '', local: null, localJobs: new Map(), mineLocal: null };

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
  S.mode = S.settings.destMode || 'nas'; S.localRoot = S.settings.localRoot || '';
  for (const j of st.localJobs || []) S.localJobs.set(j.id, j);
  window.harbor.onEvent(onEvent);
  setInterval(() => { if (!S.mine && !S.mineLocal && S.mode !== 'nas') loadLocal(); }, 3000);
  loadLocal();
  render();
}

function onEvent({ type, payload }) {
  if (type === 'card') S.cards.set(payload.manifest.card.fingerprint, payload.manifest);
  else if (type === 'card-gone') S.cards.delete(payload);
  else if (type === 'daemon') S.daemon = payload;
  else if (type === 'status') {
    S.statuses.set(payload.ticket_id, payload);
    // Once our own ingest is verified, leave the result up a moment, then get out of the way.
    if (payload.ticket_id === S.mine && L.allVerified(payload) && !S.mineLocal) setTimeout(() => window.harbor.dismissPrompt(), 12000);
  }
  else if (type === 'local') {
    S.localJobs.set(payload.id, payload);
    const nasOk = !S.mine || L.allVerified(S.statuses.get(S.mine));
    if (payload.id === S.mineLocal && payload.state && payload.state.state === 'done' && nasOk) setTimeout(() => window.harbor.dismissPrompt(), 12000);
  }
  else if (type === 'prompt') {
    if (payload.fingerprint !== S.fp) Object.assign(S, { scope: 'new', project: '', group: '', dayEdited: false, groupEdited: false, mine: null, mineLocal: null, busy: false, error: null });
    S.prompt = payload; S.fp = payload.fingerprint;
  }
  render();
}

// Free space, permissions and whether the card is visible on this computer; refreshed while the prompt is open.
async function loadLocal() {
  if (S.mode === 'nas' || !S.fp) { S.local = null; return; }
  try {
    const info = await window.harbor.localInfo(S.fp, S.localRoot || '');
    const was = S.local && S.local.cardMounted;
    S.local = info;
    if (was !== info.cardMounted || !S.local.projects) render(); else refresh();
  } catch (e) { /* the card may have just gone */ }
}
const usesNas = () => S.mode !== 'local';
const usesLocal = () => S.mode !== 'nas';

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
  const jobId = S.mine || S.mineLocal || (claim && claim.ticket_id);
  if (jobId) return jobView(m, label, S.mine || (claim && !S.mineLocal ? claim.ticket_id : null), claim && !S.mine && !S.mineLocal ? claim : null);

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
      oninput: (e) => { S.project = e.target.value; refresh(); } }), h('datalist', { id: projectList }, [...new Set([...(usesNas() ? dest.projects : []), ...(usesLocal() && S.local ? S.local.projects || [] : [])])].map((p) => h('option', { value: p })))),
    h('div', { class: 'f' }, 'Save to', h('div', { class: 'seg wide' },
      [['nas', 'NAS server'], ['local', 'This computer'], ['both', 'Both']].map(([v, t]) => h('button', { class: S.mode === v ? 'on' : '', onclick: () => { S.mode = v; S.error = null; loadLocal(); render(); } }, t)))),
    h('div', { class: 'row2' },
      usesNas() ? h('label', { class: 'f' }, usesLocal() ? 'NAS location' : 'Location', h('select', { onchange: (e) => { S.root = e.target.value; render(); } },
        dests.map((d) => h('option', { value: d.root, selected: d.root === S.root }, d.label)))) : h('div'),
      dit ? h('label', { class: 'f' }, 'Day', h('input', { id: 'f-day', type: 'text', value: S.day, oninput: (e) => { S.day = e.target.value; S.dayEdited = true; refresh(); } })) : h('div')),
    usesNas() ? h('div', { id: 'space', class: 'hintline' }) : null,
    usesLocal() ? h('div', { class: 'localrow' },
      h('div', { class: 'f' }, 'Folder on this computer', h('div', { class: 'pick' },
        h('div', { class: 'path' + (S.localRoot ? '' : ' none') }, S.localRoot || 'No folder chosen'),
        h('button', { class: 'ghost small', onclick: async () => { const d = await window.harbor.pickLocalDest(); if (d) { S.localRoot = d; await loadLocal(); render(); } } }, S.localRoot ? 'Change…' : 'Choose…'))),
      h('div', { id: 'lspace', class: 'hintline' }),
      S.local && !S.local.cardMounted ? h('div', { class: 'note warn' }, 'This computer needs the card connected to copy from it. ',
        h('button', { class: 'small', onclick: async () => { await window.harbor.connectCard(S.fp); setTimeout(loadLocal, 2500); } }, 'Connect card')) : null,
      S.mode === 'both' ? h('div', { class: 'hintline' }, 'Both reads the card twice (the NAS and this computer), so it takes longer.') : null) : null,
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
  const tooBig = usesNas() && free != null && bytes + 2 * 1024 ** 3 > free;
  const loc = S.local;
  const lfree = loc && Number.isFinite(loc.free) ? loc.free : null;
  const lBig = usesLocal() && lfree != null && bytes + 1024 ** 3 > lfree;
  const lBad = usesLocal() && (!S.localRoot ? 'Choose a folder on this computer.' : loc && !loc.writable ? 'This computer can’t write there. Pick another folder.' : loc && !loc.cardMounted ? 'Connect the card to this computer first.' : null);
  const err = L.checkProjectName(S.project) || (dit && L.checkProjectName(S.day) ? 'Enter a day folder name.' : null);
  go.disabled = S.busy || !files.length || !!err || tooBig || lBig || !!lBad || m.checksum_state !== 'complete' || (usesNas() && (!S.daemon.online || !S.root));
  go.textContent = !files.length ? 'Nothing to ingest' : `Ingest ${files.length} file${files.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}`;
  const tail = dit ? ` › ${S.day.trim()} › ${S.group} › next ${L.rollPrefix(S.group)} roll` : '';
  const where = document.getElementById('where');
  if (where) where.textContent = !name ? 'Choose where these files go, then Ingest.' : err ? err : lBad ? lBad
    : [usesNas() ? `NAS: ${dest ? dest.label : S.root} › ${name}${exists ? '' : ' (new folder)'}${tail}` : null,
      usesLocal() ? `This computer: ${S.localRoot} › ${name}${loc && loc.projects && loc.projects.includes(name) ? '' : ' (new folder)'}${tail}` : null].filter(Boolean).join('\n');
  const space = document.getElementById('space');
  if (space) {
    space.textContent = !S.daemon.online ? 'The NAS isn’t responding right now.' : free == null ? '' : tooBig ? `Won’t fit on the NAS: only ${fmtBytes(free)} free on ${dest.label}` : `${fmtBytes(free)} free on ${dest.label}`;
    space.className = 'hintline' + (!S.daemon.online || tooBig ? ' bad' : free != null && free < 500 * 1024 ** 3 ? ' low' : '');
  }
  const ls = document.getElementById('lspace');
  if (ls) {
    ls.textContent = lBad && S.localRoot ? lBad : lfree == null ? '' : lBig ? `Won’t fit on this computer: ${fmtBytes(lfree)} free` : `${fmtBytes(lfree)} free on this computer`;
    ls.className = 'hintline' + ((lBad && S.localRoot) || lBig ? ' bad' : lfree != null && lfree < 100 * 1024 ** 3 ? ' low' : '');
  }
}

async function submit() {
  const m = S.cards.get(S.fp); if (!m) return;
  S.busy = true; S.error = null; refresh();
  try {
    const sel = selectionOf(m);
    const dit = S.settings.organize !== 'simple' ? { day: S.day.trim(), group: S.group } : null;
    const r = await window.harbor.ingest({
      fingerprint: S.fp, selected: sel.files.map((f) => f.relative_path), projectName: S.project, approvedRoot: S.root,
      subfolderMap: S.settings.subfolderMap, clearCard: false, dit, mode: S.mode, localRoot: S.localRoot,
    });
    S.mine = r.ticketId; S.mineLocal = r.localId;
    S.settings.destMode = S.mode; S.settings.localRoot = S.localRoot;
    S.project = S.project.trim();
  } catch (e) { S.error = clean(e); }
  S.busy = false;
  render();
}

// One section per copy: the NAS job (or another desktop's) and/or the copy to this computer.
function nasSection(m, id, claim) {
  const st = S.statuses.get(id);
  const verified = L.allVerified(st);
  const failed = !!st && st.state === 'failed';
  const pct = st ? Math.round(st.progress * 100) : 0;
  const who = claim ? `${claim.by}${claim.machine && claim.machine !== claim.by ? ` (${claim.machine})` : ''}` : null;
  return { verified, failed, node: h('div', { class: 'job' },
    h('div', { class: 'jobhead' }, h('span', { class: 't' }, who ? `${who} is ingesting to the NAS` : 'NAS server'), h('span', { class: 'meta' }, verified ? 'verified' : failed ? 'failed' : st ? `${st.state.replace('_', ' ')} · ${pct}%` : 'queued')),
    failed ? h('div', { class: 'note bad' }, st.error || 'The job failed. Open Harbor for details.') : null,
    st && st.message && !verified && !failed ? h('div', { class: 'note warn' }, st.message) : null,
    !st ? h('div', { class: 'note' }, 'Waiting for the NAS to pick this up…') : null,
    h('div', { class: 'bar' + (verified ? ' ok' : '') }, h('div', { style: `width:${pct}%` }))) };
}

function localSection(id) {
  const j = S.localJobs.get(id);
  const st = j && j.state;
  const done = !!st && st.state === 'done';
  const failed = !!st && st.state === 'failed';
  const paused = !!st && st.state === 'paused';
  const pct = st ? Math.round((st.progress || 0) * 100) : 0;
  const files = st ? st.files || [] : [];
  const skipped = files.filter((f) => f.state === 'skipped').length;
  const bad = files.filter((f) => f.state === 'failed');
  return { verified: done, failed, paused, node: h('div', { class: 'job' },
    h('div', { class: 'jobhead' }, h('span', { class: 't' }, 'This computer'), h('span', { class: 'meta' }, done ? 'verified' : failed ? 'needs attention' : paused ? 'paused' : st ? `copying · ${pct}%` : 'starting')),
    done ? h('div', { class: 'meta' }, `${files.length - skipped} copied and read back${skipped ? `, ${skipped} already there` : ''}${st.roll ? ` · roll ${st.roll}` : ''}`) : null,
    st && st.message ? h('div', { class: 'note ' + (paused ? 'warn' : 'bad') }, st.message) : null,
    bad.length ? h('div', { class: 'note bad' }, bad.slice(0, 3).map((f) => `${f.relative_path.split('/').pop()}: ${f.error}`).join(' · ') + (bad.length > 3 ? ` · +${bad.length - 3} more` : '')) : null,
    h('div', { class: 'bar' + (done ? ' ok' : '') }, h('div', { style: `width:${pct}%` })),
    h('div', { class: 'jobactions' },
      paused || failed ? h('button', { class: 'small', onclick: async () => { await window.harbor.connectCard(S.fp); setTimeout(() => window.harbor.resumeLocal(id), 2500); } }, paused ? 'Reconnect & resume' : 'Retry failed files') : null,
      st && st.dir ? h('button', { class: 'ghost small', onclick: () => window.harbor.revealLocal(id) }, 'Show in folder') : null)) };
}

function jobView(m, label, nasId, claim) {
  const secs = [];
  if (nasId) secs.push(nasSection(m, nasId, claim));
  if (S.mineLocal) secs.push(localSection(S.mineLocal));
  const all = secs.every((x) => x.verified);
  const anyBad = secs.some((x) => x.failed);
  const files = claim ? claim.files : selectionOf(m).files.length;
  const project = claim ? claim.project : S.project;
  const title = all ? 'Ingest verified' : anyBad ? 'Needs attention' : claim && !S.mineLocal ? `${claim.by} is ingesting this card` : `Ingesting ${label}`;
  return h('div', { style: 'display:contents' },
    h('div', { class: 'dock' + (all ? ' ok' : '') }, h('div', { class: 'icon' }, all ? '✓' : anyBad ? '!' : '⇅'),
      h('div', {}, h('h1', {}, title), h('div', { class: 'meta' }, `${files} file${files === 1 ? '' : 's'} → ${project}`))),
    all ? h('div', { class: 'note ok' }, secs.length > 1 ? '✓ Verified on the NAS and on this computer. You can pull the card.' : '✓ Every file copied and verified. You can pull the card.') : null,
    secs.map((x) => x.node),
    claim && !S.mineLocal && !all && !anyBad ? h('div', { class: 'note' }, 'Nothing else to do here. If this is wrong, open Harbor to ingest the card yourself.') : null,
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => window.harbor.dismissPrompt() }, 'Close'),
      h('button', { class: all ? 'big' : 'ghost', onclick: () => window.harbor.openMain(S.fp) }, 'Open Harbor')));
}

window.addEventListener('DOMContentLoaded', init);
