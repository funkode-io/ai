/**
 * herdr-context-status — shows the current PR number plus a compact 1-glyph
 * context-usage gauge in Herdr's pane `custom_status`, e.g.  #1086 [:] .
 *
 * The gauge is a single band so PR + context both fit on the status line without
 * truncation:  [.] <40%   [:] 40-60%   [!] >60%  (same thresholds as pi.dev).
 *
 * Companion to the herdr-managed `herdr-agent-state.ts` (which reports the
 * agent *state*). This file only sets pane *metadata* via `pane.report_metadata`
 * (a separate channel), so it never fights the managed state reporter and is not
 * overwritten by a Herdr integration update.
 *
 * PR resolution matches the pi.dev treehouse status indicator: a treehouse lease
 * `pr-<N>` wins, else `gh pr view <branch>`. No-op unless inside a Herdr pane.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const SOURCE = "herdr:pi";
const REFRESH_MS = 5000;
const PR_TTL_MS = 60_000;

const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const execFileAsync = promisify(execFile);

function enabled(): boolean {
	return process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
}

// ── Herdr socket ────────────────────────────────────────────────────────────

function sendRequest(request: unknown): void {
	if (!enabled()) return;
	let done = false;
	const socket = createConnection(socketPath!);
	const finish = () => {
		if (done) return;
		done = true;
		socket.destroy();
	};
	socket.on("error", finish);
	socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
	socket.on("data", finish);
	socket.on("end", finish);
	const timer = setTimeout(finish, 800);
	timer.unref?.();
}

let seq = Date.now();

function reportCustomStatus(text: string | undefined): void {
	seq += 1;
	const params: Record<string, unknown> = { pane_id: paneId, source: SOURCE, seq };
	if (text === undefined) params.clear_custom_status = true;
	else params.custom_status = text;
	sendRequest({ id: `${SOURCE}:md:${seq}`, method: "pane.report_metadata", params });
}

// ── PR number (same resolution as the treehouse status extension) ────────────

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** Walk up from `worktree` to a treehouse-state.json and return its lease holder. */
function treehouseHolder(worktree: string): string | null {
	let dir = worktree;
	for (let i = 0; i < 6; i++) {
		try {
			const state = JSON.parse(readFileSync(join(dir, "treehouse-state.json"), "utf8")) as {
				worktrees?: Array<{ name?: string; path?: string; lease_holder?: string }>;
			};
			const match = state.worktrees?.find((w) => w.path === worktree);
			if (match) return match.lease_holder ?? match.name ?? null;
		} catch {
			// keep walking up
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** The ref to look a PR up by: a treehouse `pr-<N>` number, else the branch. */
function prRef(cwd: string): string | null {
	const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) return null;
	const holder = treehouseHolder(toplevel);
	const m = holder ? /^pr-(\d+)$/.exec(holder) : null;
	if (m) return m[1];
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return branch && branch !== "HEAD" ? branch : null;
}

const prCache = new Map<string, { label: string; at: number }>();
const prInflight = new Set<string>();

async function lookupPr(cwd: string, ref: string, onResolved: () => void): Promise<void> {
	const cached = prCache.get(ref);
	if (cached && Date.now() - cached.at < PR_TTL_MS) return;
	if (prInflight.has(ref)) return;
	prInflight.add(ref);
	let label = "";
	try {
		const { stdout } = await execFileAsync("gh", ["pr", "view", ref, "--json", "number,state"], {
			cwd,
			timeout: 8000,
		});
		const pr = JSON.parse(stdout) as { number?: number; state?: string };
		if (pr.number) {
			const mark = pr.state === "MERGED" ? "✓" : pr.state === "CLOSED" ? "✗" : "";
			label = `#${pr.number}${mark}`;
		}
	} catch {
		label = "";
	} finally {
		prInflight.delete(ref);
		const prev = prCache.get(ref)?.label;
		prCache.set(ref, { label, at: Date.now() });
		if (label !== prev) onResolved();
	}
}

// ── Compact context gauge (single glyph band) ───────────────────────────────
//
// Same thresholds as the pi.dev status-bar battery: green <40%, yellow 40-60%,
// red >60% of the context window used.
const WARN_AT = 40; // >= this -> yellow
const CRIT_AT = 60; // >= this -> red

function contextGlyph(usedPercent: number): string {
	if (usedPercent >= CRIT_AT) return "[!]";
	if (usedPercent >= WARN_AT) return "[:]";
	return "[.]";
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (!enabled()) return;

	let rootSession = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastSent: string | undefined;

	function render(ctx: ExtensionContext): void {
		if (!rootSession || !ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		const gauge = contextGlyph(usage && usage.percent != null ? usage.percent : 0);
		const ref = prRef(ctx.cwd);
		const pr = ref ? (prCache.get(ref)?.label ?? "") : "";
		const status = pr ? `${pr} ${gauge}` : gauge;

		if (status !== lastSent) {
			lastSent = status;
			reportCustomStatus(status);
		}
		if (ref) void lookupPr(ctx.cwd, ref, () => render(ctx));
	}

	const onRefresh = async (_event: unknown, ctx: ExtensionContext) => render(ctx);
	pi.on("turn_start", onRefresh);
	pi.on("turn_end", onRefresh);
	pi.on("message_end", onRefresh);
	pi.on("model_select", onRefresh);
	pi.on("session_compact", onRefresh);
	pi.on("context", onRefresh);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI !== true) return; // only the root/interactive session reports
		rootSession = true;
		render(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => render(ctx), REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		lastSent = undefined;
		reportCustomStatus(undefined); // clear_custom_status
	});
}
