// ketch-tools: web search + scrape + library docs + OSS code search via ketch CLI
// Pi extension — abortable async wrapper around the ketch binary (github.com/1broseidon/ketch)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
type KetchResult = { ok: true; data: unknown } | { ok: false; error: string };

// ── ketch runner (async, abortable) ─────────────────────────────────

function runKetch(args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<KetchResult> {
	return new Promise(resolve => {
		const child = spawn("ketch", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		let done = false;
		const finish = (r: KetchResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(r);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, error: `ketch timed out after ${timeoutMs / 1000}s: ketch ${args.join(" ")}` });
		}, timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish({ ok: false, error: "aborted by user" });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (c: Buffer) => (out += c));
		child.stderr.on("data", (c: Buffer) => (err += c));
		child.on("error", (e: Error) => {
			child.kill("SIGKILL");
			finish({ ok: false, error: `ketch failed to start (is it installed?): ${e.message}` });
		});
		child.on("close", code => {
			if (code !== 0) {
				finish({ ok: false, error: (err.trim() || `ketch exited with code ${code}`).slice(0, 500) });
				return;
			}
			try {
				finish({ ok: true, data: JSON.parse(out.trim()) });
			} catch {
				finish({ ok: false, error: `ketch returned non-JSON output: ${out.trim().slice(0, 300)}` });
			}
		});
	});
}

function fail(error: string): ToolResult {
	return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
}

function asArray(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) return data as Record<string, unknown>[];
	if (data && typeof data === "object") {
		const inner = (data as Record<string, unknown>).results;
		if (Array.isArray(inner)) return inner as Record<string, unknown>[];
	}
	return [];
}

