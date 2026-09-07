import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";

/**
 * Treehouse status: shows in the footer status bar which git worktree/branch
 * the current session is working on, plus the open PR for that branch (if any).
 *
 *   🌳1 pr-973 (PR #973)                 → treehouse slot 1, leased for a PR with an open PR
 *   🌳2 feature/x · feature/x (PR #977)   → treehouse slot 2, holder == branch
 *   🏠 docs/pricing-decisions (PR #977)  → the primary checkout, feature branch + PR
 *   🏠 docs/pricing-decisions            → the primary checkout, no PR yet
 *   🏠 ⚠ main                            → the primary checkout, on the main branch
 *
 * A leased treehouse worktree lives under ~/.treehouse/<repo>/<slot>/<repo> and
 * its holder label (e.g. "pr-973") is recorded in the repo's treehouse-state.json.
 * The PR number comes from `gh pr view <branch>` and is cached per branch.
 */

const STATUS_ID = "treehouse";
const MAIN_BRANCHES = new Set(["main", "master"]);
const REFRESH_MS = 5000;
const PR_TTL_MS = 60_000;

const execFileAsync = promisify(execFile);

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Walk up from `worktree` looking for a treehouse-state.json; return the holder for it. */
function treehouseHolder(worktree: string): string | null {
  let dir = worktree;
  for (let i = 0; i < 6; i++) {
    const stateFile = join(dir, "treehouse-state.json");
    try {
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        worktrees?: Array<{ name?: string; path?: string; lease_holder?: string }>;
      };
      const match = state.worktrees?.find((w) => w.path === worktree);
      if (match) return match.lease_holder ?? match.name ?? null;
    } catch {
      // no state file at this level; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function defaultBranch(cwd: string): string | null {
  const ref = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return ref ? ref.split("/").pop() ?? null : null;
}

/** Sync part: the display pieces, plus the ref(s) to look its PR up by. */
function computeBase(cwd: string): {
  prefix: string;
  holder: string | null;
  branch: string;
  prCandidates: string[];
  prKey: string;
} | null {
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return null; // not a git repo

  let branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  if (branch === "HEAD") {
    const short = git(cwd, ["rev-parse", "--short", "HEAD"]);
    branch = short ? `detached@${short}` : "detached";
  }

  const isTreehouse = toplevel.split(sep).includes(".treehouse");
  const onMain = branch === defaultBranch(cwd) || MAIN_BRANCHES.has(branch);

  // The checked-out branch is the ground truth for "which PR is this?", so try it
  // first. The treehouse lease-holder label ("pr-<N>") is only metadata and can go
  // stale when the worktree is reused for another branch, so it is a fallback.
  const prCandidates: string[] = [];
  if (!branch.startsWith("detached")) prCandidates.push(branch);

  let prefix: string;
  let holder: string | null = null;
  if (isTreehouse) {
    const slot = toplevel.split(sep).slice(-2, -1)[0]; // .../.treehouse/<pool>/<slot>/<repo>
    prefix = `🌳${slot}`; // tree index right next to the icon, e.g. 🌳1
    holder = treehouseHolder(toplevel);
    const m = holder ? /^pr-(\d+)$/.exec(holder) : null;
    if (m && !prCandidates.includes(m[1])) prCandidates.push(m[1]);
  } else {
    prefix = onMain ? "🏠 ⚠" : "🏠";
  }
  return { prefix, holder, branch, prCandidates, prKey: branch };
}

// PR lookup is async and cached per branch: value is "#977", "" (no PR), or undefined (unknown yet).
const prCache = new Map<string, { label: string; at: number }>();
const prInflight = new Set<string>();

async function lookupPr(
  cwd: string,
  cacheKey: string,
  refs: string[],
  onResolved: () => void,
): Promise<void> {
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PR_TTL_MS) return;
  if (prInflight.has(cacheKey)) return;
  prInflight.add(cacheKey);
  let label = "";
  try {
    // Try each candidate in priority order (branch, then holder number); the first
    // that resolves to a PR wins.
    for (const ref of refs) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["pr", "view", ref, "--json", "number,state"],
          { cwd, timeout: 8000 },
        );
        const pr = JSON.parse(stdout) as { number?: number; state?: string };
        if (pr.number) {
          const mark = pr.state === "MERGED" ? "✓" : pr.state === "CLOSED" ? "✗" : "";
          label = `#${pr.number}${mark}`;
          break;
        }
      } catch {
        // this ref has no PR / can't be resolved — try the next candidate
      }
    }
  } finally {
    prInflight.delete(cacheKey);
    const prev = prCache.get(cacheKey)?.label;
    prCache.set(cacheKey, { label, at: Date.now() });
    if (label !== prev) onResolved();
  }
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;

  // Assemble the footer text. `prLabel` is "#1084✓" / "" (none) from the async lookup.
  // A "pr-<N>" lease holder is hidden when it just duplicates the PR we already show,
  // but kept when it differs (surfacing a stale-lease mismatch).
  const formatStatus = (base: NonNullable<ReturnType<typeof computeBase>>, prLabel: string) => {
    const prNum = prLabel ? /#(\d+)/.exec(prLabel)?.[1] : undefined;
    const holderPrNum = base.holder ? /^pr-(\d+)$/.exec(base.holder)?.[1] : undefined;
    const holderDuplicatesPr = holderPrNum !== undefined && holderPrNum === prNum;

    let body: string;
    if (base.holder && !holderDuplicatesPr) {
      body = base.holder === base.branch ? base.holder : `${base.holder} · ${base.branch}`;
    } else {
      body = base.branch;
    }
    // PR goes first, right after the tree index; branch (and any differing holder) follows.
    return prLabel ? `${base.prefix} PR ${prLabel} · ${body}` : `${base.prefix} ${body}`;
  };

  const refresh = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const base = computeBase(ctx.cwd);
    if (!base) {
      ctx.ui.setStatus(STATUS_ID, "");
      return;
    }
    const pr = prCache.get(base.prKey)?.label ?? "";
    ctx.ui.setStatus(STATUS_ID, formatStatus(base, pr));
    // Kick off / refresh the PR lookup in the background; re-render when it resolves.
    void lookupPr(ctx.cwd, base.prKey, base.prCandidates, () => refresh(ctx));
  };

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => refresh(ctx), REFRESH_MS);
    if (typeof timer.unref === "function") timer.unref();
  });

  // Cheap immediate updates around activity, in case the branch changed
  // (e.g. a `git checkout` run via `!` or by the agent).
  pi.on("turn_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // Manual refresh / show. (Not `/tree` — that is pi's built-in tree navigation.)
  pi.registerCommand("treehouse", {
    description: "Refresh the treehouse/branch/PR status indicator",
    handler: async (_args, ctx) => {
      const base = computeBase(ctx.cwd);
      if (base) prCache.delete(base.prKey); // force a fresh gh lookup
      refresh(ctx);
      ctx.ui.notify(
        base ? `Worktree: ${formatStatus(base, prCache.get(base.prKey)?.label ?? "")}` : "Not a git repository",
        "info",
      );
    },
  });
}
