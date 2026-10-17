// agent-team: orchestrator extension — spawn research/implement child agents, advisor gate
// Generic roles (research/implement/advisor); models come from ~/.pi/agent/settings.json agentTeam block.
// Children run `pi -p` headless with PI_NO_AGENT_TEAM=1 (recursion guard).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

// ── config ──────────────────────────────────────────────────────────

type RoleConfig = { model: string; provider?: string; maxCostUsd?: number; timeoutMin?: number };
type TeamConfig = {
	roles?: { research?: RoleConfig; implement?: RoleConfig };
	advisor?: { failOpen?: boolean; model?: string };
};

const SETTINGS = path.join(os.homedir(), ".pi/agent/settings.json");
const BASE = "/tmp/pi-agent-team";

function loadConfig(): TeamConfig {
	try {
		const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
		return (s.agentTeam as TeamConfig) ?? {};
	} catch {
		return {};
	}
}

function roleConfig(cfg: TeamConfig, role: "research" | "implement"): RoleConfig {
	const dflt: Record<string, RoleConfig> = {
		research: { model: "z-ai/glm-5.3-flash", provider: "openrouter", maxCostUsd: 0.5, timeoutMin: 10 },
		implement: { model: "deepseek/deepseek-v4-pro", provider: "openrouter", maxCostUsd: 2.0, timeoutMin: 30 },
	};
	return { ...dflt[role], ...(cfg.roles?.[role] ?? {}) };
}

// ── fleet state (shared with status-line via globalThis; mirrored to disk) ──

type ChildState = {
	id: string;
	role: string;
	model: string;
	pid: number;
	started: number;
	state: "running" | "done" | "failed" | "killed";
	budgetUsd: number;
	spentUsd: number;
};
type FleetState = {
	children: ChildState[];
	roleSpend: { research: number; implement: number; advisor: number };
	advisor: { pass: number; warn: number };
};

function fleet(): FleetState {
	const g = globalThis as Record<string, unknown>;
	if (!g.__agentTeamState) {
		g.__agentTeamState = { children: [], roleSpend: { research: 0, implement: 0, advisor: 0 }, advisor: { pass: 0, warn: 0 } };
	}
	return g.__agentTeamState as FleetState;
}

function mirror() {
	try {
		fs.mkdirSync(BASE, { recursive: true });
		fs.writeFileSync(path.join(BASE, "state.json"), JSON.stringify({ ...fleet(), updatedAt: Date.now() }));
	} catch {
		/* best-effort */
	}
}

// ── child helpers ───────────────────────────────────────────────────

function sessionCost(sessionId: string): number {
	try {
		const root = path.join(os.homedir(), ".pi/agent/sessions");
		const hit = findFile(root, `_${sessionId}.jsonl`, 4);
		if (!hit) return 0;
		let cost = 0;
		for (const line of fs.readFileSync(hit, "utf8").split("\n")) {
			if (!line.includes('"role":"assistant"') || !line.includes('"cost"')) continue;
			const m = line.match(/"cost":\{[^}]*"total":([\d.]+)\}/);
			if (m) cost += parseFloat(m[1]) || 0;
		}
		return cost;
	} catch {
		return 0;
	}
}

function findFile(dir: string, name: string, depth: number): string | null {
	if (depth < 0 || !fs.existsSync(dir)) return null;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			const r = findFile(p, name, depth - 1);
			if (r) return r;
		} else if (e.name === name) return p;
	}
	return null;
}

const ROLE_PREAMBLE: Record<string, string> = {
	research:
		"You are the RESEARCH agent of a multi-agent pi team. Work autonomously — no user interaction. " +
		"Use the ketch tools (internet_search, internet_scrape, ketch_docs, ketch_code) — never curl/bash for web access. " +
		"Be token-efficient: search first, scrape only the most authoritative 2-4 sources, cite every claim with a URL. " +
		"Do not implement anything; produce findings only.",
	implement:
		"You are the IMPLEMENT agent of a multi-agent pi team. Work autonomously — no user interaction. " +
		"Implement exactly the assigned work item(s) — never expand scope beyond them. " +
		"Follow existing repo conventions; run the project's typecheck/lint/tests for the files you touched.",
};

