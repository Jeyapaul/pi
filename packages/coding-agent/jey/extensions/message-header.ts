/**
 * Message Header Extension v3 — breadcrumb bar pinned to the top of the viewport.
 *
 * Fullscreen TUI mode only. Shows the previous user message (the one scrolled
 * past above the viewport top) as a shaded bar:
 *   - Default: first line of that message
 *   - Hover:   expands to the full message
 *   - Unhover: collapses immediately (global pointer tracking)
 *   - Press:   scrolls the transcript to that message; the bar then shows the
 *              message preceding it, so repeated presses walk up the transcript
 *
 * Safety:
 *   - `nonCapturing: true` — the bar NEVER takes keyboard focus.
 *   - handleInput self-heal: if focus ever lands on the bar, the first
 *     keystroke immediately unfocuses it back to the editor.
 *   - Mouse pass-through except press (jump) and first hover.
 *   - Default ON (fullscreen mode); /msgheader toggles; state persists via
 *     pi.appendEntry() — an explicit /msgheader disable wins over the default.
 *
 * Unhover detection: components only receive mouse events while the pointer is
 * over them, so the bar can't observe "pointer left". We wrap the renderer's
 * handleMouseEvent (which sees every mouse event before dispatch) to track the
 * pointer and collapse the moment it moves outside the bar's bounds. Restored
 * on hide; never throws into input handling.
 *
 * /msgheader toggles the bar. While visible, pi disables scrollbar hover/drag
 * app-wide (single-overlay limitation) — wheel/keys still scroll.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const SEQUENCE_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|\x1b[=>]/g;
const COLLAPSE_MS = 4000;
const MAX_EXPANDED_LINES = 24;

const strip = (s: string) => s.replace(SEQUENCE_RE, "");

interface LayoutBox {
	rect: { x: number; y: number; width: number; height: number };
	children?: LayoutBox[];
	scrollView?: unknown;
	scrollContentLines?: string[];
}

interface OverlayHandle {
	hide(): void;
	show(): void;
	unfocus(options?: unknown): void;
	isFocused(): boolean;
	getBounds?(): { row: number; col: number; width: number; height: number } | undefined;
}

function findScrollViewBox(root: LayoutBox | undefined, sv: unknown): LayoutBox | undefined {
	if (!root) return undefined;
	if (root.scrollView === sv) return root;
	for (const child of root.children ?? []) {
		const hit = findScrollViewBox(child, sv);
		if (hit) return hit;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let enabled = true; // default ON for all sessions; /msgheader toggles (persisted)
	let tuiRef: any = null;
	let themeRef: any = null;
	let overlayHandle: OverlayHandle | null = null;
	let ctxRef: ExtensionContext | null = null;

	// --- Shared geometry scan (called from render and jump) ---

	// pi attaches an OSC 133;A prompt-start marker to BOTH user and assistant
	// messages. The bar must only show USER messages, so we match each marker
	// block's first line against the known user-message texts from the session.
	function getUserMessages(): string[] {
		try {
			const entries = ctxRef?.sessionManager.getBranch() as any[];
			return (entries ?? [])
				.filter((e) => e.type === "message" && e.message?.role === "user")
				.map((e) => {
					const c = e.message.content;
					if (typeof c === "string") return c;
					return c.find?.((b: any) => b.type === "text")?.text ?? "";
				})
				.filter((t) => t.trim().length > 0);
		} catch {
			return [];
		}
	}

	// Returns the full user-message text when the marker block at `row` is a
	// user message, or null for assistant/unknown blocks.
	function matchUserMarker(content: string[], row: number, nextMarker: number, userMsgs: string[]): string | null {
		if (userMsgs.length === 0) return null;
		for (let r = row; r < Math.min(nextMarker, row + 4); r++) {
			const line = strip(content[r] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
			if (!line) continue;
			for (const text of userMsgs) {
				const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
				const len = Math.min(norm.length, line.length);
				if (len > 0 && line.startsWith(norm.slice(0, len))) return text;
			}
			return null; // first non-empty line matched no user message
		}
		return null;
	}

	function getPromptRows(): { rows: number[]; content: string[]; rowText: Map<number, string> } | undefined {
		const tui = tuiRef;
		if (!tui || typeof tui.getPrimaryScrollView !== "function") return undefined;
		const sv = tui.getPrimaryScrollView();
		const layout = tui.currentLayout;
		const box: LayoutBox | undefined = sv && layout ? findScrollViewBox(layout.root, sv) : undefined;
		const content = box?.scrollContentLines;
		if (!sv || !Array.isArray(content)) return undefined;
		const userMsgs = getUserMessages();
		const all: number[] = [];
		for (let i = 0; i < content.length; i++) {
			if (OSC133_PROMPT_START.test(content[i] ?? "")) all.push(i);
		}
		const rows: number[] = [];
		const rowText = new Map<number, string>();
		for (let idx = 0; idx < all.length; idx++) {
			const next = idx + 1 < all.length ? all[idx + 1] : content.length;
			const text = matchUserMarker(content, all[idx], next, userMsgs);
			if (text !== null || userMsgs.length === 0) {
				rows.push(all[idx]);
				if (text !== null) rowText.set(all[idx], text);
			}
		}
		return { rows, content, rowText };
	}

	function targetPromptRow(rows: number[], scrollTop: number): number {
		// The message just scrolled past the viewport top; -1 if none
		let target = -1;
		for (const r of rows) {
			if (r < scrollTop) target = r;
			else break;
		}
		return target;
	}

	// --- Pointer tracking (real unhover detection) ---
	// The renderer's handleMouseEvent sees every mouse event before dispatch.
	// We wrap it to track the pointer position; the bar collapses the moment
	// a motion event lands outside the overlay's rendered bounds.
	let lastPointer: { x: number; y: number } | null = null;
	let unhoverDisarm: (() => void) | null = null;

	function armUnhover(tui: any, isActive: () => boolean, onUnhover: () => boolean) {
		disarmUnhover();
		if (typeof tui?.handleMouseEvent !== "function" || tui.__mhPatched) return;
		tui.__mhPatched = true;
		const orig = tui.handleMouseEvent.bind(tui);
		tui.handleMouseEvent = (raw: any) => {
			try {
				const isMotion = (raw.button & 32) !== 0 && !raw.release;
				if (isMotion) {
					lastPointer = { x: raw.x, y: raw.y };
					if (isActive()) {
						const b = overlayHandle?.getBounds?.();
						if (b) {
							const inside =
								raw.y >= b.row && raw.y < b.row + b.height && raw.x >= b.col && raw.x < b.col + b.width;
							if (!inside && onUnhover()) tui.requestRender();
						}
					}
				}
			} catch {
				/* tracking must never break input handling */
			}
			return orig(raw);
		};
		unhoverDisarm = () => {
			tui.handleMouseEvent = orig;
			tui.__mhPatched = false;
		};
	}

	function disarmUnhover() {
		unhoverDisarm?.();
		unhoverDisarm = null;
		lastPointer = null;
	}

	// --- Header component ---

	function makeHeaderComponent(tui: any, theme: any, handle: OverlayHandle) {
		let hovered = false;
		let collapseTimer: ReturnType<typeof setTimeout> | undefined;

		const shade = (text: string, width: number) => {
			const pad = Math.max(0, width - visibleWidth(text));
			// toolPendingBg (#282832) is clearly darker than userMessageBg, so the
			// bar never visually merges with the jumped-to user message below it.
			return theme.bg("toolPendingBg", truncateToWidth(text, width) + " ".repeat(pad));
		};

		const barLine = (text: string, width: number) => shade(`${theme.fg("accent", "▌")}${text}`, width);

		const scheduleCollapse = () => {
			if (collapseTimer) clearTimeout(collapseTimer);
			collapseTimer = setTimeout(() => {
				// Fallback collapse: only if the pointer has actually left the bar
				// (a motionless pointer resting on the bar must not collapse mid-read).
				const b = typeof handle.getBounds === "function" ? handle.getBounds() : undefined;
				const p = lastPointer;
				const inside =
					!!b && !!p && p.y >= b.row && p.y < b.row + b.height && p.x >= b.col && p.x < b.col + b.width;
				if (!inside) {
					hovered = false;
					tui.requestRender();
				} else {
					scheduleCollapse();
				}
			}, COLLAPSE_MS);
			collapseTimer.unref?.();
		};

		const jump = () => {
			const scan = getPromptRows();
			if (!scan) return;
			const sv = tui.getPrimaryScrollView();
			const row = targetPromptRow(scan.rows, sv.scrollTop ?? 0);
			if (row < 0) return;
			hovered = false;
			// Overshoot 3 lines: the clicked message lands a few rows BELOW the bar
			// (its marker stays above scrollTop, so the bar then shows its
			// predecessor), and the darker bar background can't merge with it.
			sv.scrollTo(Math.max(0, row - 3), { disableFollow: true });
			tui.requestRender();
		};

		const renderBar = (width: number): string[] => {
			const scan = getPromptRows();
			if (!scan || scan.rows.length === 0) {
				return [barLine(theme.fg("dim", " ↑ previous message — (scroll to navigate)"), width)];
			}
			const sv = tui.getPrimaryScrollView();
			const row = targetPromptRow(scan.rows, sv.scrollTop ?? 0);
			if (row < 0) {
				return [barLine(theme.fg("dim", " ↑ top of transcript — no earlier messages"), width)];
			}

			// Expansion shows ONLY the user message text (from the session),
			// never the surrounding rendered block (system/zone lines).
			const userText = scan.rowText.get(row);
			if (!userText) {
				return [barLine(theme.fg("dim", " ↑ (user message)"), width)];
			}
			const firstLine = userText.replace(/\s+/g, " ").trim();
			const label = hovered
				? `▲ ${firstLine}`
				: `▲ ${firstLine}   ${theme.fg("dim", "[hover: full message · click: jump here]")}`;

			if (!hovered) {
				return [barLine(label, width)];
			}
			// Expanded: the user message, wrapped, with a leading gap line
			// separating the bar from the transcript below.
			const lines = [barLine(label, width)];
			for (const raw of userText.split("\n").slice(0, MAX_EXPANDED_LINES)) {
				for (const wrapped of wrapTextWithAnsi(raw.trimEnd(), Math.max(10, width - 4))) {
					if (lines.length >= MAX_EXPANDED_LINES + 1) break;
					lines.push(shade(`${theme.fg("accent", "│")} ${wrapped}`, width));
				}
			}
			if (userText.split("\n").length > MAX_EXPANDED_LINES) {
				lines.push(shade(theme.fg("dim", `│ … (longer message truncated)`), width));
			}
			return lines;
		};

		return {
			invalidate() {},

			// Self-heal: if focus ever lands on this bar despite nonCapturing,
			// the first keystroke returns focus to the editor instead of being eaten.
			handleInput() {
				try {
					handle.unfocus();
				} catch {
					/* ignore */
				}
				tui.requestRender();
			},

			// Called by the global pointer tracker on unhover; returns true when
			// a hover→collapsed transition happened (caller then requests render).
			unhover(): boolean {
				if (!hovered) return false;
				hovered = false;
				if (collapseTimer) clearTimeout(collapseTimer);
				return true;
			},

			render(width: number): string[] {
				try {
					return renderBar(width);
				} catch {
					/* keep the bar alive even if a render fails */
					return [" bar"];
				}
			},

			handleMouse(event: any) {
				if (event.type === "wheel") return undefined; // transcript scrolls under the bar
				if (event.type === "move" || event.type === "drag") {
					if (!hovered) {
						hovered = true;
						scheduleCollapse();
						return { handled: true, render: true };
					}
					scheduleCollapse();
					return undefined; // pass through on repeat moves
				}
				if (event.type === "press") {
					// Jump on press, not click: pi only emits "click" when press and
					// release land on the exact same cell, which trackpad jitter
					// frequently breaks. A press on the bar is always a jump intent.
					jump();
					return { handled: true, capture: true, render: true };
				}
				if (event.type === "release") return { handled: true, render: false };
				if (event.type === "click") return { handled: true }; // already jumped on press
				return undefined;
			},
		};
	}

	function showBar() {
		const tui = tuiRef;
		if (!tui || !themeRef) return;
		if (tui.mode !== "fullscreen") return; // regular mode has no app-owned viewport
		overlayHandle?.hide();
		const component = makeHeaderComponent(tui, themeRef, overlayHandle ?? makeNoopHandle());
		overlayHandle = tui.showOverlay(component, {
			anchor: "top-center",
			width: "100%",
			maxHeight: "45%",
			margin: 0,
			nonCapturing: true, // v1 root-cause fix: never capture keyboard focus
		}) as OverlayHandle;
		armUnhover(
			tui,
			() => !!overlayHandle,
			() => component.unhover(),
		);
		tui.requestRender();
	}

	function hideBar() {
		overlayHandle?.hide();
		overlayHandle = null;
		disarmUnhover();
		const tui = tuiRef;
		if (tui && typeof tui.requestRender === "function") tui.requestRender();
	}

	function makeNoopHandle(): OverlayHandle {
		return {
			hide() {},
			show() {},
			unfocus() {},
			isFocused() {
				return false;
			},
		};
	}

	// Capture the TUI/theme via a zero-height widget (the only extension slot
	// that hands us the live TUI instance outside dialogs).
	function armCapture() {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		ctx.ui.setWidget("message-header-capture", (tui: any, theme: any) => {
			tuiRef = tui;
			themeRef = theme;
			if (enabled && tui.mode === "fullscreen") {
				// Defer so the layout exists before the first render scan
				setTimeout(() => {
					if (enabled) showBar();
				}, 50);
			}
			return {
				invalidate() {},
				render() {
					return [];
				},
			};
		});
	}

	function persist() {
		try {
			pi.appendEntry("message-header", { enabled });
		} catch {
			/* persistence is best-effort */
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		tuiRef = null;
		themeRef = null;
		overlayHandle = null;

		// Restore persisted toggle (disabled state also persists)
		try {
			const entries = ctx.sessionManager.getEntries() as any[];
			const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === "message-header");
			if (last && typeof last.data?.enabled === "boolean") {
				enabled = last.data.enabled;
			}
		} catch {
			/* keep default */
		}

		armCapture();
	});

	pi.on("session_shutdown", async () => {
		hideBar();
	});

	pi.registerCommand("msgheader", {
		description: "Toggle the previous-message header bar (fullscreen mode)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			persist();

			if (!tuiRef) {
				ctxRef = ctx;
				armCapture();
				ctx.ui.notify(enabled ? "Header bar will appear on next session start" : "Header bar disabled", "info");
				return;
			}
			if (tuiRef.mode !== "fullscreen") {
				ctx.ui.notify('Message header requires fullscreen TUI mode (tuiMode: "fullscreen")', "warning");
				return;
			}
			if (enabled) {
				showBar();
				ctx.ui.notify("Message header bar shown", "info");
			} else {
				hideBar();
				ctx.ui.notify("Message header bar hidden", "info");
			}
		},
	});
}
