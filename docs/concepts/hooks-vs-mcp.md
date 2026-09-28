# Claude Code hooks vs MCP tools

ClawMem delivers memory through two tiers: hooks handle about 90% of context delivery automatically, while MCP server tools (available to any MCP-compatible client, not just Claude Code) cover the remaining 10% when the agent needs to escalate.

## Tier 2 — Hooks (automatic)

Hooks fire on Claude Code lifecycle events with zero agent effort:

| Hook | Trigger | Budget | What it does |
|------|---------|--------|-------------|
| `context-surfacing` | UserPromptSubmit | profile-driven (default 800 tokens + factsTokens sub-budget) | Searches vault for context relevant to the user's prompt. Injects results as `<vault-context>` XML with four inner blocks: `<instruction>` (framing — always present), `<facts>` (the surfaced docs), `<relationships>` (memory-graph edges between surfaced docs, v0.7.1), and `<vault-facts>` (raw SPO triples for prompt-seeded entities, v0.9.0 §11.1). A session focus file (v0.9.0 §11.4) steers snippet selection as presentation intent; since v0.38.0 it no longer changes scoring or ordering. |
| `postcompact-inject` | SessionStart (`compact` only) | 1200 tokens | Re-injects THIS session's pre-compaction state (claimed once, then deleted) plus recent vault decisions and antipatterns, framed as reference data rather than instructions. Startup, resume, clear and fork starts get nothing. |
| `curator-nudge` | SessionStart | 200 tokens | Surfaces maintenance suggestions from the curator report. |
| `precompact-extract` | PreCompact | — | Extracts the last typed request (never a tool result), decisions and open questions from prose, and file paths, before compaction. Stores it as the session's row in the vault's `compaction_state` table (15-minute lifetime). |
| `decision-extractor` | Stop | — | LLM extracts observations from the conversation. Infers causal links. Detects contradictions with prior decisions (judge-gated — requires `CLAWMEM_JUDGE_*`, v0.29.0). Extracts SPO triples from decision/preference/milestone/problem facts. |
| `handoff-generator` | Stop | — | LLM summarizes the session for cross-session continuity. |
| `feedback-loop` | Stop | — | Tracks which notes were referenced. Boosts their confidence. Per-turn recall attribution marks which surfaced docs were actually cited. |

### How context-surfacing works

1. Validate prompt (skip slash commands, greetings, heartbeats, duplicates)
2. Load performance profile (`speed` / `balanced` / `deep`) — token/facts budgets, result limit, vector behavior + timeout, deep escalation (its score thresholds apply only under the eval-only `CLAWMEM_ADMISSION_POLICY=composite` control arm)
3. **Resolve session focus topic** (v0.9.0 §11.4) — read `~/.cache/clawmem/sessions/<id>.focus` if present. If set, used as the snippet-selection `intent` only (presentation — since v0.38.0 a focus never reaches expansion, rerank, scoring, or ordering)
4. Search: vector (if profile enables it, with profile-driven timeout) + BM25 supplement
5. Filter: exclude private paths, snoozed documents, noise
6. Score: composite scoring (relevance + recency + confidence + quality)
7. Relevance admission on the final ordering key (band, fused mass — with query-level abstention)
8. Build facts block within `tokenBudget - instructionCost` so the always-on `<instruction>` frame fits
9. Fetch relationship snippets from `memory_relations` for edges where BOTH endpoints are in the surfaced doc set — these become a `<relationships>` block, the first thing dropped when the payload would overflow budget
10. **Seed entities from the prompt** (v0.9.0 §11.1) — three-path extraction (canonical-id regex → proper-noun validation via `resolveEntityTypeExact` → longer-first n-gram scan). Prompt-only: seeds NEVER come from surfaced doc bodies, so an off-topic surfaced doc cannot pollute the facts block
11. **Query SPO triples for seeded entities**, dedupe by `(subject, predicate, object)` across all entities, emit a token-bounded `<vault-facts>` block using the dedicated `factsTokens` sub-budget (speed=0 disables the stage, balanced=200, deep=250). Truncate at triple boundary, never mid-triple, never emit an empty block. Fail-open on every error path
12. Inject as `<vault-context><instruction>...</instruction><facts>...</facts><relationships>...</relationships><vault-facts>...</vault-facts></vault-context>` XML in the prompt

