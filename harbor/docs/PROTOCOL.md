# Harbor protocol (files on the SMB share)

Everything below lives under the `harbor_root` share (default `/harbor`).

| Folder | Writer | Reader | Purpose |
|---|---|---|---|
| `tickets/incoming/` | desktop | daemon | job tickets and clear confirmations |
| `tickets/status/` | daemon | desktop | per-ticket status |
| `tickets/cards/` | daemon | desktop | one manifest per detected card, plus `_daemon.json` |
| `tickets/processed/` | daemon | anyone | finished or rejected tickets |
| `staging/` | daemon | nobody | copy + verify area. **Never synced.** |
| `logs/` | daemon | desktop | proof of capture |
| `state/` | daemon | nobody | journals, baseline, per-card history. Not shared. |

Share permissions: desktop users get **write on `incoming/` only** and read on `status/`, `cards/`,
`processed/`, `logs/`. No access to `staging/` or `state/`.

## Writing a ticket
Write `<ticket_id>.json` **atomically**: write `.<ticket_id>.tmp` then rename. The daemon ignores dot-files and
tolerates a half-written file for 10 s. The file name must equal `ticket_id` (a lowercase UUID).
Schema: see SPEC §5. Extra rules the daemon enforces:

* `approved_root` must equal an entry in the server's `approved_roots` (published in `cards/_daemon.json`).
* `project_name` is one folder name. Each `subfolder_map` value is a relative path. No `..`, no absolute paths.
* `subfolder_map` keys: `video`, `audio`, `photo`, `other`. Every selected file needs a mapping for its media type.
  The daemon decides each file's media type itself.
* `operation.copy` and `operation.verify` must be `true`. `clear_card` needs `allow_clear` on the server.
* `selection[].checksum` should be the manifest checksum (`xxh64:<hex>`). If it is `null` the daemon trusts the
  copy-time checksum (still verified card-vs-staging). If present and different from what the card now yields,
  that file fails.

## Card manifests: `cards/<fingerprint>.json`
Published as soon as the file listing is done (`checksum_state: "pending"`, with `checksum_progress`), republished
when checksums complete (`"complete"`). Wait for `complete` before building a ticket if you want checksums.
`present` flips to `false` when the card is removed. Each file has `recent` (see below). A card matching no profile has
`profile_matched: false`; every file is still listed.

**Recent:** a file is recent when its timestamp is newer than the newest *file* timestamp from the last successful
ingest of this card (immune to camera/NAS clock differences). For a never-ingested card, files within
`recent_window_hours` count. `last_ingest_at` (NAS clock) is also published.

## Status: `status/<ticket_id>.json`
`state`: `received | in_progress | done | failed`. Per file: `pending | copying | copied | verified | staged | failed`
(the spec's four plus `pending` and `copying`). `message` carries "waiting for card …" / "paused: …" (the job resumes
by itself). `done` means every file is verified **and** in the project folder.

## Clearing the card (optional, separate step)
1. Submit the ticket with `clear_card: true` (server must have `allow_clear: true`, card mounted read-write).
2. When `state` is `done`, `status.clear = {"state": "awaiting_confirmation", "token": "…"}`.
3. After the user confirms in the UI, write `<ticket_id>.clear.json`:
   `{"type":"clear_confirm","ticket_id":"…","token":"…","created_at":"…","origin":{…}}`.
4. The daemon re-hashes every selected file on the card and in the project folder. Only if **all** match does it
   delete **those files** (never folders, never anything unselected). Result in `status.clear`
   (`cleared`, or `last_error` with nothing deleted). The token is an anti-accident check, not a secret; the real
   gate is who can write to `incoming/`.
