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
Settings > Card prompt). It shows the card, a thumbnail strip, New / Everything, and the same Project / Save to / Day /
Group choices as the main window, with one Ingest button. The NAS copies from the card where it is mounted; the desktop
only writes a ticket. "Review files…" opens the full thumbnail view for picking individual clips.

If another desktop queues a ticket for the same card, the other desktops' prompts switch to "<name> is ingesting this
card" and follow its progress, so two people don't ingest the same card twice. Desktops learn this by reading ticket
files in `tickets/incoming/` and `tickets/processed/` (see `share.readTickets`); no daemon change is needed.