The `<instruction>` frame tells the model to treat the surfaced facts as background knowledge it already holds unless the user corrects them, reducing prompt-level ambiguity about how to use the injected context. The `<relationships>` block exposes the vault's knowledge graph (semantic, supporting, contradicts, causal, temporal edges) directly in-prompt so the model can reason over document connections without having to call `intent_search`. The `<vault-facts>` block adds raw SPO triples for prompt-seeded entities so the model has structured "what is currently true about these entities" without needing an explicit `kg_query`. `<vault-facts>` / `<relationships>` landed in v0.9.0 / v0.7.1 respectively.

### Tuning context-surfacing with profiles

Set `CLAWMEM_PROFILE` to adjust the context-surfacing hook's behavior:

| Profile | Token budget | `factsTokens` | Max results | Vector | Vector timeout | Score ratio | Activation floor | Deep escalation |
|---------|-------------|---------------|-------------|--------|----------------|-------------|-----------------|-----------------|
| `speed` | 400 | 0 (disabled) | 5 | Off | — | 65% | 0.24 | No |
| `balanced` (default) | 800 | 200 | 10 | On | 900ms | 55% | 0.20 | No |
| `deep` | 1200 | 250 | 15 | On | 2000ms | 45% | 0.16 | Yes |

`factsTokens` is a dedicated sub-budget for the `<vault-facts>` KG injection block (v0.9.0 §11.1) that cannot steal from the main `tokenBudget`. Setting `factsTokens: 0` on a profile disables the stage entirely.

The **Score ratio** and **Activation floor** columns apply only to the composite admission control arm (`CLAWMEM_ADMISSION_POLICY=composite` — eval-only since v0.38.0). The default relevance admission is profile-independent; see the next section.

Profiles only affect the automatic context-surfacing hook. MCP tools are not affected — agents control their own `limit`, `compact`, and tool selection per call.

### Relevance admission

Since v0.38.0 the hook's keep/drop decision is judged on the same channel-aware ordering key that orders the injection — never on the composite score. The fusion stage produces one key per candidate: a **band** (0 = supported by the current turn's own lanes; 1 = discounted-lane-only survivor) and a **mass** (its weighted reciprocal-rank fusion contribution). Admission then works per query:

1. **Query-level abstention** — if no candidate has current-turn support (band 0 empty), the hook emits nothing (`no-current-support`), unless the prior-turn leg was certified by the anaphora gate and is the only signal, in which case the certified-prior candidates are judged under their own relative floor. If band 0 exists but not a single candidate has keyword-class agreement (FTS found nothing — the vector-only junk signature of gibberish and abstract-register prompts), the hook abstains (`degenerate-basis`) rather than surface an arbitrary embedding-band list.

2. **Relative floor** — within band 0, a candidate is admitted when its fused mass is at least 50% of the top candidate's mass (`floorRatio 0.5`, per-basis in `ADMISSION_PARAMS`). Multi-lane agreement compounds mass, so vector-only tails fall below a keyword-agreed top without any absolute threshold. When band 0 exists, band-1 (discounted-only) candidates are never admitted.

This is distribution-relative by construction — rank-derived fusion mass is scale-free, so no absolute score-scale calibration (per vault size, embedding model, document quality, or content age) is needed. The relative floor ratio itself is a calibrated quantity: it is per-basis in `ADMISSION_PARAMS` (initially 0.5 across bases) and tuned by the judged evaluation, not user-tunable. The composite score retains **tier sizing only** (HOT/WARM/COLD snippet lengths). The pre-v0.38.0 composite gate (activation floor + best-score ratio per profile) survives solely as the eval control arm behind `CLAWMEM_ADMISSION_POLICY=composite`; the product default is `relevance`. MCP tools are unaffected — they use absolute `minScore` thresholds the agent controls directly.

### Deep escalation (deep profile only)

