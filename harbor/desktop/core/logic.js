(function (root, factory) {
  // Works as a CommonJS module (main process, tests) and as a plain <script> in the renderer.
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HarborLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MEDIA = ['video', 'audio', 'photo', 'other'];
  const DEFAULT_SUBFOLDERS = {
    video: 'Footage/Video',
    audio: 'Footage/Audio',
    photo: 'Footage/Photo',
    other: 'Footage/Other',
  };
  
  // Mirrors the daemon's rules so the user gets an instant message instead of a rejected ticket.
  // The daemon re-validates everything; this is convenience, not security.
  function checkProjectName(name) {
    const n = (name || '').trim();
    if (!n) return 'Enter a project name.';
    if (/[\/\\\x00-\x1f]/.test(n)) return 'Project name cannot contain / or \\.';
    if (n === '.' || n === '..' || n.startsWith('.')) return 'Project name cannot start with a dot.';
    if (new TextEncoder().encode(n).length > 200) return 'Project name is too long.';
    return null;
  }
  
  function checkSubfolder(p) {
    if (!p || /[\x00-\x1f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be a relative folder path using /';
    if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'cannot contain empty, . or .. parts';
    return null;
  }
  
  function sanitizeSubfolders(map) {
    const out = {};
    for (const k of MEDIA) {
      const v = ((map && map[k]) || DEFAULT_SUBFOLDERS[k]).trim().replace(/\/+$/, '');
      const err = checkSubfolder(v);
      if (err) throw new Error(`${k} folder ${err}`);
      out[k] = v;
    }
    return out;
  }

  // The desktop's "green" state mirrors the spec: every file verified or staged.
  function allVerified(status) {
    return !!status && status.state === 'done' && status.files.length > 0 &&
      status.files.every((f) => f.state === 'verified' || f.state === 'staged');
  }

  return { MEDIA, DEFAULT_SUBFOLDERS, checkProjectName, checkSubfolder, sanitizeSubfolders, allVerified };
}));
