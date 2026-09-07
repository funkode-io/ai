"""Context-window consumption for the pi agent running in a pane.

Herdr does not measure context; it only carries whatever tokens an agent
reports. pi, however, writes a JSONL session log where every assistant message
records its usage:

    {"type":"message","message":{"role":"assistant","model":"claude-opus-5",
     "provider":"github-copilot",
     "usage":{"input":2,"cacheRead":56898,"cacheWrite":1654,"output":233,...}}}

The prompt that was actually sent is ``input + cacheRead + cacheWrite``;
``output`` is the reply and is not part of the next request's context. So the
last assistant message tells us how full the window was on the last turn.
"""

from __future__ import annotations

import json
from pathlib import Path

# pi mangles a project path into a session directory: "--" + path without its
# leading slash and with "/" replaced by "-" + "--".
#   /Users/me/git/ai  ->  --Users-me-git-ai--
def session_dir_name(cwd: str) -> str:
    normalized = str(Path(cwd)).lstrip("/")
    return f"--{normalized.replace('/', '-')}--"


class Usage:
    __slots__ = ("used", "window", "model", "provider", "session_path")

    def __init__(self, used, window, model, provider, session_path):
        self.used = used
        self.window = window
        self.model = model
        self.provider = provider
        self.session_path = session_path

    @property
    def percent(self) -> int:
        if not self.window:
            return 0
        return min(100, round(self.used * 100 / self.window))

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Usage {self.used}/{self.window} {self.model}>"


def latest_session(cwd: str | None, root: str = "~/.pi/agent/sessions") -> Path | None:
    """Most recently written pi session for ``cwd``.

    When several panes share a working directory this picks the one that
    produced output last, which is the one a status bar should follow.
    """
    if not cwd:
        return None
    directory = Path(root).expanduser() / session_dir_name(cwd)
    try:
        files = [p for p in directory.iterdir() if p.suffix == ".jsonl"]
    except OSError:
        return None
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def _tail_lines(path: Path, tail_bytes: int) -> list[str]:
    """Return whole JSONL lines from the end of the file."""
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > tail_bytes:
            handle.seek(size - tail_bytes)
            # The first chunk after seeking is almost certainly a partial line.
            handle.readline()
        blob = handle.read()
    return blob.decode("utf-8", errors="replace").splitlines()


def _last_usage(lines: list[str]) -> dict | None:
    for line in reversed(lines):
        line = line.strip()
        if not line or '"usage"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        message = record.get("message")
        if isinstance(message, dict) and isinstance(message.get("usage"), dict):
            return message
    return None


def context_window(provider: str | None, model: str | None, default: int) -> int:
    """Look up the model's context window from pi's on-disk catalog.

    ``models.json`` holds user overrides and wins over ``models-store.json``,
    which is the downloaded provider catalog.
    """
    if not provider or not model:
        return default
    base = Path("~/.pi/agent").expanduser()

    try:
        overrides = json.loads((base / "models.json").read_text(encoding="utf-8"))
        window = (
            overrides.get("providers", {})
            .get(provider, {})
            .get("modelOverrides", {})
            .get(model, {})
            .get("contextWindow")
        )
        if window:
            return int(window)
    except (OSError, ValueError, AttributeError):
        pass

    try:
        store = json.loads((base / "models-store.json").read_text(encoding="utf-8"))
        for entry in store.get(provider, {}).get("models", []):
            if entry.get("id") == model and entry.get("contextWindow"):
                return int(entry["contextWindow"])
    except (OSError, ValueError, AttributeError):
        pass

    return default


def measure(cwd: str | None, settings: dict) -> Usage | None:
    session = latest_session(cwd, settings["pi_session_root"])
    if session is None:
        return None

    try:
        lines = _tail_lines(session, settings["session_tail_bytes"])
    except OSError:
        return None

    message = _last_usage(lines)
    if message is None:
        # A single message can be larger than the tail window; retry in full
        # rather than reporting "no context" for a long-running session.
        try:
            lines = session.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None
        message = _last_usage(lines)
    if message is None:
        return None

    usage = message["usage"]
    used = sum(
        int(usage.get(key) or 0) for key in ("input", "cacheRead", "cacheWrite")
    )
    provider = message.get("provider")
    model = message.get("model")
    window = context_window(provider, model, settings["default_context_window"])
    return Usage(used, window, model, provider, session)
