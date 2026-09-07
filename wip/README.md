# Work in progress

Not loaded by pi. `package.json` points `pi.extensions` at `../extensions`
only, so nothing here runs until it is fixed and moved.

## `herdr-context-status.ts`

Reports the PR number and a one-glyph context gauge (`#1086 [:]`) into
**Herdr's agents panel** — a different surface from pi's own status line,
which is what `extensions/` handles.

**Broken as of Herdr 0.8.2.** It sends `custom_status` to
`pane.report_metadata`; that field is gone. Herdr replaced it with a generic
`tokens` map, rendered by naming tokens in `[ui.sidebar.agents] rows`.

See the repo README and issue #1 for the migration sketch.
