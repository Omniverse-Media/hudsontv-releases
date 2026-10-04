"""Optional card clear: a separate, confirmed step after a job is done.

Gates (all must hold):
  * server has allow_clear enabled and the ticket was submitted with clear_card=true
  * the job finished with every selected file staged
  * a confirm file carries the one-time token the daemon put in the status file
  * the same card (by fingerprint) is still mounted read-write
  * every selected file is re-hashed on the card AND in its destination and matches
    the verified checksum. If any check fails nothing is deleted.
Only the selected files are unlinked. Directories and unselected files are never touched.
"""
import hmac
import os
import re
import secrets

from . import hashing
from .joblog import JobLog
from .pathsafe import PathError, resolve_within
from .state import now_iso

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class ClearError(Exception):
    pass


def new_clear_state():
    return {"state": "awaiting_confirmation", "token": secrets.token_hex(8)}


def parse_confirm(raw, filename_id):
    if not isinstance(raw, dict) or raw.get("type") != "clear_confirm":
        raise ClearError("not a clear_confirm request")
    tid, token = raw.get("ticket_id"), raw.get("token")
    if not isinstance(tid, str) or not _UUID.match(tid.lower()) or tid.lower() != filename_id:
        raise ClearError("ticket_id missing or does not match file name")
    if not isinstance(token, str) or not token:
        raise ClearError("token missing")
    return tid.lower(), token


def run_clear(cfg, jobs, status, ticket_id, token, mount_path):
    log = JobLog(cfg.logs_dir, ticket_id)
    j = jobs.load(ticket_id)
    if not cfg.allow_clear:
        raise ClearError("card clearing is disabled on this server")
    if j is None or j.get("state") != "done":
        raise ClearError("job is not complete")
    clear = j.get("clear") or {}
    if not j.get("clear_card") or clear.get("state") != "awaiting_confirmation":
        raise ClearError("this ticket is not armed for clearing")
    if not hmac.compare_digest(clear.get("token", ""), token):
        raise ClearError("confirmation token does not match")
    if mount_path is None:
        raise ClearError("card is not present")
    if not os.access(mount_path, os.W_OK):
        raise ClearError("card is mounted read-only")

    algo = cfg.checksum_algorithm
    plan = []
    for rel, f in j["files"].items():
        if f["state"] != "staged" or not f.get("src_checksum"):
            raise ClearError("file not verified and staged: %s" % rel)
        try:
            card_path = resolve_within(mount_path, rel)
        except PathError:
            raise ClearError("card path escapes mount: %s" % rel)
        if card_path != os.path.join(os.path.realpath(mount_path), *rel.split("/")):
            raise ClearError("card path passes through a symlink: %s" % rel)
        if not os.path.isfile(card_path) or os.path.getsize(card_path) != f["size"]:
            raise ClearError("card file missing or changed: %s" % rel)
        if hashing.hash_file(card_path, algo) != f["src_checksum"]:
            raise ClearError("card file changed since verification: %s" % rel)
        dest = f.get("dest_path")
        if not dest or not os.path.isfile(dest) or os.path.getsize(dest) != f["size"]:
            raise ClearError("destination copy missing: %s" % rel)
        if cfg.clear_rehash_destination and hashing.hash_file(dest, algo, cold=True) != f["src_checksum"]:
            raise ClearError("destination copy does not match checksum: %s" % rel)
        plan.append(card_path)

    j["clear"] = {"state": "clearing"}
    jobs.save(j)
    status.set_clear(ticket_id, {"state": "clearing"})
    log.event("clear_start", files=len(plan))
    deleted = 0
    for p in plan:
        os.unlink(p)
        deleted += 1
    j["clear"] = {"state": "cleared", "deleted": deleted, "at": now_iso()}
    jobs.save(j)
    status.set_clear(ticket_id, j["clear"])
    log.event("card_cleared", deleted=deleted)
    return deleted


def record_failure(jobs, status, ticket_id, reason):
    """Surface a refused/failed clear without disarming a legitimate retry."""
    j = jobs.load(ticket_id)
    prev = (j or {}).get("clear") or {}
    state = {"state": prev.get("state", "unavailable"), "last_error": reason, "at": now_iso()}
    if "token" in prev:
        state["token"] = prev["token"]
    if j is not None and prev.get("state") == "clearing":
        j["clear"] = state
        jobs.save(j)
    status.set_clear(ticket_id, state)
