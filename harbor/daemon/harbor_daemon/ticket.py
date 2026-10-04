"""Job ticket schema, validation and card binding.

A ticket is a sealed work order. The daemon never trusts it for authority: the
destination must be on the allowlist, every path is checked for escape, the source
is a card fingerprint resolved by the daemon, and each selected file must exist on
that card. `origin` is self-asserted metadata for the log, not an identity.
"""
import hashlib
import json
import os
import posixpath
import re
import uuid
from dataclasses import dataclass
from datetime import datetime

from . import hashing
from .pathsafe import PathError, check_component, check_relpath, resolve_within
from .profiles import MEDIA_TYPES

_FP = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class TicketError(Exception):
    pass


@dataclass
class SelectionItem:
    relative_path: str
    size: int
    checksum: object  # normalized "algo:hex" or None


@dataclass
class Ticket:
    ticket_id: str
    created_at: str
    origin: dict
    fingerprint: str
    project_name: str
    approved_root: str
    subfolder_map: dict
    selection: list
    copy: bool
    verify: bool
    clear_card: bool
    digest: str  # sha256 of the canonical ticket JSON, to detect edits after acceptance


def _req(d, key, typ, where):
    if not isinstance(d, dict) or key not in d:
        raise TicketError("missing field: %s.%s" % (where, key))
    if not isinstance(d[key], typ) or (typ is int and isinstance(d[key], bool)):
        raise TicketError("wrong type for %s.%s" % (where, key))
    return d[key]


def canonical_digest(raw):
    return hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate(raw, cfg, filename_id=None):
    """Validate a ticket dict. Raises TicketError on any failure."""
    if not isinstance(raw, dict):
        raise TicketError("ticket must be a JSON object")

    tid = _req(raw, "ticket_id", str, "ticket")
    try:
        if str(uuid.UUID(tid)) != tid.lower():
            raise ValueError
    except ValueError:
        raise TicketError("ticket_id must be a canonical UUID")
    tid = tid.lower()
    if filename_id is not None and filename_id != tid:
        raise TicketError("ticket file name does not match ticket_id")

    created = _req(raw, "created_at", str, "ticket")
    try:
        datetime.fromisoformat(created.replace("Z", "+00:00"))
    except ValueError:
        raise TicketError("created_at is not ISO-8601")

    origin = _req(raw, "origin", dict, "ticket")
    for k in ("machine", "user"):
        if len(str(_req(origin, k, str, "origin"))) > 200:
            raise TicketError("origin.%s too long" % k)

    source = _req(raw, "source", dict, "ticket")
    fp = _req(source, "card_fingerprint", str, "source")
    if not _FP.match(fp):
        raise TicketError("invalid card_fingerprint")

    dest = _req(raw, "destination", dict, "ticket")
    project_name = _req(dest, "project_name", str, "destination")
    approved_root = _req(dest, "approved_root", str, "destination")
    subfolder_map = _req(dest, "subfolder_map", dict, "destination")
    try:
        check_component(project_name)
    except PathError as e:
        raise TicketError("project_name: %s" % e)

    # Allowlist: compare the literal string (normalised) before touching the filesystem.
    if not os.path.isabs(approved_root) or ".." in approved_root.split("/"):
        raise TicketError("approved_root must be an absolute path without '..'")
    allowed = {posixpath.normpath(a) for a in cfg.approved_roots}
    if posixpath.normpath(approved_root) not in allowed:
        raise TicketError("approved_root is not on the allowlist")
    if not os.path.isdir(approved_root):
        raise TicketError("approved_root does not exist on this server")

    if not subfolder_map:
        raise TicketError("subfolder_map is empty")
    for mtype, sub in subfolder_map.items():
        if mtype not in MEDIA_TYPES:
            raise TicketError("subfolder_map has unknown media type: %r" % (mtype,))
        try:
            check_relpath(sub)
        except PathError as e:
            raise TicketError("subfolder_map[%s]: %s" % (mtype, e))

    sel_raw = _req(raw, "selection", list, "ticket")
    if not sel_raw:
        raise TicketError("selection is empty")
    if len(sel_raw) > cfg.max_selection:
        raise TicketError("selection too large")
    selection, seen = [], set()
    for i, item in enumerate(sel_raw):
        where = "selection[%d]" % i
        rel = _req(item, "relative_path", str, where)
        try:
            check_relpath(rel)
        except PathError as e:
            raise TicketError("%s.relative_path: %s" % (where, e))
        if rel in seen:
            raise TicketError("duplicate selection entry: %s" % rel)
        seen.add(rel)
        size = _req(item, "size", int, where)
        if size < 0:
            raise TicketError("%s.size is negative" % where)
        cs = item.get("checksum")
        if cs is not None and not isinstance(cs, str):
            raise TicketError("%s.checksum must be a string" % where)
        selection.append(SelectionItem(rel, size, hashing.normalize(cs, cfg.checksum_algorithm)))

    op = _req(raw, "operation", dict, "ticket")
    copy_ = _req(op, "copy", bool, "operation")
    verify = _req(op, "verify", bool, "operation")
    clear = _req(op, "clear_card", bool, "operation")
    if not copy_:
        raise TicketError("operation.copy must be true")
    if not verify:
        raise TicketError("operation.verify must be true: unverified transfers are not allowed")
    if clear and not cfg.allow_clear:
        raise TicketError("clear_card requested but card clearing is disabled on this server")

    return Ticket(tid, created, origin, fp, project_name, posixpath.normpath(approved_root),
                  subfolder_map, selection, copy_, verify, clear, canonical_digest(raw))


def project_dir(ticket):
    """Resolve <approved_root>/<project_name>, refusing symlink escapes. Call at write time."""
    return resolve_within(ticket.approved_root, ticket.project_name)


def destination_dir(ticket, media_type, rel_subdir=""):
    pdir = project_dir(ticket)
    sub = ticket.subfolder_map[media_type]
    return resolve_within(pdir, posixpath.join(sub, rel_subdir) if rel_subdir else sub)


def bind_to_card(ticket, mount_path, profiles):
    """Check every selected file resolves to a real, unchanged-size file on the card.

    Returns {relative_path: {"media_type", "abs"}}. The media type is decided here by
    the daemon's profiles, never taken from the ticket.
    """
    matched = profiles.match(mount_path)
    real_mount = os.path.realpath(mount_path)
    bound = {}
    for item in ticket.selection:
        try:
            target = resolve_within(real_mount, item.relative_path)
        except PathError:
            raise TicketError("selection escapes the card: %s" % item.relative_path)
        if target != os.path.join(real_mount, *item.relative_path.split("/")):
            raise TicketError("selection passes through a symlink: %s" % item.relative_path)
        try:
            st = os.lstat(target)
        except OSError:
            raise TicketError("selected file not found on card: %s" % item.relative_path)
        if not os.path.isfile(target):
            raise TicketError("selected path is not a regular file: %s" % item.relative_path)
        if st.st_size != item.size:
            raise TicketError("size mismatch for %s (ticket %d, card %d)" % (item.relative_path, item.size, st.st_size))
        mtype, _ = profiles.classify(item.relative_path, matched)
        if mtype not in ticket.subfolder_map:
            raise TicketError("no subfolder_map entry for media type '%s' (%s)" % (mtype, item.relative_path))
        bound[item.relative_path] = {"media_type": mtype, "abs": target}
    return bound
