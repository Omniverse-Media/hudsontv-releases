import os

import pytest

from harbor_daemon import pathsafe
from harbor_daemon.profiles import load_profiles


@pytest.mark.parametrize("bad", ["../x", "a/../b", "/etc/passwd", "a//b", "a\\b", "C:\\x", "", "./a", "a/\x00b", "a/."])
def test_relpath_rejects_escapes(bad):
    with pytest.raises(pathsafe.PathError):
        pathsafe.check_relpath(bad)


def test_relpath_accepts_normal():
    assert pathsafe.check_relpath("Footage/Video 1/Day-01") == "Footage/Video 1/Day-01"


@pytest.mark.parametrize("bad", ["..", ".", "a/b", ".hidden", "", "a\\b"])
def test_component_rejects(bad):
    with pytest.raises(pathsafe.PathError):
        pathsafe.check_component(bad)


def test_resolve_within_blocks_symlink_escape(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, base / "link")
    with pytest.raises(pathsafe.PathError):
        pathsafe.resolve_within(str(base), "link/file")


def test_profiles_match_case_insensitive_and_classify(tmp_path):
    (tmp_path / "private" / "m4root" / "CLIP").mkdir(parents=True)
    (tmp_path / "DCIM").mkdir()
    ps = load_profiles()
    matched = ps.match(str(tmp_path))
    assert {p.name for p in matched} == {"Sony video", "Sony photo"}
    assert ps.classify("PRIVATE/M4ROOT/CLIP/C1.MP4", matched) == ("video", "Sony video")
    assert ps.classify("DCIM/100/X.ARW", matched) == ("photo", "Sony photo")
    # Outside any profile root: classified by extension, else 'other'. Never dropped.
    assert ps.classify("MISC/take.wav", matched) == ("audio", None)
    assert ps.classify("MISC/notes.xyz", matched) == ("other", None)


def test_zoom_profile_matches_any_known_folder_and_wav_anywhere_is_audio(tmp_path):
    (tmp_path / "STEREO" / "FOLDER01").mkdir(parents=True)
    ps = load_profiles()
    matched = ps.match(str(tmp_path))
    assert [p.name for p in matched] == ["Zoom recorder"]
    assert ps.classify("STEREO/FOLDER01/ZOOM0001.WAV", matched) == ("audio", "Zoom recorder")
    # Rode / Hollyland style card with no known folders: still audio by extension, still listed
    assert ps.classify("RECORD/LARK_0001.WAV", []) == ("audio", None)
    assert ps.classify("TX_01/REC0001.wav", []) == ("audio", None)