function runChild(
	role: string,
	task: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; digest: string; artifact: string; spentUsd: number }> {
	const cfg = loadConfig();
	const rc = roleConfig(cfg, role as "research" | "implement");
	const id = `${role}-${Date.now().toString(36)}`;
	const dir = path.join(BASE, id);
	fs.mkdirSync(dir, { recursive: true });
	const sessionId = `agent-${id}`;
	const artifactRel = path.join(".pi/agent-team/artifacts", `${id}.md`);
	const artifactAbs = path.join(process.cwd(), artifactRel);

	const prompt =
		`${ROLE_PREAMBLE[role] ?? ""}\n\n` +
		`TASK:\n${task}\n\n` +
		`FINISH PROTOCOL (mandatory):\n` +
		`1. Write your full report to ${artifactRel} (relative to cwd) using the write tool.\n` +
		`2. Write ${path.join(dir, "result.json")} with exactly: ` +
		`{"status":"done|blocked","digest":"<=6 lines, what was found/done","findings":["..."],"files":["..."],"openQuestions":["..."]}\n` +
		`Then stop. Do not start new work.`;

	const child = spawn(
		"pi",
		["-p", "--session-id", sessionId, "--model", rc.model, "--provider", rc.provider ?? "openrouter", prompt],
		{
			cwd: process.cwd(),
			env: { ...process.env, PI_NO_AGENT_TEAM: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	const st: ChildState = {
		id,
		role,
		model: rc.model,
		pid: child.pid ?? 0,
		started: Date.now(),
		state: "running",
		budgetUsd: rc.maxCostUsd ?? 1,
		spentUsd: 0,
	};
	fleet().children.push(st);
	mirror();

	return new Promise(resolve => {
		let out = "";
		let err = "";
		let settled = false;
		const finish = (state: ChildState["state"], ok: boolean, digest: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			st.state = state;
			st.spentUsd = sessionCost(sessionId);
			const rs = fleet().roleSpend as Record<string, number>;
			rs[role] = (rs[role] ?? 0) + st.spentUsd;
			mirror();
			resolve({ ok, digest, artifact: artifactAbs, spentUsd: st.spentUsd });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish("killed", false, `child exceeded ${rc.timeoutMin ?? 10}min wall-clock budget`);
		}, (rc.timeoutMin ?? 10) * 60_000);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish("killed", false, "aborted by user");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (c: Buffer) => (out += c));
		child.stderr.on("data", (c: Buffer) => (err += c));
		child.on("error", (e: Error) => finish("failed", false, `failed to spawn: ${e.message}`));
		child.on("close", code => {
			const resultPath = path.join(dir, "result.json");
			let digest = "";
			try {
				const r = JSON.parse(fs.readFileSync(resultPath, "utf8"));
				digest = String(r.digest ?? "");
				if (Array.isArray(r.openQuestions) && r.openQuestions.length)
					digest += `\nOpen questions: ${r.openQuestions.join("; ")}`;
			} catch {
				digest = out.trim().slice(-1500) || err.trim().slice(-500);
			}
			finish(code === 0 ? "done" : "failed", code === 0, digest || "(no digest — see artifact)");
		});
	});
}

// ── advisor (generic; engine from config, default Typesafe System One) ──

type AdvQuestion = {
	name: string;
	type: "choice" | "score" | "noul";
	prompt: string;
	options?: { value: string; description: string }[];
};

async function advise(state: string, questions: AdvQuestion[]): Promise<{ text: string; costUsd: number; warn: boolean }> {
	const cfg = loadConfig();
	const key = process.env.TYPESAFE_API_KEY;
	const model = cfg.advisor?.model ?? "jev-latest";
	if (!key) throw new Error("advisor not configured (set TYPESAFE_API_KEY)");
	const body: Record<string, unknown> = { model, state };
	const q: Record<string, unknown> = {};
	for (const question of questions) {
		if (question.type === "choice")
			q[question.name] = {
				type: "choice",
				criteria: Object.fromEntries((question.options ?? []).map(o => [o.value, o.description])),
			};
		else if (question.type === "score") {
			const opts = question.options ?? [];
			q[question.name] = {
				type: "score",
				criteria: opts.length
					? opts.map(o => ({ value: Number(o.value), description: o.description }))
					: [
						{ value: 0, description: `${question.prompt} — not at all` },
						{ value: 1, description: `${question.prompt} — fully` },
					  ],
			};
		} else q[question.name] = { type: "noul", instructions: question.prompt };
	}
	body.questions = q;
	const t0 = Date.now();
	const resp = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!resp.ok) throw new Error(`advisor API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	const data = (await resp.json()) as {
		answers: Record<string, Record<string, unknown>>;
		usage?: { input_tokens?: number };
	};
	const costUsd = ((data.usage?.input_tokens ?? 0) * 0.042) / 1e6;
	const f = fleet();
	f.roleSpend.advisor += costUsd;
	const lines = Object.entries(data.answers).map(([k, a]) => {
		const conf = a.confidence as number | undefined;
		const low = typeof conf === "number" && conf < 0.6;
		if (low) f.advisor.warn++;
		else f.advisor.pass++;
		let val = a.choice ?? a.noul ?? a.score;
		if (a.type === "score" && typeof val === "number")
			val = `score ${Math.min(1, Math.max(0, val)).toFixed(2)}${(a.score as number) > 1 ? " (clamped from raw)" : ""}`;
		return `- ${k}: ${String(val)}${typeof conf === "number" ? ` (confidence ${conf.toFixed(2)})${low ? " ⚠ low" : ""}` : ""}`;
	});
	mirror();
	return { text: lines.join("\n") + `  [advisor ${(Date.now() - t0) / 1000}s]`, costUsd, warn: f.advisor.warn > 0 };
}

// ── extension entry ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (process.env.PI_NO_AGENT_TEAM === "1") return; // recursion guard: children can't spawn agents

	// ── spawn_research_agent ────────────────────────────────────────
	pi.registerTool({
		name: "spawn_research_agent",
		label: "Research Agent",
		description:
			"Delegate research to the research agent (own model, own context). Returns a digest; full report lands in .pi/agent-team/artifacts/. Use instead of researching inline when the task needs >2 tool calls of web work.",
		promptSnippet: "Delegate research to the research sub-agent",
		parameters: Type.Object({
			task: Type.String({ description: "Research brief: what to find, what depth, what format" }),
		}),
		async execute(_id: string, params: { task: string }, signal?: AbortSignal) {
			const r = await runChild("research", params.task, signal);
			return {
				content: [
					{ type: "text", text: `Research agent ${r.ok ? "done" : "failed"} ($${r.spentUsd.toFixed(3)}).\n\n${r.digest}\n\nFull report: ${r.artifact}` },
				],
				details: { spentUsd: r.spentUsd, artifact: r.artifact },
			};
		},
	});

	// ── spawn_implement_agent ───────────────────────────────────────
	pi.registerTool({
		name: "spawn_implement_agent",
		label: "Implement Agent",
		description:
			"Delegate implementation to the implement agent (own model, own context). Pass a plan file (plan-mode output) plus optional work item. Returns a digest; report and changed-file list land in .pi/agent-team/artifacts/.",
		promptSnippet: "Delegate implementation to the implement sub-agent",
		parameters: Type.Object({
			planPath: Type.String({ description: "Path to the plan file (plan-mode output, file:line targets)" }),
			workItem: Type.Optional(Type.String({ description: "Restrict to one work item, e.g. 'item 2' — omit to execute the whole plan" })),
		}),
		async execute(_id: string, params: { planPath: string; workItem?: string }, signal?: AbortSignal) {
			const task = `Read the plan at ${params.planPath} and implement ${params.workItem ? `ONLY work item: ${params.workItem}` : "all work items in order"}. The plan's file:line targets are authoritative.`;
			const r = await runChild("implement", task, signal);
			return {
				content: [
					{ type: "text", text: `Implement agent ${r.ok ? "done" : "failed"} ($${r.spentUsd.toFixed(3)}).\n\n${r.digest}\n\nReport: ${r.artifact}` },
				],
				details: { spentUsd: r.spentUsd, artifact: r.artifact },
			};
		},
	});

	// ── advise ──────────────────────────────────────────────────────
	pi.registerTool({
		name: "advise",
		label: "Advisor",
		description:
			"Ask the advisor agent to judge a state with typed questions (choice/score/noul) and get calibrated answers with confidence. Use at decision points: research sufficiency, implementation conformance, routing. Text-in, probabilities-out — never use it to generate content.",
		promptSnippet: "Ask the advisor agent for a calibrated judgment",
		parameters: Type.Object({
			state: Type.String({ description: "The context to judge (text, max ~30k tokens)" }),
			questions: Type.Array(
				Type.Object({
					name: Type.String({ description: "Question key" }),
					type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("noul")]),
					prompt: Type.String({ description: "The question/criteria" }),
					options: Type.Optional(
						Type.Array(
							Type.Object({ value: Type.String(), description: Type.String() }),
							{ description: "choice: option value + what it means. score: calibration points [{value:'0'..'1', description}] (defaults to 0=not at all, 1=fully)" },
						),
					),
				}),
				{ description: "Typed questions to ask (1-8)" },
			),
		}),
		async execute(_id: string, params: { state: string; questions: AdvQuestion[] }, signal?: AbortSignal) {
			try {
				const r = await advise(params.state, params.questions.slice(0, 8));
				return { content: [{ type: "text", text: r.text }], details: { costUsd: r.costUsd, hasLowConfidence: r.warn, failOpen: false } };
			} catch (e) {
				const f = fleet();
				f.advisor.warn++;
				mirror();
				return {
					content: [
						{
							type: "text",
							text: `Advisor unavailable — decide without it (fail-open). ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					details: { costUsd: 0, hasLowConfidence: true, failOpen: true },
				};
			}
		},
	});

	// ── /agents command ─────────────────────────────────────────────
	pi.registerCommand("agents", {
		description: "Show or change agent-team role→model mapping (/agents research=provider/model)",
		handler: async (args: string, ctx: { ui: { notify: (message: string, type?: "error" | "info" | "warning") => void } }) => {
			const notify = (text: string) => ctx.ui.notify(text, "info");
			const arg = args.trim();
			const cfg = loadConfig();
			if (arg) {
				const m = arg.match(/^(research|implement|advisor)=(\S+)$/);
				if (!m) {
					notify("Usage: /agents research=<provider/model> | implement=<provider/model>");
					return;
				}
				const [, role, model] = m;
				try {
					const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
					s.agentTeam = s.agentTeam ?? {};
					if (role === "advisor") s.agentTeam.advisor = { ...(s.agentTeam.advisor ?? {}), model };
					else {
						s.agentTeam.roles = s.agentTeam.roles ?? {};
						s.agentTeam.roles[role] = { ...(s.agentTeam.roles?.[role] ?? {}), model };
					}
					fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
					notify(`${role} → ${model} (persisted; applies to next spawn)`);
				} catch (e) {
					notify(`Failed to persist: ${e instanceof Error ? e.message : e}`);
				}
				return;
			}
			const r = roleConfig(cfg, "research");
			const i = roleConfig(cfg, "implement");
			notify(
				`Agent team:\n` +
					`  orchestrator → (use /model)\n` +
					`  research     → ${r.model} (max $${r.maxCostUsd}, ${r.timeoutMin}min)\n` +
					`  implement    → ${i.model} (max $${i.maxCostUsd}, ${i.timeoutMin}min)\n` +
					`  advisor      → ${cfg.advisor?.model ?? "jev-latest"} (Typesafe API)\n` +
					`Change: /agents research=<provider/model>`,
			);
		},
	});
}