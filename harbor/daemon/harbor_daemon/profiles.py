"""Device profiles: folder-pattern matching loaded from config.

A profile matches when every `signature` path exists (and, if `signature_any` is set, at least one of those) on the card (case-insensitive).
Several profiles can match one card (Sony bodies carry both M4ROOT and DCIM).
Files outside any matched profile root are still included, classified by extension;
anything unclassifiable becomes media type 'other'. Nothing is ever skipped.
"""
import json
import os
from dataclasses import dataclass

MEDIA_TYPES = ("video", "audio", "photo", "other")


@dataclass(frozen=True)
class Profile:
    name: str
    media_type: str
    signature: tuple
    roots: tuple
    signature_any: tuple = ()


class ProfileSet:
    def __init__(self, profiles, extension_types):
        self.profiles = profiles
        self.ext_to_type = {}
        for mtype, exts in extension_types.items():
            for e in exts:
                self.ext_to_type[e.lower().lstrip(".")] = mtype

    def match(self, mount_path):
        """Return the profiles whose signature folders all exist on the card."""
        matched = []
        for p in self.profiles:
            all_ok = all(_exists_ci(mount_path, s) for s in p.signature)
            any_ok = not p.signature_any or any(_exists_ci(mount_path, s) for s in p.signature_any)
            if (p.signature or p.signature_any) and all_ok and any_ok:
                matched.append(p)
        return matched

    def classify(self, rel_path, matched):
        """Return (media_type, profile_name|None) for a card-relative path."""
        lowered = rel_path.lower()
        for p in matched:
            for root in p.roots:
                r = root.lower().strip("/")
                if lowered == r or lowered.startswith(r + "/"):
                    return p.media_type, p.name
        ext = os.path.splitext(rel_path)[1].lower().lstrip(".")
        return self.ext_to_type.get(ext, "other"), None


def _exists_ci(base, rel):
    """Case-insensitive directory walk (FAT/exFAT are case-insensitive, Linux mounts are not)."""
    cur = base
    for seg in rel.split("/"):
        try:
            names = os.listdir(cur)
        except OSError:
            return False
        hit = next((n for n in names if n.lower() == seg.lower()), None)
        if hit is None:
            return False
        cur = os.path.join(cur, hit)
    return True


def load_profiles(path=""):
    if not path:
        path = os.path.join(os.path.dirname(__file__), "default_profiles.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    profiles = []
    for p in data.get("profiles", []):
        if p["media_type"] not in MEDIA_TYPES:
            raise ValueError("profile %r has invalid media_type" % p.get("name"))
        sig = tuple(p.get("signature", ()))
        any_ = tuple(p.get("signature_any", ()))
        profiles.append(Profile(p["name"], p["media_type"], sig, tuple(p.get("roots", sig + any_)), any_))
    return ProfileSet(profiles, data.get("extension_types", {}))