On the `deep` profile, context-surfacing runs a budget-aware escalation after the fast path (BM25 + vector lanes). Every deadline derives from the hook's authoritative internal budget (`CLAWMEM_HOOK_BUDGET_MS`, default 6000ms): the work deadline is the internal deadline minus a 500ms finalization reserve — a margin sized from measured payload-assembly cost and audited by the eval's invariant registry (a reserved, machine-validated margin, not an unconditional wall-clock guarantee; the write path that could stall left the handler entirely — see the CLI reference on spool commands). Escalation is entered only while both the profile's escalation window and the work deadline are open, and runs two phases:

1. **Query expansion** — the LLM generates lexical and semantic variants of the *current* prompt (never a concatenated multi-turn query). Variants run as discounted recall lanes (lex → FTS, vec/hyde → vector) and are re-fused through the same membership stage under the expansion mass cap and protected current-class slots — expansion can add candidates but can never outvote the user's actual question. The expansion transport carries a real deadline abort: on expiry the call is cancelled, not abandoned to hold the process open.

2. **Cross-encoder reranking** — the **complete** candidate pool is sent — a fixed top-N slice would make full *candidate* coverage structurally impossible. Per candidate the handler prepares a 2000-char projection, of which the store transmits the first 400 chars to the endpoint (sized to the reranker's 512-token query+document pair context); the cache key and the eval's transmitted-text manifest identify exactly that transmitted projection. An applied rerank requires two contracts: **full coverage** (a partially-covered pool is never partially reordered — the store throws on incomplete live coverage and the failure guard arbitrates instead) and **discrimination** (the per-request degeneracy gate discards collapsed or near-constant score sets — `CLAWMEM_RERANK_DEGENERACY_GATE`). A passing rerank joins the final order as one more rank-fused lane (`CLAWMEM_RERANK_LANE_WEIGHT`, default 1.5): it adds mass *within* the bands and never elevates a candidate's band — coverage proves the reranker answered, not that it outranks current-turn support.

If GPU services are unavailable, either phase times out, or the rerank fails its contracts, the hook falls back to the fused fast-path order. The effect: `deep` results approach what the `query` MCP tool returns (which always runs expansion + reranking), while `speed` and `balanced` stay on the fast path.

### Session focus topic (v0.9.0 §11.4; scoring boost removed in v0.38.0)

The session focus topic is a per-session presentation bias for context-surfacing, declared for the duration of a working session without writing to SQLite or mutating any lifecycle column. Use it when the user asks to focus on one thing ("let's focus on the auth refactor for this session") — the topic threads through the pipeline as an `intent` hint while leaving the underlying vault state untouched. Clearing the focus at the end of the subsession returns surfacing to baseline.

Set / show / clear with the CLI:

```bash
clawmem focus set "authentication flow" --session-id abc123
clawmem focus show --session-id abc123
clawmem focus clear --session-id abc123
```

The session ID is resolved from `--session-id <id>`, then `CLAUDE_SESSION_ID`, then `CLAWMEM_SESSION_ID` — Claude Code exposes `CLAUDE_SESSION_ID` natively so the env-var path works automatically inside a Claude Code session. The focus file lives at `~/.cache/clawmem/sessions/<session_id>.focus`.

When a focus topic is active:

- **Snippet selection only** — the topic is passed as `intent` to `extractSnippet`, so snippet extraction prefers sentences containing the topic tokens. It is NOT passed to `expandQuery` or `rerank` (v0.38.0): expansion variants change candidate membership and rerank intent changes fused mass/order, so a session preference reaching either would cross into scoring/ordering.
- **No scoring or ordering effect** — the post-composite-score topic boost (1.4× match / 0.75× demote) was DELETED in v0.38.0: the final order is the channel-aware fusion key and admission is judged on that same key, so a composite multiplier crossing into presentation was a metadata signal the ordering contract forbids. A matching topic changes snippet selection only; the surfaced set and its order are byte-identical with or without a focus.
### Hook blind spots

Hooks filter aggressively — they enforce score thresholds, cap token budgets, and exclude system artifacts. If a memory exists but wasn't surfaced in `<vault-context>`, it doesn't mean it's missing from the vault. It means it didn't make the top-k cut for this prompt.

## Tier 3 — MCP Tools (agent-initiated)

The agent should escalate to MCP tools only when one of three rules fires:

1. **Low-specificity** — `<vault-context>` is empty or missing the specific fact needed
2. **Cross-session** — the task references prior sessions or decisions ("why did we decide X")
3. **Pre-irreversible** — about to make a destructive or hard-to-reverse change

### Preferred entry point

Use `memory_retrieve(query)` — it auto-classifies the query and routes to the optimal backend:

- "why did we decide X" → intent_search (causal graph traversal)
- "what happened last session" → session_log
- "what else relates to X" → find_similar (vector neighbors)
- complex multi-topic → query_plan (parallel decomposition)
- general recall → query (full hybrid pipeline)

### Direct routing (when you know which tool to use)

| Query type | Tool | Why not query()? |
|-----------|------|-----------------|
| Why / what caused / decision | `intent_search` | Graph traversal finds causal chains query() can't |
| Last session / yesterday | `session_log` | Session-specific data not in search index |
| What else relates to X | `find_similar` | k-NN vector neighbors, not keyword overlap |
| Entity facts / relationships | `kg_query` | Structured SPO triples, not document search |
| Complex multi-topic | `query_plan` | Decomposes into typed parallel retrieval |
| General recall | `query` | Full hybrid: BM25 + vector + expansion + reranking |
| Keyword spot check | `search` | BM25 only, zero GPU cost |
| Why did X outrank Y | `memory_rank` | Per-factor composite breakdown + raw-vs-composite rank shifts — a diagnostic, not retrieval (v0.36.0) |
| Conceptual / fuzzy | `vsearch` | Vector only, semantic similarity |

`diary_write` and `diary_read` are for non-hooked environments only (Hermes, Gemini, plain MCP clients). In Claude Code, hooks capture observations and handoffs automatically.

### Anti-patterns

- Do NOT call MCP tools every turn — the three rules above are the only gates
- Do NOT re-search what's already in `<vault-context>`
- Do NOT use `query()` for "why" questions — use `intent_search` or `memory_retrieve`
- Do NOT use `query()` for session history — use `session_log`
- Do NOT use `kg_query()` for causal "why" questions — use `intent_search`. `kg_query` returns structured facts, not reasoning chains
- Do NOT use `diary_write` in Claude Code — hooks handle this automatically

## Why hooks handle 90%

The 90/10 split between hooks and MCP tools is a deliberate architectural response to a real limitation: agents are not reliably proactive with memory tools.

When an agent has both native tools (Read, Grep) and memory tools (query, intent_search) available, it will consistently default to the simpler native tools or answer from existing context — even when a vault search would produce better results. This isn't a bug in any particular model. MCP tool calls add latency and consume context window. The agent's implicit cost/benefit calculation favors "answer now" over "search first, answer better." The result is that purely agent-initiated memory systems get underused in practice.

Hooks bypass this problem entirely. Context-surfacing fires on every prompt regardless of what the agent decides to do. Decision-extractor captures observations after every response. Feedback-loop tracks what was referenced. The agent doesn't get to skip these — they run as part of the Claude Code lifecycle, not as tool calls the agent can choose to make.

The remaining 10% — the MCP tools — covers situations where hooks can't help: the agent needs deeper search than what context-surfacing provided, the question spans multiple sessions, or a destructive action needs a vault check first. These genuinely require agent initiative, and the 3-rule escalation gate keeps the scope narrow enough that agents can follow it.

### Making agents more proactive

For the proactive operations agents should be doing (pinning critical decisions, snoozing noisy context, running deeper searches when surfaced context is relevant but thin), instruction redundancy helps. Place the routing rules and escalation gates in your global CLAUDE.md or AGENTS.md so they load on every conversation. The trigger block in the README's [Agent Instructions](../README.md#agent-instructions) section is designed for this — it gives the agent routing rules always loaded, with SKILL.md as on-demand deep reference.

This stubbornness around proactive memory tool use is unlikely to change until model providers include memory management patterns in their training data. Until then, hooks carry the weight, and instruction redundancy is the best mitigation for the rest.
