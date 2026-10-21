#!/usr/bin/env python3
"""Online SQLite snapshots, privately retained outside the static document root."""
import os
from pathlib import Path
import sqlite3
from datetime import datetime, timezone, timedelta

os.umask(0o077)
source = Path("/var/lib/fkssj/fkssj.sqlite3")
directory = Path("/var/backups/fkssj")
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
stamp = datetime.now(timezone.utc)
target = directory / f"fkssj-{stamp.strftime('%Y%m%dT%H%M%S%fZ')}.sqlite3"
try:
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as origin:
        with sqlite3.connect(target) as destination:
            origin.backup(destination)
            if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("Backup integrity check failed")
    target.chmod(0o600)
except Exception:
    target.unlink(missing_ok=True)
    raise
# Purge only our dated snapshot filenames, after a verified successful backup.
cutoff = (stamp - timedelta(days=7)).timestamp()
for path in directory.glob("fkssj-????????T????????????Z.sqlite3"):
    if path.is_file() and not path.is_symlink() and path.stat().st_mtime < cutoff:
        path.unlink()
print("Game database snapshot verified.")
