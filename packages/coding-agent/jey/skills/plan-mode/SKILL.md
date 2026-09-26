---
name: plan-mode
description: Interactive, token-efficient planning workflow for coding tasks. Use when the user asks to plan, design, refactor, or architect something before implementation, or via /skill:plan-mode. Explores with a strict tool-call budget, clarifies everything in one turn, emits a compact file:line-targeted plan, then executes in minimal turns with batched tool calls and a single verification pass.
---

# Plan Mode (token-efficient)

Phases in strict order; Phase 3b (revision) may repeat any number of times. A phase ends when its artifact exists — never revisit.

## Phase 1 — Explore (1 turn, ≤8 tool calls)

Goal: the minimum context needed to write correct steps. Nothing more.

- Start with structure, not content: one `ls`/`find` for layout, one targeted `rg -n` per concern.
- `read` only relevant ranges via `offset`/`limit`. Never read a file fully unless <150 lines or truly essential.
- Batch ALL independent tool calls in this single turn (parallel calls) — one turn, not a chain.
- Hard cap: 8 tool calls. If the cap is hit, plan with what you have and note gaps under `Risks`.
- Trivial task (obvious one-file, few-line change)? Skip to Phase 4 directly and say so.

## Phase 2 — Clarify (exactly 1 turn, 0 tool calls)

Ask ALL questions in one numbered list. EVERY question uses this format:

```
1. <Question>?
   a) <option> — <one-line consequence/tradeoff>  ◀
   b) <option> — <one-line consequence/tradeoff>
   c) <option> — <one-line consequence/tradeoff>
```

Rules:
- 2–4 options per question; mark exactly one recommended with `◀` and bake the reason into its one-liner (no separate explanation paragraphs).
- End the list with ONE line: `Reply like "1a, 2c, 3: <your own words>" — or "go" for all ◀.`
- Free-form override is always available per question; never constrain to the listed options.
- No option fits? Say so and ask the question open-ended instead of inventing filler options.
- Nothing ambiguous? Skip this phase entirely and record assumptions in the plan instead.

## Phase 3 — Plan (0–1 tool calls)

Output exactly this template, ≤40 lines total:

```
Plan: <one-sentence goal>
Assumptions: <non-obvious ones only, or "—">
Steps:
1. <action> — <path/file.ext:line> — <one-line why, only if not obvious>
2. ...
Verification: <one command or check that proves the whole plan>
Risks: <≤2 real risks>
```

Rules:
- Every step targets an exact file:line so execution needs zero re-exploration.
- No code in the plan (exception: a one-line signature when the API shape IS the decision).
- No restating the user's request, no restating explored context, no preamble.
- Then STOP and wait for approval. Do not begin executing.

## Phase 3b — Revision loop (repeat until the user approves)

The user is expected to revise repeatedly. Each revision turn:

- User gives step-referenced feedback ("step 2: use X instead", "drop step 4", "add a step for Y").
- Regenerate ONLY the affected steps. First line states the version and what changed: `Plan v3 — changed: 2, 4; added: 6`. Do not repeat unchanged steps.
- Re-print the full plan ONLY when more than half the steps changed or renumbering makes a partial diff confusing.
- 0 tool calls per revision. Re-explore ONLY if the user names a specific unknown; then ≤2 calls in one turn, and say what you learned in ≤3 lines before the revised steps.
- Never defend a rejected option or re-litigate feedback — the latest instruction wins, even if it contradicts an earlier one.
- Keep step numbers stable across revisions where possible so feedback keeps pointing at the same steps.
- To restart from scratch the user says "redo" — re-plan fully, reusing existing exploration (no re-exploration unless the task itself changed).
- On approval ("go" / "execute" / "looks good"), lock the version and move to Phase 4.

## Phase 4 — Execute (minimum turns)

- A plan change requested mid-execution: stop, emit a delta plan (≤10 lines, same `vN — changed:` header), apply after the user confirms. Steps already `[DONE:n]` are redone only if explicitly requested.
- Follow steps in order. Batch independent steps into ONE turn (parallel tool calls).
- Read only ±20 lines around each edit target. Trust `edit`'s returned diff — do not re-read to verify.
- No verification per step. Run `Verification` exactly once, after the final step.
- After completing step n, include `[DONE:n]` in that turn's reply. Final turn: one-paragraph summary of what changed, nothing else.

## Hard efficiency rules (always)

- Tool output is cheap to fetch but paid on every later turn (even at cache-read rates): never `cat` whole files, never pipe large outputs, grep with `-n` and read ranges instead.
- Output tokens cost ~5x cached input: minimal prose, no repetition, no restating.
- Every turn must either gather ≥2 facts, ask ≥1 question, or produce ≥1 artifact. "Let me just check one more thing" chains are forbidden.
- A blocked/failed attempt costs a full turn: when unsure about an API, read the definition (1 call) instead of guessing (1 failed edit + 1 retry).
