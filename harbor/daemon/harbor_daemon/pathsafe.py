"""Path-escape defence. Every path that originates in a ticket goes through here."""
import os
import re

_DRIVE = re.compile(r"^[A-Za-z]:")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class PathError(ValueError):
    pass


def check_relpath(p):
    """Validate a relative POSIX path. Rejects '..', absolute paths, backslashes, NULs."""
    if not isinstance(p, str) or not p:
        raise PathError("path must be a non-empty string")
    if _CONTROL.search(p):
        raise PathError("path contains control characters")
    if "\\" in p:
        raise PathError("path contains a backslash")
    if p.startswith("/") or _DRIVE.match(p):
        raise PathError("path must be relative")
    for seg in p.split("/"):
        if seg in ("", ".", ".."):
            raise PathError("path contains an empty, '.' or '..' segment")
    return p


def check_component(name):
    """Validate a single path component (e.g. a project folder name)."""
    if not isinstance(name, str) or not name.strip():
        raise PathError("name must be a non-empty string")
    if _CONTROL.search(name) or "/" in name or "\\" in name:
        raise PathError("name contains a path separator or control character")
    if name in (".", "..") or name.startswith("."):
        raise PathError("name must not be '.', '..' or hidden")
    if len(name.encode("utf-8")) > 200:
        raise PathError("name too long")
    return name


def resolve_within(base, rel):
    """Join base/rel and resolve symlinks; the result must stay inside base.

    Re-run immediately before every write/read so a symlink swapped in after
    validation is still caught.
    """
    real_base = os.path.realpath(base)
    target = os.path.realpath(os.path.join(real_base, rel))
    if target != real_base and not target.startswith(real_base + os.sep):
        raise PathError("path escapes its root")
    return target
