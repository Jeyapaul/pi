---
name: advise-mode
description: How to use the advisor agent (calibrated decision gates) correctly. Use via /skill:advise or /skill:advise-mode, or whenever choosing whether/how to ask the advisor before a decision — research sufficiency, implementation conformance, routing, triage.
---

# Advise Mode (calibrated decision gates)

The advisor answers typed questions about text you give it — probabilities, no prose. It is a judge of what you hand it, nothing more: no file access, no generation, no authority over decisions.

## When to ask (and when not to)

Ask at handoff points where being wrong is expensive and reviewing inline is expensive: research sufficiency, implementation conformance, multi-option routing, triage. Do NOT ask: questions needing file access (feed the text yourself), anything a `read` answers better, final accept/reject of work (that's the orchestrator's call), judgment on <200 tokens (you're cheaper than the round-trip).

## Question design (the whole skill is this)

- `noul` — "is X true?" → phrased as a concrete, evidence-checkable claim. Bad: "is the research good?" Good: "The digest answers question 2 ('which library does X') with a named library and a source URL"
- `choice` — options must be mutually exclusive and jointly exhaustive; write a one-line description per option; include an escape hatch option ("escalate to user") when unsure-is-possible
- `score` — 0..1 degree questions; define what 0 and 1 mean ("0 = item untouched; 1 = item fully implemented and verified")
- One question = one claim. Never bundle two checks into one question.
- Feed state, not vibes: include the digest/verification output the judgment depends on, ≤30k tokens. Missing evidence → the advisor guesses confidently and you get noise.

## Thresholds

- confidence ≥ 0.7 → act on the answer
- 0.4–0.7 → ⚠ low: narrow it — ask a follow-up with more evidence, or decide it yourself
- < 0.4 or "advisor unavailable" → fail-open: decide without it, and say you did
- Track patterns: the same question type failing repeatedly means the template is bad, not the advisor

## Anti-patterns (never)

- Asking it to generate text, plans, or code — wrong tool
- Trusting a bare number without reading the confidence
- Using it to approve its own earlier judgment (circular)
- Paying for a judgment you already made