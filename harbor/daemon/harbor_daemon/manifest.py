"""Whole-card manifest: path, size, checksum, timestamp, duration, media type, recent flag."""
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone

from . import hashing
from .state import now_iso

PHASE_LISTED = "pending"
PHASE_COMPLETE = "complete"


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def probe_duration(path):
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        )
        return round(float(json.loads(out.stdout)["format"]["duration"]), 3)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError):
        return None


def iter_card_files(mount_path, ignore_names):
    """Yield (relative_path, abs_path) for every regular file. Symlinks are not followed."""
    ignore = set(ignore_names)
    for dirpath, dirs, files in os.walk(mount_path, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ignore and not os.path.islink(os.path.join(dirpath, d)))
        for fn in sorted(files):
            if fn in ignore or fn.startswith("._"):
                continue
            ap = os.path.join(dirpath, fn)
            if os.path.islink(ap):
                continue
            yield os.path.relpath(ap, mount_path).replace(os.sep, "/"), ap


def build_listing(cfg, profiles, mount, fingerprint, fp_source, record, now):
    """Phase 1: fast listing with no checksums. Safe to publish immediately."""
    matched = profiles.match(mount.path)
    last_file_ts = record.get("last_ingested_file_ts")
    window_start = now - cfg.recent_window_hours * 3600
    files = []
    for rel, ap in iter_card_files(mount.path, cfg.ignore_names):
        try:
            st = os.stat(ap)
        except OSError:
            continue
        ts = st.st_mtime
        mtype, pname = profiles.classify(rel, matched)
        recent = ts > last_file_ts if last_file_ts is not None else ts >= window_start
        files.append({
            "relative_path": rel,
            "filename": os.path.basename(rel),
            "size": st.st_size,
            "timestamp": _iso(ts),
            "timestamp_source": "mtime",
            "_ts": ts,
            "media_type": mtype,
            "profile": pname,
            "duration": None,
            "checksum": None,
            "recent": recent,
        })
    return {
        "schema": 1,
        "present": True,
        "card": {
            "fingerprint": fingerprint,
            "fingerprint_source": fp_source,
            "fstype": mount.fstype,
            "label": os.path.basename(mount.path.rstrip("/")),
            "total_bytes": _total_bytes(mount.path),
        },
        "profiles_matched": [p.name for p in matched],
        # Unknown structure is never skipped: every file is listed regardless.
        "profile_matched": bool(matched),
        "scanned_at": now_iso(),
        "checksum_algorithm": cfg.checksum_algorithm,
        "checksum_state": PHASE_LISTED,
        "last_ingest_at": record.get("last_ingest_at"),
        "recent_window_hours": cfg.recent_window_hours,
        "recent_basis": "last_ingested_file_ts" if last_file_ts is not None else "time_window",
        "files": files,
    }


def _total_bytes(path):
    try:
        st = os.statvfs(path)
        return st.f_blocks * st.f_frsize
    except OSError:
        return None


def fill_checksums(cfg, mount, manifest, cache, publish=None, should_stop=lambda: False):
    """Phase 2: checksum (and probe duration for) every file, using a size+mtime cache.

    Returns the updated cache. Calls publish(manifest) periodically for progress.
    """
    algo = cfg.checksum_algorithm
    total = len(manifest["files"])
    for i, f in enumerate(manifest["files"]):
        if should_stop():
            return cache
        ap = os.path.join(mount.path, f["relative_path"])
        st_key = "%d:%d" % (f["size"], int(f["_ts"] * 1e9))
        hit = cache.get(f["relative_path"])
        if hit and hit.get("key") == st_key and hit.get("algo") == algo:
            f["checksum"] = hit["checksum"]
            f["duration"] = hit.get("duration")
        else:
            try:
                f["checksum"] = hashing.hash_file(ap, algo)
            except OSError as e:
                f["checksum"] = None
                f["error"] = "unreadable: %s" % e
                continue
            if cfg.probe_duration and f["media_type"] in ("video", "audio"):
                f["duration"] = probe_duration(ap)
            cache[f["relative_path"]] = {"key": st_key, "algo": algo, "checksum": f["checksum"], "duration": f["duration"]}
        manifest["checksum_progress"] = (i + 1) / total if total else 1.0
        if publish and (i % 25 == 24):
            publish(manifest)
    manifest["checksum_state"] = PHASE_COMPLETE
    manifest["checksum_progress"] = 1.0
    return cache


def public_view(manifest):
    """Strip internal fields before writing to the share."""
    out = dict(manifest)
    out["files"] = [{k: v for k, v in f.items() if not k.startswith("_")} for f in manifest["files"]]
    return out
