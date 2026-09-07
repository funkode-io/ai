/**
 * context-battery — a horizontal gauge in the status bar that fills up and
 * recolors as the context window is used.
 *
 * The bar fills with *usage* (and the text shows the same usage %):
 *   - plenty of room  -> green,  near-empty  [▰▱▱▱▱]
 *   - filling up      -> yellow, half        [▰▰▰▱▱]
 *   - almost full     -> red,    full        [▰▰▰▰▰]
 *
 * Uses ctx.getContextUsage() (tokens / contextWindow / percent) and paints the
 * gauge with ctx.ui.theme.fg(...) so it follows the active theme.
 *
 * Install: drop this file in ~/.pi/agent/extensions/ (global) or
 * .pi/extensions/ (project-local), then /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-battery";
const SEGMENTS = 5;

// Thresholds on *used* percentage of the context window.
const WARN_AT = 40; // >= this -> yellow
const CRIT_AT = 60; // >= this -> red

type Role = "success" | "warning" | "error" | "dim";

function colorForUsed(usedPercent: number): Role {
	if (usedPercent >= CRIT_AT) return "error";
	if (usedPercent >= WARN_AT) return "warning";
	return "success";
}

/** Draw a 5-cell gauge whose filled cells represent context *used*, one cell
 * per 100/SEGMENTS percent (20% each for 5 cells). Uses nearest-cell rounding
 * so the gauge reads with more impact: a cell lights up once usage passes its
 * midpoint (e.g. 50% and 59% both show 3/5, matching the "half" example above). */
function batteryGauge(usedPercent: number): string {
	const used = Math.max(0, Math.min(100, usedPercent));
	const perCell = 100 / SEGMENTS;
	const filled = Math.min(SEGMENTS, Math.round(used / perCell));
	const full = "▰".repeat(filled);
	const empty = "▱".repeat(SEGMENTS - filled);
	return `[${full}${empty}]`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export default function (pi: ExtensionAPI) {
	// Toggle the token count next to the gauge (off by default to stay compact).
	let showTokens = false;

	function render(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const usage = ctx.getContextUsage();
		// No data yet (fresh session, right after compaction, etc.) -> clear.
		if (!usage || usage.tokens == null || usage.percent == null) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "[▱▱▱▱▱] 0%"));
			return;
		}

		const used = usage.percent; // 0..100 of the context window
		const role = colorForUsed(used);
		const gauge = batteryGauge(used);

		let label = `${gauge} ${Math.round(used)}%`;
		if (showTokens) {
			label += ` ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`;
		}

		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(role, label));
	}

	// Refresh whenever the amount of context could have changed. Registered
	// per-event (not in a loop) so each resolves to its typed `pi.on` overload.
	const onRefresh = async (_event: unknown, ctx: ExtensionContext) => render(ctx);
	pi.on("session_start", onRefresh);
	pi.on("model_select", onRefresh);
	pi.on("turn_end", onRefresh);
	pi.on("message_end", onRefresh);
	pi.on("session_compact", onRefresh);
	pi.on("context", onRefresh);

	// /battery — toggle the token count on the gauge.
	pi.registerCommand("battery", {
		description: "Toggle token count on the context battery gauge",
		handler: async (_args, ctx) => {
			showTokens = !showTokens;
			render(ctx);
			ctx.ui.notify(`Context battery: token count ${showTokens ? "on" : "off"}`, "info");
		},
	});

	// Clear the status item on shutdown so it doesn't linger.
	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
