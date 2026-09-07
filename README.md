# funkode / ai

pi extensions for my agent setup. They add a status line to every pi session:

```
[▰▱▱▱▱] 11% 🏠 ⚠ main
└─ context battery   └─ treehouse / branch / PR
```

## Install

```bash
pi install git:github.com/funkode-io/ai
```

That records the source in `~/.pi/agent/settings.json` and clones the repo to
`~/.pi/agent/git/github.com/funkode-io/ai`. Restart pi (or `/reload`) and the
status line appears.

> If you previously copied these files into `~/.pi/agent/extensions/`, delete
> them after installing. pi would otherwise load each extension twice.

Update later with:

```bash
pi update --extensions
```

## Extensions

### `context-battery` — `[▰▱▱▱▱] 11%`

A five-cell gauge that fills and recolors as the context window is consumed.
Green below 40%, yellow from 40%, red from 60%, following the active theme via
`ctx.ui.theme.fg(...)`. Cells use nearest-cell rounding, so a cell lights up
once usage passes its midpoint and the gauge reads with more impact.

`/battery` toggles a token count next to the gauge (`24.1k/1.0M`), off by
default to stay compact.

### `treehouse-status` — `🏠 ⚠ main`

Which worktree, branch, and PR the session is on:

| Display | Meaning |
| --- | --- |
| `🏠 ⚠ main` | Primary checkout, sitting on the default branch |
| `🏠 docs/pricing` | Primary checkout, feature branch |
| `🏠 PR #977 · docs/pricing` | …with an open PR |
| `🌳2 PR #977 · feature/x` | treehouse slot 2 |
| `🌳1 pr-973 · feature/x` | lease label kept because it disagrees with the branch |

The `⚠` is a nudge that you are about to work directly on `main`.

PR numbers come from `gh pr view`, resolved in the background and cached per
branch for 60s so the status line never blocks. The checked-out branch is
tried first and the treehouse lease label (`pr-<N>`) second — a lease can go
stale when a worktree is reused, and when the two disagree both are shown.
Merged and closed PRs are marked `✓` and `✗`.

`/treehouse` clears the cache and forces a fresh lookup.

## Repo layout

| Path | |
| --- | --- |
| `extensions/` | Loaded by pi (declared in `package.json` under `pi.extensions`) |
| `wip/` | Not loaded. Work in progress — see below |

## Work in progress

`wip/herdr-context-status.ts` reported the PR number and a compact context
gauge (`#1086 [:]`) into **Herdr's agents panel**, rather than pi's own status
line. It is currently broken.

Cause: it calls `pane.report_metadata` with a `custom_status` field, and that
field no longer exists in Herdr 0.8.2 — the string `custom_status` is absent
from the binary entirely. It was replaced by a generic `tokens` map:

```jsonc
// then
{ "method": "pane.report_metadata", "params": { "custom_status": "#1086 [:]" } }

// now
{ "method": "pane.report_metadata", "params": { "tokens": { "pr": "#1086", "ctx": "[:]" } } }
```

Tokens are rendered by naming them in the sidebar row config:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "$pr", "$ctx"]]
```

Tracked in [#1](https://github.com/funkode-io/ai/issues/1). The file is kept
out of `extensions/` so pi does not load a known-broken extension.

## Notes

- Requires the `gh` CLI on `PATH` for PR numbers; without it the status line
  still renders, just without the `PR #N` part.
- `~/.pi/agent/extensions/herdr-agent-state.ts` is deliberately **not** in this
  repo. It is installed and overwritten by `herdr integration install pi`.
