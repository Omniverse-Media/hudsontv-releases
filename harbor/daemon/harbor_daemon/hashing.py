"""Checksums. Format is '<algo>:<hex>' so the algorithm is recorded with every value."""
import hashlib
import os

CHUNK = 4 * 1024 * 1024
SUPPORTED = ("xxh64", "sha256")


def new_hasher(algo):
    if algo == "xxh64":
        import xxhash

        return xxhash.xxh64()
    if algo == "sha256":
        return hashlib.sha256()
    raise ValueError("unsupported checksum algorithm: %s" % algo)


def fmt(algo, hexdigest):
    return "%s:%s" % (algo, hexdigest)


def normalize(value, default_algo):
    """Accept 'algo:hex' or bare hex (assumed default_algo); return canonical lowercase."""
    if not value:
        return None
    value = value.strip().lower()
    if ":" in value:
        return value
    return fmt(default_algo, value)


def drop_cache(fd):
    """Best effort: ask the kernel to forget cached pages so a verify re-read hits the disk."""
    try:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    except (AttributeError, OSError):
        pass


def hash_file(path, algo, progress=None, cold=False):
    h = new_hasher(algo)
    done = 0
    with open(path, "rb") as f:
        if cold:
            drop_cache(f.fileno())
        while True:
            buf = f.read(CHUNK)
            if not buf:
                break
            h.update(buf)
            done += len(buf)
            if progress:
                progress(done)
        if cold:
            drop_cache(f.fileno())
    return fmt(algo, h.hexdigest())
