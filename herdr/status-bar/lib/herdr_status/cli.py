"""Command line entry point for the Herdr status bar segments."""

from __future__ import annotations

import argparse
import sys

from . import config, context, herdr, pr, treehouse

SEGMENTS = ("treehouse", "context", "pr")

CONFIG_SNIPPET = """\
# Funkode status bar -- add to ~/.config/herdr/config.toml, then run
# `herdr server reload-config`.
[ui]
tab_bar_right_separator = "  "

# One entry, one snapshot call per tick. This is the recommended layout.
[[ui.tab_bar_right]]
type = "command"
command = "{command}"
interval_seconds = 5
timeout_seconds = 4

# Prefer independent refresh rates? Replace the entry above with these three.
# Each one costs its own `herdr api snapshot`, so keep the intervals modest.
#
# [[ui.tab_bar_right]]
# type = "command"
# command = "{command} treehouse"
# interval_seconds = 10
# timeout_seconds = 4
#
# [[ui.tab_bar_right]]
# type = "command"
# command = "{command} context"
# interval_seconds = 5
# timeout_seconds = 4
#
# [[ui.tab_bar_right]]
# type = "command"
# command = "{command} pr"
# interval_seconds = 30
# timeout_seconds = 4
"""


class Resolved:
    """Everything the segments need, derived from one snapshot."""

    def __init__(self, settings: dict):
        self.settings = settings
        self.pane = None
        self.cwd = None
        self.error = None
        try:
            snap = herdr.snapshot()
        except herdr.HerdrError as exc:
            self.error = str(exc)
            return
        self.pane = herdr.focused_pane(snap)
        self.cwd = herdr.pane_cwd(self.pane)

    @property
    def worktree(self):
        if not hasattr(self, "_worktree"):
            self._worktree = treehouse.find(self.cwd, self.settings["treehouse_root"])
        return self._worktree

    @property
    def usage(self):
        if not hasattr(self, "_usage"):
            self._usage = context.measure(self.cwd, self.settings)
        return self._usage

    @property
    def pull_request(self):
        if not hasattr(self, "_pr"):
            self._pr = pr.find(self.cwd, self.worktree, self.settings)
        return self._pr


def render_treehouse(state: Resolved) -> str | None:
    worktree = state.worktree
    if worktree is None:
        return None
    return f"{state.settings['treehouse_prefix']}{worktree.label}"


def render_context(state: Resolved) -> str | None:
    usage = state.usage
    if usage is None:
        return None
    return f"{state.settings['context_prefix']} {usage.percent}%"


def render_pr(state: Resolved) -> str | None:
    pull_request = state.pull_request
    if pull_request is None:
        return None
    return f"{state.settings['pr_prefix']}{pull_request.number}"


RENDERERS = {
    "treehouse": render_treehouse,
    "context": render_context,
    "pr": render_pr,
}


def cmd_status(args, settings) -> int:
    names = args.segments or settings["segments"]
    unknown = [n for n in names if n not in RENDERERS]
    if unknown:
        print(f"unknown segment(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    state = Resolved(settings)
    if state.error:
        # A status bar must never print a stack trace into the tab bar.
        print("", end="")
        print(state.error, file=sys.stderr)
        return 0

    parts = []
    for name in names:
        value = RENDERERS[name](state)
        if value is None:
            value = settings["placeholder"]
        if value:
            parts.append(value)
    print(settings["separator"].join(parts))
    return 0


def cmd_doctor(args, settings) -> int:
    state = Resolved(settings)
    if state.error:
        print(f"herdr: ERROR {state.error}")
        return 1

    pane = state.pane or {}
    print(f"focused pane : {pane.get('pane_id') or '(none)'}")
    print(f"agent        : {pane.get('agent') or '(none)'} ({pane.get('agent_status')})")
    print(f"cwd          : {state.cwd or '(none)'}")
    print()

    worktree = state.worktree
    if worktree:
        print(f"treehouse    : {worktree.label}")
        print(f"  pool       : {worktree.pool}")
        print(f"  path       : {worktree.path}")
        print(f"  lease      : {worktree.lease_holder or '(unleased)'}")
    else:
        print(f"treehouse    : (not a treehouse worktree, root={settings['treehouse_root']})")
    print()

    usage = state.usage
    if usage:
        print(f"context      : {usage.percent}% ({usage.used:,} / {usage.window:,})")
        print(f"  model      : {usage.provider}/{usage.model}")
        print(f"  session    : {usage.session_path}")
    else:
        print("context      : (no pi session found for this cwd)")
    print()

    pull_request = state.pull_request
    if pull_request:
        print(f"pr           : #{pull_request.number} (via {pull_request.source})")
    else:
        print(f"pr           : (unknown, branch={pr.branch(state.cwd) or '?'})")
    print()
    print("rendered     :", end=" ")
    return cmd_status(argparse.Namespace(segments=None), settings)


def cmd_refresh_pr(args, settings) -> int:
    state = Resolved(settings)
    if state.error:
        if not args.quiet:
            print(state.error, file=sys.stderr)
        return 1
    found = pr.refresh(state.cwd, settings)
    if not args.quiet:
        print(f"#{found.number}" if found else "no pull request for this branch")
    return 0


def cmd_print_config(args, settings) -> int:
    from pathlib import Path

    script = Path(__file__).resolve().parents[2] / "bin" / "herdr-status"
    # tab_bar_right command entries are shell strings, so quote the path.
    print(CONFIG_SNIPPET.format(command=f"'{script}'"))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="herdr-status",
        description="Herdr tab-bar segments: treehouse worktree, agent context, PR number.",
    )
    sub = parser.add_subparsers(dest="command")

    status = sub.add_parser("status", help="print the status line (default)")
    # No argparse `choices` here: on Python 3.9 `nargs="*"` plus `choices`
    # rejects the empty list. Segments are validated in cmd_status instead.
    status.add_argument(
        "segments",
        nargs="*",
        metavar="SEGMENT",
        help=f"segments to render ({', '.join(SEGMENTS)})",
    )
    status.set_defaults(func=cmd_status)

    doctor = sub.add_parser("doctor", help="explain what every segment resolves to")
    doctor.set_defaults(func=cmd_doctor)

    refresh = sub.add_parser("refresh-pr", help="populate the PR cache using gh")
    refresh.add_argument("--quiet", action="store_true")
    refresh.set_defaults(func=cmd_refresh_pr)

    printer = sub.add_parser("print-config", help="print the ui.tab_bar_right snippet")
    printer.set_defaults(func=cmd_print_config)

    argv = list(sys.argv[1:] if argv is None else argv)
    # Allow the bare `herdr-status` and `herdr-status treehouse pr` forms.
    if not argv or argv[0] in SEGMENTS:
        argv = ["status", *argv]

    args = parser.parse_args(argv)
    return args.func(args, config.load())