function truncate(text: string, maxChars?: number): string {
	if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars — call again with a higher maxChars if needed]`;
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── internet_search ─────────────────────────────────────────────

	pi.registerTool({
		name: "internet_search",
		label: "Internet Search",
		description:
			"Search the web for real-time information, news, facts, error messages, and current events via ketch (multi-provider, keyless). Returns ranked results with title, URL, and description.",
		promptSnippet: "Search the internet for real-time information using ketch",
		promptGuidelines: [
			"Use internet_search for current events, error messages, release notes, comparisons, or anything you cannot know from training data.",
			"Follow up with internet_scrape on the most authoritative result to read its full content before answering.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum results, 1-10 (default 5)" })),
		}),
		async execute(
			_toolCallId: string,
			params: { query: string; limit?: number },
			signal?: AbortSignal,
		): Promise<ToolResult> {
			const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
			const result = await runKetch(["search", params.query, "--limit", String(limit), "--json"], signal);
			if (!result.ok) return fail(result.error);
			const rows = asArray(result.data);
			if (rows.length === 0) return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: {} };
			const text = rows
				.map(
					(r, i) =>
						`${i + 1}. **${(r.title as string) || "Untitled"}**\n   ${r.url ?? "(no url)"}\n   ${(r.description as string) || ""}`,
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { count: rows.length } };
		},
	});

	// ── internet_scrape ─────────────────────────────────────────────

	pi.registerTool({
		name: "internet_scrape",
		label: "Scrape URL",
		description:
			"Fetch a URL and extract its full content as clean markdown. Use after internet_search to read a page's complete context, then cite/extract only the relevant parts.",
		promptSnippet: "Fetch a URL and extract clean markdown content",
		promptGuidelines: [
			"Use internet_scrape to read the full content of a page found via internet_search.",
			"Prefer internet_scrape over curl/bash for any URL — it returns clean, token-efficient markdown.",
			"Set maxChars to keep output bounded; raise it only when the needed section is truncated.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to scrape" }),
			raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown (default false)" })),
			maxChars: Type.Optional(Type.Number({ description: "Truncate output to N characters (default 20000, 0 = no limit)" })),
		}),
		async execute(
			_toolCallId: string,
			params: { url: string; raw?: boolean; maxChars?: number },
			signal?: AbortSignal,
		): Promise<ToolResult> {
			const args = ["scrape", params.url, "--json"];
			if (params.raw) args.push("--raw");
			const result = await runKetch(args, signal);
			if (!result.ok) return fail(result.error);
			const rows = asArray(result.data);
			const first = rows[0] ?? (result.data as Record<string, unknown>);
			const markdown = (first.markdown as string) || JSON.stringify(first);
			const header = `## ${first.title || first.url || params.url}\n\n`;
			const max = params.maxChars === undefined ? 20_000 : params.maxChars;
			return { content: [{ type: "text", text: truncate(header + markdown, max) }], details: { url: params.url } };
		},
	});

	// ── ketch_docs ──────────────────────────────────────────────────

	pi.registerTool({
		name: "ketch_docs",
		label: "Library Docs Search",
		description:
			"Search curated library documentation (Context7) for the correct, version-current API of a specific library — e.g. 'zod discriminatedUnion', 'react useSyncExternalStore'. Returns doc excerpts with library + source URLs.",
		promptSnippet: "Search library documentation for version-correct API usage",
		promptGuidelines: [
			"Use ketch_docs when you need the exact API signature or behavior of a library function — it returns version-current official docs, unlike general web search.",
			"Prefer ketch_docs over internet_search for API questions about known libraries.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Documentation query, e.g. 'recursive schemas' or 'getServerSideProps'" }),
			library: Type.Optional(Type.String({ description: "Library name or Context7 library ID to scope results (e.g. 'zod', '/colinhacks/zod')" })),
			limit: Type.Optional(Type.Number({ description: "Maximum results (default 5)" })),
		}),
		async execute(
			_toolCallId: string,
			params: { query: string; library?: string; limit?: number },
			signal?: AbortSignal,
		): Promise<ToolResult> {
			const args = ["docs", params.query, "--json", "--limit", String(params.limit ?? 5)];
			if (params.library) {
				if (params.library.startsWith("/")) {
					args.push("--library", params.library);
				} else {
					// resolve library name → Context7 ID (e.g. "zod" → "/colinhacks/zod")
					const res = await runKetch(["docs", params.library, "--resolve"], signal);
					const id = res.ok
						? String(res.data).split("\n")[0]?.match(/\/\S+/)?.[0]
						: undefined;
					if (id) args.push("--library", id);
				}
			}
			const result = await runKetch(args, signal);
			if (!result.ok) {
				if (/context7_api_key|api key/i.test(result.error)) {
					return fail(
						`${result.error} (one-time setup: ketch config set context7_api_key <key> — free key at context7.com; meanwhile use internet_search + internet_scrape)`,
					);
				}
				return fail(result.error);
			}
			const rows = asArray(result.data);
			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: `No doc results for "${params.query}"${params.library ? ` in ${params.library}` : ""}. Try a broader query or fall back to internet_search.` }],
					details: {},
				};
			}
			const text = rows
				.map((r, i) => {
					const lib = (r.library as string) || (r.libraryTitle as string) || "";
					const body = (r.snippet as string) || (r.content as string) || (r.markdown as string) || JSON.stringify(r);
					return `### ${i + 1}. ${r.title || lib || "Doc"}${lib ? `  [${lib}]` : ""}\n   ${r.url || r.source || ""}\n\n${body}`;
				})
				.join("\n\n---\n\n");
			return { content: [{ type: "text", text: truncate(text, 20_000) }], details: { count: rows.length } };
		},
	});

	// ── ketch_code ──────────────────────────────────────────────────

	pi.registerTool({
		name: "ketch_code",
		label: "OSS Code Search",
		description:
			"Search real code across 1M+ public GitHub repos (grep.app, keyless). Find production patterns and real-world usage of APIs — e.g. 'express error handling middleware', regex '\\bAbortSignal\\.any\\('.",
		promptSnippet: "Search open-source code for real-world implementation patterns",
		promptGuidelines: [
			"Use ketch_code to see how real projects implement a pattern before writing your own.",
			"Combine with ketch_docs: docs give the correct API, code search gives battle-tested usage.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Code search query (literal or regex with regex:true)" }),
			lang: Type.Optional(Type.String({ description: "Language filter, e.g. 'typescript', 'go', 'python'" })),
			regex: Type.Optional(Type.Boolean({ description: "Interpret query as a regular expression (default false)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum results (default 5)" })),
		}),
		async execute(
			_toolCallId: string,
			params: { query: string; lang?: string; regex?: boolean; limit?: number },
			signal?: AbortSignal,
		): Promise<ToolResult> {
			const args = ["code", params.query, "--json", "--limit", String(params.limit ?? 5)];
			if (params.lang) args.push("--lang", params.lang);
			if (params.regex) args.push("--regex");
			const result = await runKetch(args, signal);
			if (!result.ok) return fail(result.error);
			const rows = asArray(result.data);
			if (rows.length === 0) {
				return { content: [{ type: "text", text: `No code results for "${params.query}". Try --minimal-style keywords or a simpler literal.` }], details: {} };
			}
			const text = rows
				.map((r, i) => {
					const repo = (r.repo as string) || (r.repository as string) || "";
					const url = (r.url as string) || "";
					const snippet = (r.snippet as string) || (r.content as string) || (r.code as string) || JSON.stringify(r);
					return `### ${i + 1}. ${repo || url || "Result"}\n   ${url}\n\n\`\`\`\n${snippet.trim().slice(0, 2000)}\n\`\`\``;
				})
				.join("\n\n");
			return { content: [{ type: "text", text: truncate(text, 20_000) }], details: { count: rows.length } };
		},
	});
}