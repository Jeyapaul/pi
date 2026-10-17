---
name: implement-mode
description: Delegated, plan-driven implementation workflow. Use when the user asks to implement, execute, or build a plan — via /skill:implement or /skill:implement-mode. Splits a plan-mode plan into work items, delegates execution to the implement agent (own model, own context), verifies each item, gates with the advisor, and escalates structural failures back to planning.
---

# Implement Mode (delegated, plan-driven)

Principle: the orchestrator plans and verifies; the implement agent edits. This session keeps its context clean by reading digests, not diffs.

## Phase 1 — Plan check (0–1 tool calls)

Need a plan file with file:line targets (plan-mode output). None? Run plan-mode first — never implement without one. Confirm the plan still matches reality (files may have changed since it was written); refresh stale targets before delegating.

## Phase 2 — Work-item split (0 tool calls)

Number the plan's work items. Mark each: `independent` (disjoint files) or `dependent`. Independent items may later fan out (parallel implement children — flag for the future; sequential today).

## Phase 3 — Delegate (1 tool call per batch)

Call `spawn_implement_agent` with `planPath` (+ `workItem` for a single item, or omit to execute all items in order). Do NOT edit files inline unless the change is a trivial ≤5-line fix.

## Phase 4 — Verify per item (0–1 tool calls)

For each claimed-done item: run the project's own check for the touched files (typecheck/lint/test) and read the diff. The implement agent's digest is a claim, not evidence.

## Phase 5 — Advisor conformance gate (1 tool call)

Call `advise` with state = (plan items + digest + verification output) and questions:
- one `score` per plan item: "The work satisfies this item completely"
- one `noul`: "No item touched files outside the plan's targets"

< 0.7 on any item → Phase 6. Advisor unavailable → your own judgment, stated explicitly.

## Phase 6 — Failure path

- Mechanical slip (right approach, small miss) → one re-task to the SAME role with the failure report (`workItem` restricted). Max 1 retry.
- Structural problem (wrong approach, plan gap) → stop; return to plan-mode. Never let an implement agent redesign.

## Budgets
- 1 + (1 retry per item) spawn calls max; if >2 items fail, the plan is the problem — replan
- This session runs only verification commands, never edits beyond trivial fixes