# Agent-Team Pipeline Topologies

Documented for future evolution. Current implementation = B with C flagged off. (D, E documented; not built.)

## A. Strict waterfall
`research → plan → implement → verify → done`
Simplest; one miss costs a full restart. Not implemented (loops added).

## B. Waterfall + re-task loops  ← CURRENT
```
research ←─advisor:"insufficient"─┐
   ↓                              │
 plan → [user approves] → implement ←─advisor/conformance:"item N failed"─┐
                             ↓                                            │
                           verify ─pass→ done ←───────────────────────────┘
```
- Two loops: research re-tasked narrowly (only unanswered questions, max 1 re-task);
  implementation re-tasked per item (mechanical slip → same child retries once;
  structural failure → back to plan-mode)
- One child at a time; budgets per child (maxCostUsd, timeoutMin)

## C. Plan-parallel fan-out  ← FLAGGED, default off
```
plan → disjoint work items → [implement#1 ∥ implement#2 ∥ …] → merge → verify
```
- Requires: disjointness proof per item (file:line targets from plan-mode), same-tree
  execution if provably disjoint, else `git worktree add` per child + merge
- Trigger idea: implement-mode Phase 2 marks independent items; a setting
  `agentTeam.parallel: true` fans them out. Build after B proves stable.

## D. Speculative race (policy, not topology)
```
item → [implement via model X ∥ model Y] → advisor/orchestrator picks winner
```
- 2× cost per raced item; doubles as continuous model A/B benchmark
- Add as per-task policy once C exists: `agentTeam.race: {implement: ["id1","id2"]}`

## E. Long-lived asynchronous agents (RPC mode)
```
orchestrator ⇄ persistent research session ⇄ persistent implement session
   (pi --mode rpc / SDK: streaming, interrupts, mid-flight steering)
```
- Sub-agents become processes that can ask questions back and accumulate project
  knowledge across tasks. Endgame; blocked on pi's experimental RPC surface stabilizing.

## F. Hierarchical lead-per-phase
`orchestrator → phase-lead → mini-team` — coordination overhead exceeds gains at this
scale; not planned.

## Advisor placement (topology-invariant)
Gates sit on EDGES, not inside stages: post-research sufficiency, post-implementation
per-item conformance, pre-fan-out disjointness (C). Changing topology never changes
the advisor interface.