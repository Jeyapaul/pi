/**
 * Status Line Extension — 3-line custom footer.
 *
 * Line 1: folder · project · repo · branch · model (effort)
 * Line 2: context-fill progress bar (color-coded) · cost · session/api time · +lines/-lines
 * Line 3: tokens in/cache-r/cache-w/out · cache expiry countdown from last request
 *
 * Toggle with /statusline.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000; // Anthropic default 5m cache retention
const LONG_CACHE_TTL_MS = 60 * 60_000; // 1h retention

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let ctxRef: ExtensionContext | null = null;

	// Git / project identity (computed once per session)
	let folder = "";
	let project = "";
	let repo = "";

	// Session stats
	let sessionStart = Date.now();
	let apiTimeMs = 0;
	let streamingSince = 0;
	let linesAdded = 0;
	let linesRemoved = 0;
	// LLM request counters (per HTTP response; retries count individually)
	let reqTotal = 0;
	let reqOk = 0;
	let reqFail = 0;
	let reqErrCounted = false;
	// Rate-limit wait parsed from the error body ("try again in 8.4s" etc.)
	let rateLimitedUntil = 0;

	// Last request info (for token breakdown + cache countdown)
	let lastRequestAt = 0;
	let lastUsage: Usage | null = null;
	let cacheTtlMs = DEFAULT_CACHE_TTL_MS;

	function detectProjectInfo(cwd: string) {
		folder = basename(cwd) || cwd;

		// Project name: nearest package.json "name", walking up from cwd
		project = folder;
		try {
			let dir = cwd;
			for (let i = 0; i < 6; i++) {
				const pkgPath = join(dir, "package.json");
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					if (pkg?.name) {
						project = pkg.name;
						break;
					}
				} catch {
					/* keep walking up */
				}
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			/* ignore */
		}

		// Repo name: git remote origin (owner/name), falling back to git root folder
		repo = "";
		try {
			const url = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (url) {
				const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
				repo = cleaned.split(/[\/:]/).slice(-2).join("/");
			}
		} catch {
			/* no remote */
		}
		if (!repo) {
			try {
				const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
				if (root) repo = basename(root);
			} catch {
				/* not a git repo */
			}
		}
	}

	// --- Formatting helpers ---

	const fmtPrice = (n: number) => {
		if (!Number.isFinite(n)) return "?";
		if (n === 0) return "0";
		if (n >= 100) return `${Math.round(n)}`;
		if (n >= 1) return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
		return n.toFixed(2);
	};

	const fmtTokens = (n: number) =>
		n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;

	const fmtDur = (ms: number) => {
		const s = Math.floor(ms / 1000);
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		return h > 0
			? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
			: `${m}:${String(sec).padStart(2, "0")}`;
	};

	const padBetween = (left: string, right: string, width: number) => {
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return left + " ".repeat(gap) + right;
	};

	// --- Footer ---

	function makeFooter(tui: any, theme: Theme, footerData: any) {
		const iv = setInterval(() => tui.requestRender(), 1000); // keep timers/countdowns live
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose() {
				clearInterval(iv);
				unsub();
			},
			invalidate() {},
			render(width: number): string[] {
				const ctx = ctxRef;
				if (!ctx) return [];

				// ----- Line 1: identity -----
				const branch = footerData.getGitBranch();
				const model = ctx.model;
				const effort = ctx.thinkingLevel;
				const modelStr = model ? `${model.id}${effort ? ` (${effort})` : ""}` : "no model";

				const modelCost = ctx.model?.cost;
				const l1 = [
					theme.fg("text", folder),
					repo && repo !== folder ? theme.fg("muted", repo) : null,
					project !== folder ? theme.fg("dim", project) : null,
					branch ? theme.fg("accent", branch) : null,
					theme.fg("accent", modelStr),
					modelCost
						? theme.fg("dim", `$${fmtPrice(modelCost.input)}/$${fmtPrice(modelCost.output)} per M`)
						: null,
				].filter(Boolean) as string[];
				const line1 = truncateToWidth(l1.join(theme.fg("dim", " · ")), width);

				// ----- Line 2: context bar + cost + times + diff -----
				const usage = ctx.getContextUsage();
				const pct = usage?.percent ?? null;
				const barWidth = 15;
				let barStr: string;
				let pctStr: string;
				if (pct == null) {
					barStr = theme.fg("dim", "░".repeat(barWidth));
					pctStr = theme.fg("dim", "--%");
				} else {
					const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
					const color = pct < 50 ? "success" : pct < 80 ? "warning" : "error";
					barStr = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
					pctStr = theme.fg(color, `${Math.round(pct)}%`);
				}

				// Session cost + token totals
				let cost = 0;
				let sessionIn = 0;
				let sessionOut = 0;
				for (const e of ctx.sessionManager.getBranch()) {
					if (e.type === "message" && (e.message as AssistantMessage).role === "assistant") {
						const u = (e.message as AssistantMessage).usage;
						cost += u?.cost?.total ?? 0;
						if (u) {
							sessionIn += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
							sessionOut += u.output ?? 0;
						}
					}
				}

				const now = Date.now();
				let left2 =
					`${barStr} ${pctStr}` +
					theme.fg("dim", " · ") +
					theme.fg("text", `$${cost.toFixed(2)}`) +
					theme.fg("muted", ` ↑${fmtTokens(sessionIn)} ↓${fmtTokens(sessionOut)}`) +
					theme.fg("dim", ` · sess ${fmtDur(now - sessionStart)} · api ${fmtDur(apiTimeMs)}`) +
					theme.fg("dim", " · ") +
					theme.fg("toolDiffAdded", `+${linesAdded}`) +
					theme.fg("dim", "/") +
					theme.fg("toolDiffRemoved", `-${linesRemoved}`);
				if (reqTotal > 0) {
					left2 +=
						theme.fg("dim", " · req ") +
						theme.fg("text", `${reqTotal}`) +
						theme.fg("success", ` ✓${reqOk}`) +
						(reqFail > 0 ? theme.fg("error", ` ✗${reqFail}`) : theme.fg("dim", " ✗0"));
				}
				const line2 = truncateToWidth(left2, width);

				// ----- Line 3: token breakdown + cache countdown -----
				let line3: string;
				if (lastUsage) {
					const u = lastUsage;
					const tokens =
						theme.fg("dim", "tok ") +
						theme.fg("text", `${fmtTokens(u.input)}${u.reasoning ? `(+${fmtTokens(u.reasoning)} think)` : ""}`) +
						theme.fg("dim", "/") +
						theme.fg("muted", `r ${fmtTokens(u.cacheRead)}`) +
						theme.fg("dim", "/") +
						theme.fg("muted", `w ${fmtTokens(u.cacheWrite)}`) +
						theme.fg("dim", "/") +
						theme.fg("text", `out ${fmtTokens(u.output)}`);

					let rightStr: string;
					const rlRemaining = rateLimitedUntil - now;
					if (rlRemaining > 0) {
						// Provider-stated rate-limit wait: prominent countdown
						rightStr =
							theme.fg("error", "rate-limited · retry in ") +
							theme.fg("warning", fmtDur(rlRemaining));
					} else if (!lastRequestAt) {
						rightStr = theme.fg("dim", "cache: cold");
					} else {
						const remaining = cacheTtlMs - (now - lastRequestAt);
						rightStr =
							remaining > 0
								? theme.fg("dim", `cache expires in `) + theme.fg("warning", fmtDur(remaining))
								: theme.fg("dim", "cache: ") + theme.fg("error", "expired");
					}
					line3 = truncateToWidth(padBetween(tokens, rightStr, width), width);
				} else {
					line3 = truncateToWidth(theme.fg("dim", "tok — no requests yet"), width);
				}

				return [line1, line2, line3];
			},
		};
	}

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		sessionStart = Date.now();
		apiTimeMs = 0;
		linesAdded = 0;
		linesRemoved = 0;
		reqTotal = 0;
		reqOk = 0;
		reqFail = 0;
		rateLimitedUntil = 0;
		reqErrCounted = false;
		lastRequestAt = 0;
		lastUsage = null;
		cacheTtlMs = DEFAULT_CACHE_TTL_MS;
		detectProjectInfo(ctx.cwd);

		if (enabled && ctx.mode === "tui") {
			ctx.ui.setFooter((tui, theme, footerData) => makeFooter(tui, theme, footerData));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (enabled && ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
		}
		ctxRef = null;
	});

	// Track streaming time per assistant message
	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") streamingSince = Date.now();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && streamingSince) {
			apiTimeMs += Date.now() - streamingSince;
			streamingSince = 0;
		}
	});

	// Snapshot last usage for the token line (cache countdown anchors here)
	pi.on("message_end", async (event) => {
		const m = event.message as AssistantMessage;
		if (m.role === "assistant" && m.usage) {
			lastUsage = m.usage;
			if ((m.usage.cacheWrite1h ?? 0) > 0) cacheTtlMs = LONG_CACHE_TTL_MS;
			lastRequestAt = Date.now();
		}
	});

	// Track LLM requests. pi-ai retries rate limits (429) INSIDE the transport
	// before any response object exists, so `after_provider_response` only fires
	// for the final outcome of a logical call. Counting model:
	//   - non-2xx final response → failed (counted immediately)
	//   - assistant message_end stopReason "error" → failed (rate-limit/quota
	//     exhaustion throws before a response exists; deduped against the above)
	//   - assistant message_end with any other stopReason → successful call
	pi.on("after_provider_response", async (event) => {
		if (event.status >= 400) {
			reqTotal++;
			reqFail++;
			reqErrCounted = true; // message_end for this call will also report error
		}
	});

	pi.on("message_end", async (event) => {
		const m = event.message as AssistantMessage;
		if (m.role !== "assistant" || m.stopReason === "pending") return;
		if (m.stopReason === "error") {
			if (!reqErrCounted) {
				reqTotal++;
				reqFail++;
			}
			// Parse provider-stated wait durations embedded in the error body
			// (headers are parsed by the transport when enabled; body-embedded
			// waits only exist in errorMessage text). Surface as a countdown.
			const waitMs = parseRetryWaitMs(m.errorMessage);
			rateLimitedUntil = waitMs ? Date.now() + waitMs : 0;
		} else {
			reqTotal++;
			reqOk++;
			rateLimitedUntil = 0;
		}
		reqErrCounted = false;
	});

	// --- Rate-limit wait parsing ---
	// Extract a provider-stated wait duration from an error message body.
	// Matches common phrasings: "try again in 8.4s", "retry after 42 seconds",
	// "retry-after: 60", "retry after 2 minutes", "reset in 30s".
	function parseRetryWaitMs(msg?: string): number {
		if (!msg) return 0;
		const seconds = (v: string) => Number.parseFloat(v) * 1000;
		const filler = "[^.\\n]{0,60}?"; // words between the verb and the duration
		let m =
			new RegExp(`(?:retry|try|wait)${filler}\\b(?:in|after)\\s+(\\d+(?:\\.\\d+)?)\\s*(?:seconds?|secs?|s\\b)`, "i").exec(msg);
		if (m) return seconds(m[1]);
		m = new RegExp(`(?:retry|try|wait)${filler}\\b(?:in|after)\\s+(\\d+)\\s*(?:minutes?|mins?|m\\b)`, "i").exec(msg);
		if (m) return seconds(m[1]) * 60;
		m = /retry[-\s]?after(?:[:=]\s*|\s+)(\d+)/i.exec(msg);
		if (m) return seconds(m[1]);
		m = /\brate.?limit[^.]*?reset in\s+(\d+(?:\.\d+)?)\s*(s\b|sec|seconds?)/i.exec(msg);
		if (m) return seconds(m[1]);
		m = /\b(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds?)\s*(?:before|until|to)\s*(?:retry|try)/i.exec(msg);
		if (m) return seconds(m[1]);
		return 0;
	}

	// Track lines added/removed
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "write" && typeof (event.args as any)?.content === "string") {
			linesAdded += (event.args as any).content.split("\n").length;
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "edit") {
			const patch: string | undefined = (event.result as any)?.details?.patch;
			if (patch) {
				for (const line of patch.split("\n")) {
					if (line.startsWith("+++") || line.startsWith("---")) continue;
					if (line.startsWith("+")) linesAdded++;
					else if (line.startsWith("-")) linesRemoved++;
				}
			}
		}
	});

	// Toggle command
	pi.registerCommand("statusline", {
		description: "Toggle the 3-line status footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled && ctx.mode === "tui") {
				ctxRef = ctx;
				ctx.ui.setFooter((tui, theme, footerData) => makeFooter(tui, theme, footerData));
				ctx.ui.notify("Status line enabled", "info");
			} else if (ctx.mode === "tui") {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Status line disabled (default footer restored)", "info");
			} else {
				ctx.ui.notify(`Status line ${enabled ? "enabled" : "disabled"} (no TUI)`, "info");
			}
		},
	});
}
