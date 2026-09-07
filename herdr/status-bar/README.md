# Herdr status bar

Adds three segments to the right edge of Herdr's tab bar, all describing the
pane you are currently looking at:

```
th:replay/2  ctx 26%  #151
└─ treehouse  └─ context  └─ pull request
```

| Segment | Shows | Resolved from |
| --- | --- | --- |
| `treehouse` | The treehouse pool and worktree that owns the focused pane's cwd. | `~/.treehouse/<pool>/treehouse-state.json` |
| `context` | How full the agent's context window is. | The agent's pi session log plus pi's model catalog |
| `pr` | The pull request the session is on. | The treehouse lease label, the branch name, or a `gh` cache |

## Install

```bash
herdr plugin install funkode-io/ai/herdr/status-bar
herdr plugin action invoke print-config --plugin funkode.status-bar
```

Paste the printed snippet into `~/.config/herdr/config.toml`, then:

```bash
herdr server reload-config
```

The snippet is just a `ui.tab_bar_right` command entry:

```toml
[ui]
tab_bar_right_separator = "  "

[[ui.tab_bar_right]]
type = "command"
command = "/path/to/herdr/status-bar/bin/herdr-status"
interval_seconds = 5
timeout_seconds = 4
```

## Why one plugin and not three

Herdr has no status-bar contribution point for plugins; the bar is configured
through `ui.tab_bar_right`, and a `command` entry is just a shell command the
server runs on a timer. So "a status bar plugin" is really a script the bar
calls, plus a manifest that gives it a home, actions, and event hooks.

That makes the split a cost question, and the answer is one plugin:

- Every segment first has to answer "which pane is focused?". That is one
  `herdr api snapshot` call. Three plugins means three snapshot calls per tick
  for the same answer.
- `treehouse` and `pr` share more than the pane: the treehouse lease label
  (`pr-<N>`) is the best PR signal there is. Splitting them would mean parsing
  the same state file twice, or one plugin depending on the other.
- Herdr installs plugins per `owner/repo/subdir`, so three plugins means three
  installs, three versions, and three `min_herdr_version` bumps to keep in sync.

Composability is kept where it actually matters — in the bar, not the package.
Each segment renders independently:

```bash
herdr-status                 # treehouse, context, pr
herdr-status context pr      # only these two
herdr-status treehouse
```

So you can still use one `tab_bar_right` entry per segment with its own
`interval_seconds` (the PR number changes far less often than context usage).
That costs one snapshot call per entry, which is the tradeoff the combined
entry avoids. The `print-config` action prints both layouts.

## How each segment works

### treehouse

Reads every `~/.treehouse/*/treehouse-state.json` and finds the worktree whose
`path` contains the focused pane's cwd. Matching is by containment and the
longest match wins, so a pane that has `cd`'d into a subdirectory still
resolves. The pool's random suffix is trimmed for display:
`replay-ae0dce/2` renders as `replay/2`.

### context

Herdr does not measure context; it only carries tokens an agent reports. pi
writes a JSONL session log where each assistant message records its usage, so
the last such message tells us how full the window was on the last turn:

```
used = usage.input + usage.cacheRead + usage.cacheWrite
```

`usage.output` is deliberately excluded — it is the reply, not part of the next
request's prompt.

The session is found by pi's directory mangling (`/Users/me/git/ai` →
`--Users-me-git-ai--`), picking the most recently written `.jsonl`. When two
panes share a working directory this follows whichever produced output last.

The window size comes from pi's own catalog: `~/.pi/agent/models.json`
(user overrides) then `~/.pi/agent/models-store.json`, falling back to
`default_context_window`.

Only the tail of the session file is read, so cost does not grow with session
length; the full file is only parsed if the tail contained no usage record.

### pr

Tried in order of cost and confidence, all local — the status bar's hot path
never touches the network:

1. **treehouse lease.** A lease labelled `pr-<N>` names the PR the session is
   on. This is the most accurate source.
2. **branch name**, when it embeds a number (`pr-123`, `pull/123`). Read
   straight out of `.git/HEAD`, no subprocess, and it follows linked worktrees
   through their `gitdir:` pointer.
3. **`gh` cache**, populated by the `refresh-pr` action and by `pane.focused` /
   `workspace.focused` event hooks. Misses are cached too, so focus changes do
   not re-query `gh` in a loop.

## Actions

```bash
herdr plugin action invoke doctor        --plugin funkode.status-bar
herdr plugin action invoke print-config  --plugin funkode.status-bar
herdr plugin action invoke refresh-pr    --plugin funkode.status-bar

herdr plugin log list --plugin funkode.status-bar --limit 1   # read the output
```

`doctor` explains what every segment resolved to and why:

```
focused pane : w2:p3
agent        : pi (idle)
cwd          : /Users/me/.treehouse/replay-ae0dce/2/replay

treehouse    : replay/2
  pool       : replay-ae0dce
  lease      : pr-151

context      : 26% (256,641 / 1,000,000)
  model      : github-copilot/claude-opus-5

pr           : #151 (via treehouse lease)
```

## Configuration

Optional JSON, read from the first of:

1. `$HERDR_STATUS_CONFIG`
2. `$HERDR_PLUGIN_CONFIG_DIR/config.json` (see `herdr plugin config-dir funkode.status-bar`)
3. `~/.config/herdr/plugins/funkode.status-bar/config.json`
4. `~/.config/herdr/herdr-status.json`

```json
{
  "segments": ["treehouse", "context", "pr"],
  "separator": "  ",
  "treehouse_prefix": "th:",
  "context_prefix": "ctx",
  "pr_prefix": "#",
  "placeholder": "",
  "default_context_window": 200000,
  "pr_gh_enabled": true,
  "pr_cache_ttl_seconds": 900
}
```

Prefixes are plain ASCII by default so the bar stays readable in any font;
swap in Nerd Font glyphs if you have them. `placeholder` is what a segment
renders when it has no value — empty hides it.

## Notes

- Python 3.9+, standard library only. The bar runs the script on the Herdr
  server, whose `PATH` may resolve an older `python3` than your shell does.
- A failed or slow segment never breaks the bar: the script prints an empty
  line and exits 0, keeping the error on stderr.
- Requires Herdr 0.8.2 or newer.
