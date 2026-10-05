# Harbor

**Powered by Omniverse**

A pro-grade media ingest system for Synology. Harbor detects media cards on a NAS USB port, copies and verifies footage into project folders, and hands verified files off to a second Synology over a private link. Built to be trusted after a paid shoot.

---

## 1. System Overview

Two components:

1. **Harbor Daemon** (runs on the Synology)
   - Watches USB for newly mounted cards
   - Fingerprints the card against known device profiles
   - Builds a manifest of media on the card
   - Executes ingest jobs: copy, verify, stage, optional clear
   - Writes status back for the desktop app

2. **Harbor Desktop** (Mac and Windows)
   - Notifies the user when a new card is detected
   - Lets the user name the project folder and pick files
   - Submits an ingest job to the daemon
   - Shows live transfer status

**Core rule:** Files never round-trip through the desktop. The NAS detects, copies, and verifies locally. The desktop only sends instructions.

---

## 2. Transport and Authentication

Do **not** open a new network service or forward ports. Reuse the existing SMB mapped drives.

- Desktop and NAS already authenticate over SMB with real user credentials.
- The desktop submits work by writing a **job ticket file** into a watched share folder that is already mapped.
- The daemon watches that folder, validates the ticket, and acts on it.
- This reuses existing authentication and adds zero new attack surface.

**Watched folders on the NAS:**

```
/harbor/tickets/incoming/    desktop drops job tickets here
/harbor/tickets/status/      daemon writes status files here
/harbor/staging/             daemon copies + verifies here (NOT synced)
/harbor/logs/                per-job ingest logs
```

---

## 3. Card Detection and Fingerprinting

On a new USB mount:

1. Confirm the mount is a removable card, not a drive already present on the server. Maintain a baseline of known server volumes and diff against it.
2. Read the card's folder structure and match it to a device profile.
3. Capture the card's volume serial as its fingerprint.

**Device profiles (folder-pattern matching):**

| Profile | Signature | Media type |
|---|---|---|
| Sony video | `PRIVATE/M4ROOT/` | video |
| Sony photo | `DCIM/` | photo |
| Audio recorder | device-specific root folders | audio |

**Fail-safe requirement:** If the card structure does not match any known profile, Harbor must **not** skip it. It surfaces every file on the card and lets the user decide. Never lose a clip because a rule did not match.

New profiles must be easy to add as config, not hardcoded logic.

---

## 4. Manifest

After fingerprinting, the daemon scans the **whole** card and builds a manifest:

- Relative path, filename, size, checksum
- Timestamp (capture or modified)
- Duration where applicable
- Media type (audio / video / photo)
- Flag: newer than last ingest for this card fingerprint?

**Recent tracking:** The daemon stores the last ingest timestamp per card fingerprint. The manifest flags anything newer. Desktop opens showing only the recent set, with a "show everything on the card" toggle that reveals the full history. A time window is the fallback for cards never seen before.

---

## 5. Job Ticket

The desktop writes a ticket. The daemon treats it as a sealed work order: everything it needs, nothing it guesses.

```json
{
  "ticket_id": "uuid",
  "created_at": "ISO-8601",
  "origin": { "machine": "string", "user": "string" },
  "source": { "card_fingerprint": "volume-serial" },
  "destination": {
    "project_name": "string",
    "approved_root": "string",
    "subfolder_map": {
      "video": "relative/path",
      "audio": "relative/path",
      "photo": "relative/path"
    }
  },
  "selection": [
    { "relative_path": "string", "size": 0, "checksum": "string" }
  ],
  "operation": {
    "copy": true,
    "verify": true,
    "clear_card": false
  }
}
```

**Notes:**

- Source is referenced by card fingerprint only. The daemon resolves the real mount itself. A ticket can never point at an arbitrary server path.
- `clear_card` defaults to `false`.

**Validation (daemon rejects ticket on any failure):**

- Destination `approved_root` must be on an allowlist.
- Reject any path containing `..` or other path escape.
- Every selection entry must resolve to a real file on the resolved card.

---

## 6. Transfer Logic

Strict order. Never an OS-level move.

1. **Copy** each selected file from the card into `/harbor/staging/`.
2. **Verify** by checksum: hash the bytes read from the card against the bytes written to staging. Not a name or size check.
3. **Stage handoff:** only after a file passes verification, move it from staging into its destination subfolder inside the project.
4. **Clear card:** off by default. Only runs when `clear_card` is true AND every selected file has passed verification. Even then, treat as a separate confirmed step.

**Why staging exists:** ShareSync (Section 8) watches the destination folder. If it sees a half-copied file it will ship a corrupt copy to the remote NAS. Staging guarantees ShareSync only ever sees complete, verified files.

---

## 7. Status Handshake

The daemon writes a status file to `/harbor/tickets/status/{ticket_id}.json` and updates it through the job:

```json
{
  "ticket_id": "uuid",
  "state": "received | in_progress | done | failed",
  "files": [
    { "relative_path": "string", "state": "copied | verified | staged | failed" }
  ],
  "progress": 0.0,
  "error": "string | null",
  "updated_at": "ISO-8601"
}
```

Desktop polls this to drive a progress bar and a per-file verified state. When all files reach `verified` / `staged`, desktop shows a green "all files verified on the server" state. Card clearing is a separate button, available only after that state.

---

## 8. Cross-Server Layer (ShareSync)

Harbor handles local ingest. Synology Drive **ShareSync** handles getting verified footage to the second Synology. They chain, they do not overlap.

- **Harbor owns** the card-to-server ingest (copy + verify + stage).
- **ShareSync owns** server-to-server distribution.
- ShareSync watches the **destination project folders only**, never `/harbor/staging/`.
- Handoff boundary: a file enters a ShareSync-watched folder only after it is fully verified.

**Networking (security critical):**

- Do **not** use raw port forwarding or QuickConnect for the server link.
- Put both Synology servers on a private mesh (Tailscale or Cloudflare Tunnel).
- Point Synology Drive ShareSync at the private mesh address.
- Result: native, reliable Synology sync running inside a private tunnel. No exposed NAS.

---

## 9. Pro-Grade Guarantees

These separate a hobby script from a tool trusted with client footage. All three are required.

1. **Fail-safe fingerprinting.** Unknown card structure shows everything, never skips media.
2. **Proof of capture.** Every ingest writes a log to `/harbor/logs/` recording source card, files, checksums, and timestamps. This is the record that a job was captured.
3. **Resumable transfers.** On interruption (card bump, network hiccup), the ticket stays open, nothing is deleted, and the job resumes where it left off. Never restart from zero, never leave a half state.

---

## 10. Build Priorities

Order of implementation:

1. Daemon USB detection + server-volume baseline diff
2. Card fingerprinting + profile config system
3. Manifest builder + per-card last-ingest tracking
4. Ticket schema + validation + allowlist
5. Copy / verify / stage transfer engine with checksums
6. Status handshake file writer
7. Resumability + logging
8. Desktop app (detection notice, file picker, recent toggle, status UI)
9. ShareSync folder separation + private mesh setup
10. Optional card-clear flow with confirmation gate

---

## Engineering Notes

- Keep networking and security fundamentals clean. Flag anything insecure and favor the more secure direction.
- Destination allowlist and path-escape rejection are not optional.
- Checksum verification is the gate for every state transition. No faith-based steps.
- Profiles and approved roots live in config, not code.
