# Harbor — Powered by Omniverse

Pro-grade media ingest for Synology. Cards plugged into the NAS are detected, copied, checksum-verified and handed
into project folders locally. The desktop app only sends instructions over the existing SMB share.

* Spec: [docs/SPEC.md](docs/SPEC.md)
* File protocol between desktop and daemon: [docs/PROTOCOL.md](docs/PROTOCOL.md)
* Synology install: [docs/DEPLOY_SYNOLOGY.md](docs/DEPLOY_SYNOLOGY.md)

## Status
| Spec priority | State |
|---|---|
| 1 USB detection + server-volume baseline diff | done |
| 2 Fingerprinting + profile config | done (`default_profiles.json`, overridable via `profiles_file`) |
| 3 Manifest + last-ingest tracking | done |
| 4 Ticket schema, validation, allowlist | done |
| 5 Copy / verify / stage engine | done |
| 6 Status handshake | done |
| 7 Resume + proof-of-capture logs | done |
| 8 Desktop app (Electron) | built, see [desktop/](desktop/README.md); UI verified headless, not yet run inside Electron on Mac/Windows |
| 9 ShareSync + mesh setup | documented only |
| 10 Card-clear with confirmation gate | done |

## Desktop quick start
```
cd desktop && npm install && npm start
```

## Daemon quick start (development)
```
cd daemon
pip install -e '.[dev]'
pytest
```
Design points: checksum is xxHash64 by default (`sha256` selectable), recorded as `algo:hex`; copies hash the card
bytes while writing, then re-read the staged file cold and compare; journals make every step resumable per file;
nothing is ever overwritten (identical file = deduplicated, different file = `_1`, `_2` suffix).
