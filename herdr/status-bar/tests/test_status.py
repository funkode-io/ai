"""Tests for the pure logic behind the status bar segments.

Run with:  python3 -m unittest discover -s herdr/status-bar/tests
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from herdr_status import config, context, herdr, pr, treehouse  # noqa: E402


class SessionDirNameTest(unittest.TestCase):
    def test_mangles_project_path_like_pi(self):
        self.assertEqual(
            context.session_dir_name("/Users/me/git/ai"), "--Users-me-git-ai--"
        )

    def test_keeps_dotted_segments(self):
        self.assertEqual(
            context.session_dir_name("/Users/me/.treehouse/replay-ae0dce/2/replay"),
            "--Users-me-.treehouse-replay-ae0dce-2-replay--",
        )


class UsageTest(unittest.TestCase):
    def test_percent_rounds_against_the_window(self):
        self.assertEqual(context.Usage(250_000, 1_000_000, "m", "p", None).percent, 25)

    def test_percent_is_clamped_and_survives_a_missing_window(self):
        self.assertEqual(context.Usage(20, 10, "m", "p", None).percent, 100)
        self.assertEqual(context.Usage(20, 0, "m", "p", None).percent, 0)

    def test_last_usage_wins_and_ignores_output_tokens(self):
        lines = [
            json.dumps({"message": {"usage": {"input": 1, "cacheRead": 1}}}),
            json.dumps({"message": {"role": "toolResult"}}),
            json.dumps(
                {
                    "message": {
                        "model": "claude-opus-5",
                        "provider": "github-copilot",
                        "usage": {
                            "input": 2,
                            "cacheRead": 56_898,
                            "cacheWrite": 1_654,
                            "output": 233,
                        },
                    }
                }
            ),
        ]
        message = context._last_usage(lines)
        used = sum(
            message["usage"][k] for k in ("input", "cacheRead", "cacheWrite")
        )
        self.assertEqual(used, 58_554)
        self.assertEqual(message["model"], "claude-opus-5")

    def test_last_usage_skips_malformed_lines(self):
        self.assertIsNone(context._last_usage(['{"usage": broken', "", "  "]))


class TailTest(unittest.TestCase):
    def test_partial_first_line_is_dropped(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            handle.write("first-line-that-is-long\nsecond\nthird\n")
            path = Path(handle.name)
        self.addCleanup(path.unlink)
        # A tiny window lands mid-first-line; that line must not be returned.
        self.assertNotIn("first-line-that-is-long", context._tail_lines(path, 16))
        self.assertEqual(context._tail_lines(path, 10_000)[0], "first-line-that-is-long")


class TreehouseTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, True))
        pool = self.root / "replay-ae0dce"
        (pool / "2" / "replay").mkdir(parents=True)
        (pool / "treehouse-state.json").write_text(
            json.dumps(
                {
                    "worktrees": [
                        {
                            "name": "2",
                            "path": str(pool / "2" / "replay"),
                            "leased": True,
                            "lease_holder": "pr-151",
                        }
                    ]
                }
            )
        )
        self.worktree_path = pool / "2" / "replay"

    def test_finds_worktree_and_trims_the_pool_hash(self):
        found = treehouse.find(str(self.worktree_path), str(self.root))
        self.assertIsNotNone(found)
        self.assertEqual(found.label, "replay/2")
        self.assertEqual(found.lease_holder, "pr-151")

    def test_matches_a_subdirectory_of_the_worktree(self):
        nested = self.worktree_path / "src" / "deep"
        nested.mkdir(parents=True)
        found = treehouse.find(str(nested), str(self.root))
        self.assertEqual(found.label, "replay/2")

    def test_unrelated_path_resolves_to_nothing(self):
        self.assertIsNone(treehouse.find("/tmp", str(self.root)))
        self.assertIsNone(treehouse.find(None, str(self.root)))


class PullRequestTest(unittest.TestCase):
    def setUp(self):
        # Keep the PR cache out of the real state directory.
        state = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(state, True))
        previous = os.environ.get("HERDR_PLUGIN_STATE_DIR")
        os.environ["HERDR_PLUGIN_STATE_DIR"] = state
        self.addCleanup(
            lambda: os.environ.__setitem__("HERDR_PLUGIN_STATE_DIR", previous)
            if previous is not None
            else os.environ.pop("HERDR_PLUGIN_STATE_DIR", None)
        )
        self.settings = dict(config.DEFAULTS)
        self.settings["pr_cache_ttl_seconds"] = 0

    def test_lease_label_is_preferred(self):
        worktree = treehouse.Worktree("replay-ae0dce", {"name": "2", "path": "/x", "lease_holder": "pr-151"})
        found = pr.find("/nonexistent", worktree, self.settings)
        self.assertEqual(found.number, 151)
        self.assertEqual(found.source, "treehouse lease")

    def test_non_pr_lease_labels_are_ignored(self):
        worktree = treehouse.Worktree("replay-ae0dce", {"name": "2", "path": "/x", "lease_holder": "alice"})
        self.assertIsNone(pr.find("/nonexistent", worktree, self.settings))

    def test_branch_names_that_embed_a_number(self):
        for branch, expected in [
            ("pr-123", 123),
            ("feature/pr-99/thing", 99),
            ("pull/7", 7),
            ("copilot/pr_4321", 4321),
        ]:
            with self.subTest(branch=branch):
                match = pr.BRANCH_PR.search(branch)
                self.assertIsNotNone(match, branch)
                self.assertEqual(int(match.group(1)), expected)

    def test_branch_names_without_a_pr_number(self):
        for branch in ("main", "feat/prometheus-metrics", "release-2024"):
            with self.subTest(branch=branch):
                self.assertIsNone(pr.BRANCH_PR.search(branch))


class FocusedPaneTest(unittest.TestCase):
    def test_focused_pane_id_wins_over_the_per_pane_flag(self):
        snap = {
            "focused_pane_id": "w2:p3",
            "panes": [
                {"pane_id": "w1:p1", "focused": True, "cwd": "/a"},
                {"pane_id": "w2:p3", "focused": False, "cwd": "/b"},
            ],
        }
        self.assertEqual(herdr.focused_pane(snap)["pane_id"], "w2:p3")

    def test_falls_back_to_the_flag(self):
        snap = {"panes": [{"pane_id": "w1:p1", "focused": True}]}
        self.assertEqual(herdr.focused_pane(snap)["pane_id"], "w1:p1")

    def test_no_focus_at_all(self):
        self.assertIsNone(herdr.focused_pane({"panes": []}))

    def test_foreground_cwd_is_preferred(self):
        pane = {"cwd": "/repo", "foreground_cwd": "/repo/src"}
        self.assertEqual(herdr.pane_cwd(pane), "/repo/src")
        self.assertEqual(herdr.pane_cwd({"cwd": "/repo"}), "/repo")
        self.assertIsNone(herdr.pane_cwd(None))


if __name__ == "__main__":
    unittest.main()
