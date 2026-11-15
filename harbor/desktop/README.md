# Harbor Desktop (Electron, Mac + Windows)

Talks to the daemon only through files on the already-mapped SMB share. No network service, no new credentials.

```
npm install
npm start          # run
npm test           # core logic tests (node:test, no Electron needed)
npm run dist       # installers via electron-builder (build on each target OS)
```

First launch: Settings, then pick the mapped `harbor` share (e.g. `/Volumes/harbor` or `Z:\`).

* `main.js` tray, notifications, IPC. Builds tickets from the manifest on the share, never from renderer-supplied file data.
* `core/share.js` reads cards/status, writes tickets atomically (dot-temp then rename).
* `core/poller.js` polls every 2 s (file watchers are unreliable over SMB).
* `renderer/` sandboxed UI. DOM built with `textContent` only; strict CSP; no Node access.
* The clear token is read by the main process from the daemon's status file; the UI never handles it.

Not yet done: signed/notarized installers, auto-update, browsing existing project folders on the NAS (the destination
list comes from the daemon's `approved_roots`).

## Card-docked prompt
When a card is docked on the NAS, every running Harbor desktop opens a small always-on-top window (turn it off in
Settings > New card, where you can also pick a system notification banner, a badge only, or nothing, plus sound). It shows the card, a thumbnail strip, New / Everything, and the same Project / Save to / Day /
Group choices as the main window, with one Ingest button. The NAS copies from the card where it is mounted; the desktop
only writes a ticket. "Review files…" opens the full thumbnail view for picking individual clips.

If another desktop queues a ticket for the same card, the other desktops' prompts switch to "<name> is ingesting this
card" and follow its progress, so two people don't ingest the same card twice. Desktops learn this by reading ticket
files in `tickets/incoming/` and `tickets/processed/` (see `share.readTickets`); no daemon change is needed.

### Saving to this computer
The prompt's "Save to" can be the NAS, a folder on this computer, or both. A local copy reads the card over SMB (the
card's own share, e.g. `usbshare6`, must be mounted; the prompt has a Connect card button) and writes with the same
rules as the daemon: the same Project / Day / Group / roll layout, nothing is ever overwritten (a different file with the
same name is kept as `name (2).ext`), and every file is hashed with xxh64 while it is read (checked against the NAS's
checksum) and again after it is written. Finished files are skipped on a re-run, so a pulled card or a sleeping laptop
just pauses the job and Resume continues. Files that reach this computer are reported to the NAS (`<fingerprint>.local.json`), so the card
stops offering them as New for everyone.

### Drives, themes, destinations and previews
* The sidebar lists only drives marked as cards. Every other USB drive on the NAS is under Settings > USB drives, where
  any drive can be switched to a card or back; a brand new drive shows a one-line question at the top until answered.
* Settings > Appearance: Dark (default), Light, or Auto (follows the computer).
* In the prompt, **Folder** takes a recent project, a typed name, or a nested path like `Client A/Shoot 5` (up to 4 deep).
  **Browse NAS…** opens a Finder-style chooser inside the share as mounted on this computer, and can create folders.
  The NAS still only writes inside the approved roots it publishes.
* The thumbnail grid plays video and audio and opens photos straight from the card's share (▶ or ⤢, or double-click).
  Camera RAW photos show the preview stored in the file.
