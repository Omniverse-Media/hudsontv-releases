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
3. **Container Manager:** create a project from `daemon/docker-compose.yml`. The host filesystem is mounted
   read-only at `/host` with `propagation: rslave`, so a card in any USB slot (`/volumeUSB<n>`, where DSM changes n on
   replug) appears in the container. **DSM 7.1** has no Container Manager, only the Docker package without compose
   projects: create a Task Scheduler task (boot-up, user root) that runs
   `cd /volume1/harbor/daemon && docker-compose up -d --build`.
4. **Permanent USB drives:** with `card_selection: "ask"` (the example config) every USB volume shows up in the
   desktop app under **USB drives** without being read. Mark each permanent drive **Not a card** once, and pick
   **Use as card** for a card reader. Choices are remembered per volume. With `"auto"`, run
   `docker exec harbor-daemon harbor-daemon baseline --include-removable` or list serials in
   `known_server_volume_serials` instead.
5. **Fingerprint check:** insert a card and confirm `tickets/cards/<fingerprint>.json` appears with
   `fingerprint_source: "volume-serial"`. If it says `synthesized`, set `serial_command` in the config
   (for example `blkid -s UUID -o value {device}`) or expose the volume serial another way.
6. **Same filesystem for staging and projects** gives an atomic, no-copy handoff. Separate shared folders on btrfs
   are different subvolumes, so Harbor falls back to copying into `.<name>.harbor-partial` in the destination, re-verifying,
   then renaming into place. **Add `*.harbor-partial` to the ShareSync file filter** so partial files are never shipped.

## Card clearing (off by default)
Set `"allow_clear": true` and change the `/host` bind mount to `read_only: false` (this makes every share writable
inside the container). Leave both off unless you want it.

## ShareSync and the private link (SPEC §8)
* Both Synologies join a private mesh (Tailscale or Cloudflare Tunnel). Point Synology Drive ShareSync at the mesh
  address of the second NAS.
* ShareSync tasks cover the **project folders only**. No port forwarding, no QuickConnect for the server link.
* Harbor only ever puts complete, checksum-verified files into a project folder, so ShareSync never sees a partial file.
