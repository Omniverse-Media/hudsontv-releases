'use strict';
const crypto = require('node:crypto');
const { MEDIA, DEFAULT_SUBFOLDERS, checkProjectName, checkSubfolder, sanitizeSubfolders, allVerified } = require('./logic');

function buildTicket({ manifest, selected, projectName, approvedRoot, subfolderMap, clearCard, origin, now = new Date() }) {
  const err = checkProjectName(projectName);
  if (err) throw new Error(err);
  if (!approvedRoot) throw new Error('Choose a destination root.');
  if (manifest.checksum_state !== 'complete') throw new Error('The card is still being scanned. Wait for checksums to finish.');
  const byPath = new Map(manifest.files.map((f) => [f.relative_path, f]));
  const selection = [];
  for (const rel of selected) {
    const f = byPath.get(rel);
    if (!f) throw new Error('Selected file is no longer in the manifest: ' + rel);
    if (!f.checksum) throw new Error('No checksum for ' + rel + (f.error ? ' (' + f.error + ')' : ''));
    selection.push({ relative_path: f.relative_path, size: f.size, checksum: f.checksum });
  }
  if (!selection.length) throw new Error('Select at least one file.');
  return {
    ticket_id: crypto.randomUUID(),
    created_at: now.toISOString(),
    origin,
    source: { card_fingerprint: manifest.card.fingerprint },
    destination: {
      project_name: projectName.trim(),
      approved_root: approvedRoot,
      subfolder_map: sanitizeSubfolders(subfolderMap),
    },
    selection,
    operation: { copy: true, verify: true, clear_card: !!clearCard },
  };
}

module.exports = { MEDIA, DEFAULT_SUBFOLDERS, checkProjectName, checkSubfolder, sanitizeSubfolders, buildTicket, allVerified };
