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
