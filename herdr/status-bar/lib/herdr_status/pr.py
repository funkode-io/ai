"""Resolve the pull request a pane is working on, cheaply.

The status bar refreshes on a timer, so the hot path must stay local: no
network, no ``gh``. Sources are tried in order of both cost and confidence:

1. The treehouse lease holder. The convention is to label a lease ``pr-<N>``
   for the PR the session is on, which makes it the most accurate signal.
2. The branch name, when it embeds a PR number (``pr-123``, ``pull/123``).
3. A cache written by the ``refresh-pr`` action, which may call ``gh``.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from . import config

LEASE_PR = re.compile(r"^pr-(\d+)$")
BRANCH_PR = re.compile(r"(?:^|[/_-])(?:pr|pull)[/_-](\d+)(?:$|[/_-])", re.IGNORECASE)

CACHE_FILE = "pr-cache.json"


class PullRequest:
    __slots__ = ("number", "source")

    def __init__(self, number: int, source: str):
        self.number = number
        self.source = source

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<PullRequest #{self.number} via {self.source}>"


def git_dir(cwd: str) -> Path | None:
    """Locate the .git directory for ``cwd``, walking up the tree.

    Linked worktrees have a ``.git`` *file* holding ``gitdir: <path>``.
    """
    try:
        current = Path(cwd).expanduser().resolve()
    except OSError:
        return None
    for candidate in [current, *current.parents]:
        dot_git = candidate / ".git"
        if dot_git.is_dir():
            return dot_git
        if dot_git.is_file():
            try:
                text = dot_git.read_text(encoding="utf-8").strip()
            except OSError:
                return None
            if text.startswith("gitdir:"):
                target = Path(text.split(":", 1)[1].strip()).expanduser()
                if not target.is_absolute():
                    target = (candidate / target).resolve()
                return target
    return None


def branch(cwd: str | None) -> str | None:
    """Current branch name, read straight from HEAD (no subprocess)."""
    if not cwd:
        return None
    gitdir = git_dir(cwd)
    if gitdir is None:
        return None
    try:
        head = (gitdir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if head.startswith("ref: refs/heads/"):
        return head[len("ref: refs/heads/") :]
    return None


def _cache_key(cwd: str | None, branch_name: str | None) -> str:
    return f"{cwd or '?'}@{branch_name or '?'}"


def _read_cache(key: str, ttl: int) -> int | None:
    try:
        data = json.loads(config.cache_path(CACHE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = data.get(key)
    if not isinstance(entry, dict):
        return None
    if ttl and time.time() - entry.get("at", 0) > ttl:
        return None
    number = entry.get("number")
    return int(number) if number else None


def _write_cache(key: str, number: int | None) -> None:
    path = config.cache_path(CACHE_FILE)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data[key] = {"number": number, "at": time.time()}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def find(cwd: str | None, worktree, settings: dict) -> PullRequest | None:
    if worktree is not None and worktree.lease_holder:
        match = LEASE_PR.match(str(worktree.lease_holder))
        if match:
            return PullRequest(int(match.group(1)), "treehouse lease")

    branch_name = branch(cwd)
    if branch_name:
        match = BRANCH_PR.search(branch_name)
        if match:
            return PullRequest(int(match.group(1)), "branch name")

    cached = _read_cache(_cache_key(cwd, branch_name), settings["pr_cache_ttl_seconds"])
    if cached:
        return PullRequest(cached, "gh cache")
    return None


def refresh(cwd: str | None, settings: dict) -> PullRequest | None:
    """Ask ``gh`` for the PR of the current branch and cache the answer.

    Never call this from a status bar tick; it makes a network request.
    """
    if not cwd or not settings.get("pr_gh_enabled"):
        return None
    branch_name = branch(cwd)
    if not branch_name:
        return None
    try:
        proc = subprocess.run(
            ["gh", "pr", "view", branch_name, "--json", "number"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    number = None
    if proc.returncode == 0:
        try:
            number = int(json.loads(proc.stdout).get("number"))
        except (ValueError, TypeError, AttributeError):
            number = None

    # Cache misses too: it stops every focus change from re-querying gh.
    _write_cache(_cache_key(cwd, branch_name), number)
    return PullRequest(number, "gh") if number else None
