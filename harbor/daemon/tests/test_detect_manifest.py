import time

from harbor_daemon.detect import Mount, MountDetector, sanitize_fingerprint


def test_baseline_diff_detects_only_new_removable(env):
    cfg = env.cfg()
    mounts = [Mount("/dev/root", "/", "ext4"), Mount("/dev/vol1", "/volume1", "btrfs")]
    det = MountDetector(cfg, lambda: list(mounts))
    assert det.poll() == ([], [])
    card = Mount("/dev/usb1p1", env.card, "exfat")
    mounts.append(card)
    added, removed = det.poll()
    assert added == [card] and removed == []
    assert det.poll() == ([], [])
    mounts.remove(card)
    assert det.poll() == ([], [card])


def test_non_card_fstype_and_non_removable_ignored(env):
    cfg = env.cfg()
    mounts = [Mount("/dev/x", env.card, "squashfs"), Mount("/dev/y", "/volume2", "ext4")]
    det = MountDetector(cfg, lambda: mounts)
    assert det.candidates() == {}


def test_pinned_removable_drive_is_not_a_card(env):
    cfg = env.cfg()
    mounts = [Mount("/dev/usbhdd", env.card, "ext4")]
    det = MountDetector(cfg, lambda: mounts)
    det.snapshot_baseline(include_removable=True)
    assert det.candidates() == {}


def test_fingerprint_is_filename_safe():
    assert sanitize_fingerprint("../../etc/x y") == "..-..-etc-x-y"


def test_manifest_scans_whole_card_and_flags_recent(env):
    old = time.time() - 30 * 24 * 3600
    env.add_card_file("PRIVATE/M4ROOT/CLIP/OLD.MP4", mtime=old)
    env.add_card_file("PRIVATE/M4ROOT/CLIP/NEW.MP4")
    env.add_card_file("WEIRD/thing.bin")
    env.add_card_file(".Spotlight-V100/junk")
    d = env.daemon()
    d.tick()
    m = env.manifest()
    by = {f["relative_path"]: f for f in m["files"]}
    assert set(by) == {"PRIVATE/M4ROOT/CLIP/OLD.MP4", "PRIVATE/M4ROOT/CLIP/NEW.MP4", "WEIRD/thing.bin"}
    assert by["PRIVATE/M4ROOT/CLIP/NEW.MP4"]["recent"] is True
    assert by["PRIVATE/M4ROOT/CLIP/OLD.MP4"]["recent"] is False
    assert by["WEIRD/thing.bin"]["media_type"] == "other"
    assert m["checksum_state"] == "complete"
    assert m["checksum_algorithm"] == "xxh64"
    assert all(f["checksum"].startswith("xxh64:") for f in m["files"])
    assert m["profiles_matched"] == ["Sony video"]


def test_unknown_card_structure_is_never_skipped(env):
    env.add_card_file("MYSTERY/a.dat")
    env.add_card_file("MYSTERY/b.wav")
    env.daemon().tick()
    m = env.manifest()
    assert m["profile_matched"] is False
    assert len(m["files"]) == 2
