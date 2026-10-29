"""Small JPEG previews for the desktop's card grid, written to tickets/thumbs/<fingerprint>/.

The desktop cannot read the card (it is plugged into the NAS), so the daemon makes the previews.
Every step is best-effort: a file without a preview is still listed and can still be ingested.
"""
import hashlib
import os
import posixpath
import shutil
import subprocess

PHOTO_DIRECT = {"jpg", "jpeg", "png", "heic", "hif", "tif", "tiff"}
RAW = {"arw", "raw", "cr2", "cr3", "nef", "dng", "orf", "rw2"}
_SOI = b"\xff\xd8\xff"
_EOI = b"\xff\xd9"
RAW_SCAN_BYTES = 16 * 1024 * 1024


def thumb_name(f):
    """Stable per file version, so an unchanged card reuses its previews."""
    key = "%s|%d|%s" % (f["relative_path"], f["size"], f["timestamp"])
    return hashlib.sha1(key.encode()).hexdigest()[:20] + ".jpg"


def _sony_thumbnail(mount_path, rel):
    """Sony XAVC cards keep a ready-made JPEG per clip: CLIP/C0001.MP4 -> THMBNL/C0001T01.JPG."""
    d, fn = posixpath.split(rel)
    if posixpath.basename(d).upper() != "CLIP":
        return None
    stem = os.path.splitext(fn)[0]
    tdir = os.path.join(mount_path, *posixpath.split(d)[0].split("/"), "THMBNL")
    for cand in (stem + "T01.JPG", stem + "T01.jpg"):
        p = os.path.join(tdir, cand)
        if os.path.isfile(p):
            return p
    return None


def _largest_embedded_jpeg(path):
    """Raw files carry a full-size JPEG preview; take the largest complete one in the first 16 MB."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(RAW_SCAN_BYTES)
    except OSError:
        return None
    best = None
    i = data.find(_SOI)
    while i != -1:
        j = data.find(_EOI, i + 3)
        if j == -1:
            break
        if best is None or (j - i) > (best[1] - best[0]):
            best = (i, j + 2)
        i = data.find(_SOI, j + 2)
    if best is None or best[1] - best[0] < 4096:
        return None
    return data[best[0]:best[1]]


def _ffmpeg(args, timeout):
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        r = subprocess.run([exe, "-v", "error", "-y"] + args, capture_output=True, timeout=timeout)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _scale(src, dest, width, timeout, seek=None, stdin_bytes=None):
    vf = "scale=%d:-2:force_original_aspect_ratio=decrease" % width
    tmp = dest + ".part.jpg"
    pre = ["-ss", str(seek)] if seek is not None else []
    if stdin_bytes is not None:
        exe = shutil.which("ffmpeg")
        if not exe:
            return False
        try:
            r = subprocess.run([exe, "-v", "error", "-y", "-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1",
                                "-vf", vf, "-q:v", "5", tmp], input=stdin_bytes, capture_output=True, timeout=timeout)
            ok = r.returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
    else:
        ok = _ffmpeg(pre + ["-i", src, "-frames:v", "1", "-vf", vf, "-q:v", "5", tmp], timeout)
    if ok and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
        os.replace(tmp, dest)
        return True
    try:
        os.unlink(tmp)
    except OSError:
        pass
    return False


def make_thumbnail(cfg, mount_path, f, dest):
    """Write a preview for manifest file entry `f` to `dest`. Returns True on success."""
    if os.path.isfile(dest):
        return True
    rel = f["relative_path"]
    src = os.path.join(mount_path, *rel.split("/"))
    ext = os.path.splitext(rel)[1].lower().lstrip(".")
    w, t = cfg.thumbnail_width, cfg.thumbnail_timeout_seconds
    if f["media_type"] == "video":
        ready = _sony_thumbnail(mount_path, rel)
        if ready and _scale(ready, dest, w, t):
            return True
        return _scale(src, dest, w, t, seek=1) or _scale(src, dest, w, t)
    if ext in RAW:
        jpg = _largest_embedded_jpeg(src)
        return bool(jpg) and _scale(None, dest, w, t, stdin_bytes=jpg)
    if ext in PHOTO_DIRECT:
        return _scale(src, dest, w, t)
    return False


def fill_thumbnails(cfg, mount_path, manifest, publish=None, should_stop=lambda: False):
    """Add a `thumb` file name to each previewable entry, publishing as previews appear."""
    if not cfg.thumbnails:
        return
    out_dir = os.path.join(cfg.thumbs_dir, manifest["card"]["fingerprint"])
    os.makedirs(out_dir, exist_ok=True)
    made = 0
    for f in manifest["files"]:
        if should_stop():
            return
        if f.get("sidecar_of") or f["media_type"] not in ("video", "photo"):
            continue
        name = thumb_name(f)
        if make_thumbnail(cfg, mount_path, f, os.path.join(out_dir, name)):
            f["thumb"] = name
            made += 1
            if publish and made % 12 == 0:
                publish(manifest)
    if publish:
        publish(manifest)
