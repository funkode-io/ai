"""Resolve a directory to the treehouse pool and worktree that own it.

Treehouse keeps one ``treehouse-state.json`` per pool under ``~/.treehouse``:

    ~/.treehouse/<pool>/treehouse-state.json
    {"worktrees": [{"name": "2", "path": "...", "lease_holder": "pr-151", ...}]}

The pool directory name is ``<repo>-<hash>``; the hash is noise for a status
bar, so it is trimmed off for display.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

POOL_SUFFIX = re.compile(r"-[0-9a-f]{6,}$")


class Worktree:
    __slots__ = ("pool", "name", "path", "lease_holder", "leased")

    def __init__(self, pool: str, entry: dict):
        self.pool = pool
        self.name = str(entry.get("name") or "?")
        self.path = entry.get("path") or ""
        self.lease_holder = entry.get("lease_holder")
        self.leased = bool(entry.get("leased"))

    @property
    def pool_label(self) -> str:
        return POOL_SUFFIX.sub("", self.pool)

    @property
    def label(self) -> str:
        return f"{self.pool_label}/{self.name}"

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Worktree {self.label} lease={self.lease_holder}>"


def _iter_worktrees(root: Path):
    try:
        pools = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return
    for pool in pools:
        state = pool / "treehouse-state.json"
        try:
            data = json.loads(state.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for entry in data.get("worktrees") or []:
            if entry.get("path"):
                yield Worktree(pool.name, entry)


def find(cwd: str | None, root: str = "~/.treehouse") -> Worktree | None:
    """Return the worktree containing ``cwd``.

    Matching is by path containment rather than equality so a pane that has
    cd'd into a subdirectory still resolves. The longest match wins, which
    keeps nested checkouts unambiguous.
    """
    if not cwd:
        return None
    try:
        target = Path(cwd).expanduser().resolve()
    except OSError:
        return None

    best = None
    best_len = -1
    for worktree in _iter_worktrees(Path(root).expanduser()):
        try:
            candidate = Path(worktree.path).expanduser().resolve()
        except OSError:
            continue
        if candidate == target or candidate in target.parents:
            depth = len(candidate.parts)
            if depth > best_len:
                best, best_len = worktree, depth
    return best
