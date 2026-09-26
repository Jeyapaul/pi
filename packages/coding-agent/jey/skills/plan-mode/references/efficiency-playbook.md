# Efficiency Playbook (loaded on demand)

Deeper guidance for large or multi-file plans. Read only when the plan spans ≥5 files, touches build/test infra, or the user asks why a choice is more efficient.

## Why these rules matter (mechanics)

- **Turns are the multiplier.** Each turn re-pays the whole context as (mostly cached) input and adds your output. 10 small turns cost more than 3 batched turns even at cache-read rates (0.1x) because output tokens (~5x input) and fresh-input segments dominate.
- **Tool outputs are permanent context.** A 500-line file read costs input tokens on every subsequent turn until compaction. Grep with line numbers + ranged reads keep context small.
- **Cache hits need a stable prefix.** Nothing you do invalidates the cache by appending, but huge mid-session context bloat pushes turns past cache TTLs and past auto-compaction thresholds (which trigger an extra summarization LLM call). Small context = fewer compactions = fewer hidden turns.

## Parallel batching patterns

Batch these in one turn:
- All Phase-1 exploration reads/greps (independent by construction)
- Multiple independent file edits in Phase 4 (e.g., "add import to A, add route to B, update config C")
- Run tests + lint together after the final step

Never batch: edits to the same file (sequential dependencies), a read needed to decide the next call, verification of a step that later steps depend on.

## Model / effort strategy (user-side, not agent-side)

- Plan phase benefits from high reasoning effort; execution mostly follows instructions. If the user switches effort or models mid-session (Ctrl+P), the plan's file:line targets let a cheaper/faster model execute without re-exploration — that is why exact targets are mandatory in Phase 3.
- If executing on a weaker model: keep Phase-4 injected plan text (the approved plan) in the message; do not summarize it away.

## Verification design

One command, whole plan. Prefer the fastest signal:
1. Typecheck/build if available (`tsc --noEmit`, `go build`, `cargo check`)
2. Targeted test subset (`rg -l` changed files → their test files), not the full suite
3. Full suite only when the plan touches shared/core infrastructure

## Failure handling

- A failed verification: fix and re-run once. If it fails twice, STOP, report the failure + last diff, and ask — a third blind attempt usually costs more than a human glance.
- Discovered mid-execution that the plan is wrong? Stop, state the delta in ≤5 lines, get one confirmation, continue. Do not silently improvise multi-file changes.
