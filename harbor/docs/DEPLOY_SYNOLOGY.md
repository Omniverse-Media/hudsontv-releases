# Deploying Harbor on a Synology

> Not yet validated on real DSM hardware. The USB hot-plug propagation and volume-serial lookup (steps 3 and 5)
> are the parts to test first. Everything else is covered by the automated tests.

1. **Shared folder** `harbor` (e.g. `/volume1/harbor`) with subfolders `tickets/incoming`, `tickets/status`,
   `tickets/cards`, `tickets/processed`, `staging`, `logs`, `state` (the daemon creates them).
   Permissions: desktop users read/write `tickets/incoming` only; read-only on `status`, `cards`, `processed`, `logs`;
   no access to `staging` or `state`. Disable the recycle bin on it. **Do not add `staging` or `state` to any
   Synology Drive / ShareSync task.**
2. **Config:** copy `daemon/config/harbor.example.json` to `daemon/config/harbor.json`. `approved_roots` are the
   paths *inside the container* (`/projects` below). Put the project shares you want writable there.
3. **Container Manager:** create a project from `daemon/docker-compose.yml`. The USB mount uses
   `propagation: rslave` so cards inserted after start appear in the container. If hot-plug does not show up, restart the
   container after inserting a card, or run the daemon via Task Scheduler instead.
4. **Baseline:** with no card inserted run `docker exec harbor-daemon harbor-daemon baseline`. If a permanent USB
   disk is attached, add `--include-removable`, or list its serial in `known_server_volume_serials`.
5. **Fingerprint check:** insert a card and confirm `tickets/cards/<fingerprint>.json` appears with
   `fingerprint_source: "volume-serial"`. If it says `synthesized`, set `serial_command` in the config
   (for example `blkid -s UUID -o value {device}`) or expose the volume serial another way.
6. **Same filesystem for staging and projects** gives an atomic, no-copy handoff. Separate shared folders on btrfs
   are different subvolumes, so Harbor falls back to copying into `.<name>.harbor-partial` in the destination, re-verifying,
   then renaming into place. **Add `*.harbor-partial` to the ShareSync file filter** so partial files are never shipped.

## Card clearing (off by default)
Set `"allow_clear": true` and change the USB bind mount to `read_only: false`. Leave both off unless you want it.

## ShareSync and the private link (SPEC §8)
* Both Synologies join a private mesh (Tailscale or Cloudflare Tunnel). Point Synology Drive ShareSync at the mesh
  address of the second NAS.
* ShareSync tasks cover the **project folders only**. No port forwarding, no QuickConnect for the server link.
* Harbor only ever puts complete, checksum-verified files into a project folder, so ShareSync never sees a partial file.
