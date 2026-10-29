import json
import os
import shutil
import subprocess

import pytest

from harbor_daemon import thumbs
from harbor_daemon.manifest import mark_kinds

EXT = {"mp4": "video", "arw": "photo", "jpg": "photo", "wav": "audio"}


def kinds(paths):
    files = [{"relative_path": p} for p in paths]
    mark_kinds(files, EXT)
    return {f["relative_path"]: (f["kind"], f.get("sidecar_of")) for f in files}


def test_sony_sidecars_attach_to_their_clip():
    k = kinds([
        "PRIVATE/M4ROOT/CLIP/C0001.MP4",
        "PRIVATE/M4ROOT/CLIP/C0001M01.XML",
        "PRIVATE/M4ROOT/THMBNL/C0001T01.JPG",
        "PRIVATE/M4ROOT/MEDIAPRO.XML",
        "DCIM/100MSDCF/DSC00001.ARW",
        "DCIM/100MSDCF/DSC00001.JPG",
    ])
    assert k["PRIVATE/M4ROOT/CLIP/C0001.MP4"] == ("media", None)
    assert k["PRIVATE/M4ROOT/CLIP/C0001M01.XML"] == ("sidecar", "PRIVATE/M4ROOT/CLIP/C0001.MP4")
    assert k["PRIVATE/M4ROOT/THMBNL/C0001T01.JPG"] == ("sidecar", "PRIVATE/M4ROOT/CLIP/C0001.MP4")
    assert k["PRIVATE/M4ROOT/MEDIAPRO.XML"] == ("extra", None)
    # A RAW+JPEG pair are both photos the user may want: neither hides the other.
    assert k["DCIM/100MSDCF/DSC00001.ARW"][0] == "media"
    assert k["DCIM/100MSDCF/DSC00001.JPG"][0] == "media"


def test_longest_stem_wins():
    k = kinds(["A/C1.MP4", "A/C10.MP4", "A/C10M01.XML"])
    assert k["A/C10M01.XML"] == ("sidecar", "A/C10.MP4")


def test_embedded_jpeg_is_found_in_raw(tmp_path):
    small = b"\xff\xd8\xff" + b"a" * 5000 + b"\xff\xd9"
    big = b"\xff\xd8\xff" + b"b" * 20000 + b"\xff\xd9"
    p = tmp_path / "x.arw"
    p.write_bytes(b"II*\x00" + b"\x00" * 100 + small + b"\x00" * 50 + big + b"\x00" * 10)
    assert thumbs._largest_embedded_jpeg(str(p)) == big


def test_manifest_marks_kinds_and_daemon_lists_destinations(env):
    env.sony_card()
    env.add_card_file("PRIVATE/M4ROOT/CLIP/C0001M01.XML", b"<xml/>")
    os.makedirs(os.path.join(env.projects, "Older Shoot"))
    os.makedirs(os.path.join(env.projects, ".hidden"))
    d = env.daemon(destination_labels={env.projects: "Tehuti"})
    d.tick()
    by = {f["relative_path"]: f for f in env.manifest()["files"]}
    assert by["PRIVATE/M4ROOT/CLIP/C0001M01.XML"]["sidecar_of"] == "PRIVATE/M4ROOT/CLIP/C0001.MP4"
    with open(os.path.join(env.cfg().cards_dir, "_daemon.json")) as f:
        info = json.load(f)
    assert info["destinations"] == [{"root": env.projects, "label": "Tehuti", "projects": ["Older Shoot"]}]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_photo_thumbnail_is_written(env):
    src = os.path.join(env.card, "DCIM", "100MSDCF")
    os.makedirs(src)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=640x480", "-frames:v", "1",
                    os.path.join(src, "DSC00001.JPG")], check=True)
    env.daemon(thumbnails=True).tick()
    f = next(x for x in env.manifest()["files"] if x["relative_path"].endswith("DSC00001.JPG"))
    assert os.path.getsize(os.path.join(env.cfg().thumbs_dir, "ABCD-1234", f["thumb"])) > 0
