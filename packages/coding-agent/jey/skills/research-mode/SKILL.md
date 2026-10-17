---
name: research-mode
description: Token-efficient delegated research workflow. Use when the user asks to research, investigate, compare options, or gather facts — via /skill:research or /skill:research-mode. Delegates bulk web/library/code research to the research agent (own model, own context), gates results with the advisor, and returns only a curated synthesis into this session.
---

# Research Mode (delegated, token-efficient)

Principle: this session stays small. Bulk reading happens in the research agent's context, never here.

## Phase 1 — Scope (1 turn, 0 tool calls)

Produce a research brief: 3–6 concrete questions, priority order, what "answered" looks like, scope limits (time, sources, recency). If the user's ask is ambiguous (audience? depth? deliverable?), ask ONE numbered clarify list first — nothing else.

## Phase 2 — Delegate (1 tool call)

Call `spawn_research_agent` with the brief as `task`, embedding the questions verbatim. Do NOT research inline — if a child fails or budgets out, re-task it with a *narrower* brief (only the unanswered questions), never the whole thing again. Max 2 re-tasks.

## Phase 3 — Advisor sufficiency gate (1 tool call)

Call `advise` with state = (brief + digest from result) and questions:
- one `noul` per brief question: "The digest answers this with concrete evidence"
- one `noul`: "Every claim in the digest is attributed to a source"

Advisor unavailable? Judge it yourself and say so. Any answer with confidence < 0.6 or "not answered" → back to Phase 2 with a narrower re-task.

## Phase 4 — Synthesize (0–1 tool calls)

Read the full artifact (`read` the report path) ONLY if the advisor flagged gaps or the user needs depth. Produce the final answer here: findings grouped by question, each with its source URL, plus open questions. Never paste the raw report into the conversation.

## Budgets
- 2 spawn calls max (initial + 1 re-task) per research cycle
- This session never calls internet_search/internet_scrape directly in this mode — delegation is the point
- Artifact path is the durable output; cite it for future sessions