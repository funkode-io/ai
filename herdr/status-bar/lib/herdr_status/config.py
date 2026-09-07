"""Configuration and cache locations for the status bar plugin.

Plugin config is JSON, not TOML, on purpose: the status script must run on any
Python 3.9+ without depending on ``tomllib`` (3.11+) or a third-party parser.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

PLUGIN_ID = "funkode.status-bar"

DEFAULTS = {
    # Order of the segments in the combined line.
    "segments": ["treehouse", "context", "pr"],
    "separator": "  ",
    # Prefixes are plain ASCII so the bar stays readable in any font.
    # Swap them for Nerd Font glyphs in your own config if you like.
    "treehouse_prefix": "th:",
    "context_prefix": "ctx",
    "pr_prefix": "#",
    # Shown when a segment cannot resolve a value. Empty string hides it.
    "placeholder": "",
    # Context window fallback when the model catalog has no contextWindow.
    "default_context_window": 200000,
    # Roots scanned for treehouse pools.
    "treehouse_root": "~/.treehouse",
    # Root of pi's session storage.
    "pi_session_root": "~/.pi/agent/sessions",
    # Only read the tail of a session file; sessions grow without bound.
    "session_tail_bytes": 262144,
    # Let `gh` populate the PR cache. Never called on the status bar's hot path.
    "pr_gh_enabled": True,
    "pr_cache_ttl_seconds": 900,
}


def _state_dir() -> Path:
    env = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if env:
        return Path(env)
    return Path(
        os.environ.get("XDG_STATE_HOME", "~/.local/state")
    ).expanduser() / "herdr" / PLUGIN_ID


def cache_path(name: str) -> Path:
    path = _state_dir() / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _candidate_config_paths() -> list[Path]:
    candidates = []
    explicit = os.environ.get("HERDR_STATUS_CONFIG")
    if explicit:
        candidates.append(Path(explicit))
    plugin_dir = os.environ.get("HERDR_PLUGIN_CONFIG_DIR")
    if plugin_dir:
        candidates.append(Path(plugin_dir) / "config.json")
    xdg = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    candidates.append(xdg / "herdr" / "plugins" / PLUGIN_ID / "config.json")
    candidates.append(xdg / "herdr" / "herdr-status.json")
    return [p.expanduser() for p in candidates]


def load() -> dict:
    """Merge the first readable config file over the defaults."""
    settings = dict(DEFAULTS)
    for path in _candidate_config_paths():
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            loaded = json.loads(raw)
        except ValueError:
            continue
        if isinstance(loaded, dict):
            settings.update(loaded)
        break
    return settings
