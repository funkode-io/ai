# funkode / ai

pi extensions and agent skills for my agent setup. The extensions add a status
line to every pi session:

```
[▰▱▱▱▱] 11% 🏠 ⚠ main
└─ context battery   └─ treehouse / branch / PR
```

The [`ui-feedback`](#ui-feedback--comment-on-a-running-app) skill lets you comment
on a running web app from your browser while the agent fixes and replies. It
installs into both pi and Claude Code.

## Install

### pi

```bash
pi install git:github.com/funkode-io/ai
```

That records the source in `~/.pi/agent/settings.json` and clones the repo to
`~/.pi/agent/git/github.com/funkode-io/ai`. Restart pi (or `/reload`) and the
status line appears, and the `ui-feedback` skill is available (`/skill:ui-feedback`).

> If you previously copied these files into `~/.pi/agent/extensions/`, delete
> them after installing. pi would otherwise load each extension twice.

Update later with:

```bash
pi update --extensions
```

### Claude Code

The repo is also a Claude Code plugin marketplace with one plugin, `funkode`,
which carries the same skills (the extensions are pi-only). Inside Claude Code:

```text
/plugin marketplace add funkode-io/ai
/plugin install funkode@funkode-ai
```

Or from a shell: `claude plugin marketplace add funkode-io/ai` then
`claude plugin install funkode@funkode-ai`. Add `--scope project` to install
it for one repository only. The skill is then `/funkode:ui-feedback`.

The plugin sets no `version`, so Claude Code tracks the repo's commits:
`/plugin marketplace update funkode-ai` (or auto-update) picks up new commits.

## Skills

### `ui-feedback` — comment on a running app

Live UI feedback without changing the app. The agent starts a tiny receiver on
`127.0.0.1` (Node only, zero dependencies); you drag a **💬 Feedback**
bookmarklet from its setup page once. On the running app, click the bookmark,
then:

- **Pick element** (`Alt+Shift+C`) and comment on it, or write a **Page
  comment**; `Ctrl/⌘+Enter` queues it.
- **Send** delivers the queue to the agent; send as often as you like.
- **Done** sends what is left and ends the round.
- **💬** shows the agent's replies, which arrive while you keep reviewing.

Queued notes survive a page reload (`sessionStorage`); click the bookmark again
to bring the bar back. The agent long-polls the notes as JSON — selector, text,
HTML snippet and position of the element, plus URL and viewport — applies the
fixes and answers in the page.

Typical flow: once a UI PR is reviewed and green, ask the agent for a local run
("let me give UI feedback"). It starts the app and the receiver and gives you
two URLs; you comment, it fixes and replies, you press Done, it stops the
receiver.

Details:

- **Port**: fixed at `4848` so the bookmark is a one-time install. Two
  sessions at once need different ports (`--port` / `UFB_PORT`), and each port
  has its own bookmark.
- **Security**: the receiver binds to loopback only, refuses foreign `Host`
  names, and requires a random token that only the bookmark carries, so other
  web pages cannot inject notes. The token lives in `~/.local/state/ufb/`
  (`UFB_HOME` overrides) and stays stable across restarts.
- **Browsers**: Chromium browsers — Chrome, Brave, Edge (tested in Chromium).
  In Brave, if the bar does not appear, turn Shields off for the app's
  `localhost` site. Apps whose Content-Security-Policy forbids external scripts
  block any bookmarklet.
- **No icon on the bookmark**: Chrome and Brave never show a favicon for
  `javascript:` bookmarks, so the name **💬 Feedback** is the icon. Keep the
  emoji when renaming it.
- **Remote browser**: the receiver and the app must be reachable on the
  browser's `localhost`. Lima/Colima forward loopback ports automatically;
  over SSH, forward both ports (`ssh -L 4848:127.0.0.1:4848 …`).

Run the receiver by hand with
`node skills/ui-feedback/scripts/ufb.mjs --help`. Tests: `node --test 'tests/*.test.mjs'`.

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

## Scope

This repo holds **tool-specific code** — things only pi, Claude Code or herdr
can load — and skills that ship as an installable package for those agents.
Other agent-agnostic skills live in a separate repo:

| | |
| --- | --- |
| pi extensions, herdr plugins | this repo |
| Skills packaged for pi + Claude Code (`ui-feedback`) | this repo |
| Skills (agent-agnostic) | [funkode-io/skills](https://github.com/funkode-io/skills) |

The split is by consumer, not by tool. A plugin that extends herdr belongs
here; a skill that teaches an agent to *drive* herdr belongs in the skills repo,
where the Skills CLI can install it into every agent at once.

## Repo layout

This repo deliberately hosts several different things, installed by three
different tools. The layout keeps them from colliding.

| Path | Installed by | Loaded because |
| --- | --- | --- |
| `extensions/` | pi | Convention directory |
| `skills/` | pi, Claude Code | pi convention directory; default skills directory of the root plugin |
| `.claude-plugin/` | Claude Code | `marketplace.json` lists the repo root as plugin `funkode` (`plugin.json`) |
| `prompts/`, `themes/` | pi | Convention directories (when they exist) |
| `herdr/<plugin>/` | herdr | `herdr-plugin.toml` in that subdir |
| `tests/`, `wip/` | nobody | Not a convention directory |

One skill directory serves both agents, so there is no duplicated code. Skill
scripts must therefore find their files relative to themselves, not to a
per-agent path. Claude Code installs a copy of the whole repo as the plugin;
it ignores the pi extensions.

### Why there is no `pi` key in `package.json`

pi discovers resources one of two ways, and they are **mutually exclusive**
(`dist/core/package-manager.js`):

```js
const manifest = readPiManifest(join(packageRoot, "package.json"));
if (manifest) {
    for (const resourceType of RESOURCE_TYPES) { /* extensions, skills, prompts, themes */
        const entries = manifest[resourceType];   // undefined for omitted keys
        this.addManifestEntries(entries, ...);
    }
    return true;                                  // convention dirs never reached
}
// only here does it fall back to extensions/ skills/ prompts/ themes/
```

So the moment a `pi` manifest exists, **any resource type omitted from it loads
nothing** — silently. A `pi.extensions`-only manifest would mean that adding
`skills/` later does nothing at all, with no error to explain why.

With no manifest, all four convention directories are picked up automatically,
and `herdr/`, `tests/` and `wip/` are ignored because they are not convention names. That
is the right default for a repo meant to grow.

If you ever do need a manifest (to exclude a specific file, say), declare
**every** resource type the repo uses, not just the one you are filtering.

### Adding a herdr plugin later

Put it in its own subdir with a `herdr-plugin.toml` and install the subdir:

```bash
herdr plugin install funkode-io/ai/herdr/<plugin> [--ref REF]
```

Verified behaviour (herdr 0.8.2):

- The plugin `id` in the manifest is **independent** of the subdir path — an id
  of `funkode.probe` at `herdr/probe` installs fine.
- herdr clones the **whole repo** to
  `~/.config/herdr/plugins/github/<plugin_id>-<hash>/` and points `plugin_root`
  at the subdir. The pi extensions come along for the ride; harmless, but note
  that N herdr plugins means N full clones of this repo.
- pi clones separately to `~/.pi/agent/git/github.com/funkode-io/ai`. The two
  tools never share a directory, so there is no collision — but they pin refs
  **independently**. If a herdr plugin and a pi extension ever have to agree on
  a protocol, they can drift out of sync. Pin both to the same tag when that
  matters.
- herdr does **not** run `npm install`. A herdr plugin needing dependencies must
  declare a `build` command in its manifest.

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
in `wip/` — not a pi convention directory — so pi does not load a known-broken
extension.

## Notes

- Requires the `gh` CLI on `PATH` for PR numbers; without it the status line
  still renders, just without the `PR #N` part.
- `~/.pi/agent/extensions/herdr-agent-state.ts` is deliberately **not** in this
  repo. It is installed and overwritten by `herdr integration install pi`.
