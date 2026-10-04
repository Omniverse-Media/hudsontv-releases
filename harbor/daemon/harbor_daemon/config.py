"""Configuration. Approved roots, profiles and every tunable live here, not in code."""
import json
import os
from dataclasses import dataclass, field, fields


@dataclass
class Config:
    harbor_root: str = "/harbor"
    # Destination allowlist: a ticket's approved_root must equal one of these.
    approved_roots: list = field(default_factory=list)
    profiles_file: str = ""  # empty = built-in default_profiles.json

    # Detection
    removable_mount_prefixes: list = field(default_factory=lambda: ["/volumeUSB"])
    card_fstypes: list = field(
        default_factory=lambda: ["exfat", "vfat", "msdos", "ntfs", "fuseblk", "ext4", "ext3", "hfsplus", "udf"]
    )
    known_server_volume_serials: list = field(default_factory=list)
    poll_interval_seconds: float = 2.0
    serial_command: str = ""  # optional, e.g. "blkid -s UUID -o value {device}"

    # Manifest
    checksum_algorithm: str = "xxh64"
    recent_window_hours: float = 72.0
    ignore_names: list = field(
        default_factory=lambda: [
            ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems",
            "System Volume Information", "$RECYCLE.BIN", ".DS_Store", "Thumbs.db",
        ]
    )
    probe_duration: bool = True

    # Transfer
    layout: str = "flat"  # "flat" = <subfolder>/<filename>; "preserve" = <subfolder>/<card path>
    handoff_partial_suffix: str = ".harbor-partial"
    max_file_attempts: int = 3
    pause_retry_seconds: float = 30.0
    max_selection: int = 100000

    # Card clearing (off unless explicitly enabled; mount the card read-write too)
    allow_clear: bool = False
    clear_rehash_destination: bool = True

    # ---- derived paths -------------------------------------------------
    @property
    def incoming_dir(self):
        return os.path.join(self.harbor_root, "tickets", "incoming")

    @property
    def status_dir(self):
        return os.path.join(self.harbor_root, "tickets", "status")

    @property
    def processed_dir(self):
        return os.path.join(self.harbor_root, "tickets", "processed")

    @property
    def cards_dir(self):
        return os.path.join(self.harbor_root, "tickets", "cards")

    @property
    def staging_dir(self):
        return os.path.join(self.harbor_root, "staging")

    @property
    def logs_dir(self):
        return os.path.join(self.harbor_root, "logs")

    @property
    def state_dir(self):
        return os.path.join(self.harbor_root, "state")

    def ensure_dirs(self):
        for d in (self.incoming_dir, self.status_dir, self.processed_dir, self.cards_dir,
                  self.staging_dir, self.logs_dir, self.state_dir):
            os.makedirs(d, exist_ok=True)


class ConfigError(ValueError):
    pass


def from_dict(data):
    known = {f.name for f in fields(Config)}
    unknown = set(data) - known
    if unknown:
        raise ConfigError("unknown config keys: %s" % ", ".join(sorted(unknown)))
    cfg = Config(**data)
    if cfg.layout not in ("flat", "preserve"):
        raise ConfigError("layout must be 'flat' or 'preserve'")
    from .hashing import SUPPORTED

    if cfg.checksum_algorithm not in SUPPORTED:
        raise ConfigError("checksum_algorithm must be one of %s" % (SUPPORTED,))
    for r in cfg.approved_roots:
        if not os.path.isabs(r) or ".." in r.split("/"):
            raise ConfigError("approved_roots must be absolute paths without '..': %r" % r)
    if not cfg.handoff_partial_suffix:
        raise ConfigError("handoff_partial_suffix must not be empty")
    return cfg


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return from_dict(json.load(f))
