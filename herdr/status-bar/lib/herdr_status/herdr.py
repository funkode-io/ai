"""Thin wrapper over the ``herdr`` CLI.

Everything the status bar needs comes from a single ``herdr api snapshot``
call, so a refresh tick costs one subprocess no matter how many segments are
enabled. That is the main reason these segments live in one plugin.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess


class HerdrError(RuntimeError):
    pass


def binary() -> str:
    """Locate the herdr binary.

    Inside a Herdr-managed process ``HERDR_BIN_PATH`` is authoritative; status
    bar commands run on the server and may have a minimal PATH.
    """
    env = os.environ.get("HERDR_BIN_PATH")
    if env and os.path.exists(env):
        return env
    found = shutil.which("herdr")
    if not found:
        raise HerdrError("herdr binary not found (set HERDR_BIN_PATH)")
    return found


def _run(args: list[str], timeout: float) -> dict:
    try:
        proc = subprocess.run(
            [binary(), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HerdrError(f"herdr {' '.join(args)} timed out") from exc
    if proc.returncode != 0:
        raise HerdrError(proc.stderr.strip() or f"herdr {' '.join(args)} failed")
    try:
        return json.loads(proc.stdout)
    except ValueError as exc:
        raise HerdrError(f"herdr {' '.join(args)} returned non-JSON output") from exc


def snapshot(timeout: float = 3.0) -> dict:
    payload = _run(["api", "snapshot"], timeout=timeout)
    result = payload.get("result", payload)
    return result.get("snapshot", result)


def focused_pane(snap: dict) -> dict | None:
    """Return the pane the user is looking at, or None.

    ``focused_pane_id`` is the session-level answer. The per-pane ``focused``
    flag is only a fallback for snapshots that predate that field.
    """
    panes = snap.get("panes") or []
    pane_id = snap.get("focused_pane_id")
    if pane_id:
        for pane in panes:
            if pane.get("pane_id") == pane_id:
                return pane
    for pane in panes:
        if pane.get("focused"):
            return pane
    return None


def pane_cwd(pane: dict | None) -> str | None:
    """Prefer the foreground process cwd; it tracks `cd` inside the pane."""
    if not pane:
        return None
    return pane.get("foreground_cwd") or pane.get("cwd")
