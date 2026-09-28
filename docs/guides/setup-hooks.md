# Setting up Claude Code hooks

Claude Code hooks give ClawMem automatic context injection and extraction on every prompt and response. This is the primary integration path for Claude Code memory.

## Install default hooks

```bash
clawmem setup hooks
```

This installs hooks into `~/.claude/settings.json`:

| Hook | Event | Timeout | Purpose |
|------|-------|---------|---------|
| `context-surfacing` | UserPromptSubmit | 8s | Search vault, inject relevant context |
| `curator-nudge` | SessionStart | 5s | Surface maintenance suggestions |
| `postcompact-inject` | SessionStart (matcher `compact`) | 5s | Re-inject this session's state after compaction |
| `precompact-extract` | PreCompact | 5s | Preserve state before compaction |
| `decision-extractor` | Stop | 30s | Extract observations from conversation |
| `handoff-generator` | Stop | 30s | Summarize session for continuity |
| `feedback-loop` | Stop | 30s | Track referenced notes, boost confidence |

`decision-extractor` runs its model-bearing phases under an internal whole-handler
budget, `CLAWMEM_STOP_BUDGET_MS` (default 25000 ms), so it finishes and persists
before the host's 30s Stop timeout kills it. If you raise the budget, raise the
installed hook `timeout` too — the host timeout must always exceed the budget
plus a safety margin ([configuration](../reference/configuration.md)).

## Manual install (full reference)

If you prefer to configure hooks manually instead of running `setup hooks`, add this to `~/.claude/settings.json`. Replace `/path/to/clawmem` with your actual install path (e.g. `~/.bun/bin/clawmem` or `~/clawmem/bin/clawmem`). Each event holds a list of groups, and each group is `{matcher, hooks: [...]}`; Claude Code does not run a handler placed directly in the event list. `postcompact-inject` needs its own SessionStart group with matcher `compact`, because SessionStart also fires on startup, resume, clear and fork:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "CLAWMEM_HOOK_BUDGET_MS=6000 /path/to/clawmem hook context-surfacing", "timeout": 8 }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          { "type": "command", "command": "/path/to/clawmem hook postcompact-inject", "timeout": 5 }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/clawmem hook curator-nudge", "timeout": 5 }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/clawmem hook precompact-extract", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/clawmem hook decision-extractor", "timeout": 30 },
          { "type": "command", "command": "/path/to/clawmem hook handoff-generator", "timeout": 30 },
          { "type": "command", "command": "/path/to/clawmem hook feedback-loop", "timeout": 30 }
        ]
      }
    ]
  }
}
```

## Remove hooks

```bash
clawmem setup hooks --remove
```

## Available but not default

These hooks exist but are not installed by default:

| Hook | Event | Why not default |
|------|-------|----------------|
| `session-bootstrap` | SessionStart | Redundant with `context-surfacing` for most setups. Useful for heavy bootstrap context on session start. |
| `staleness-check` | SessionStart | Can add latency on session start. Useful for surfacing stale document alerts. |

To add them, append a group to the `SessionStart` array in the config above:

```json
{
  "matcher": "",
  "hooks": [
    { "type": "command", "command": "/path/to/clawmem hook session-bootstrap", "timeout": 5 },
    { "type": "command", "command": "/path/to/clawmem hook staleness-check", "timeout": 5 }
  ]
}
```

## Compaction hooks

`precompact-extract` (PreCompact) and `postcompact-inject` (SessionStart, `source: "compact"`) bracket a context
compaction.

- PreCompact extracts the last request the user typed, decisions and open questions from the conversation's prose,
  and the files touched. It stores them as that session's row in the vault's `compaction_state` table.
- Before it opens the vault, PreCompact registers its attempt in a small database beside the vault
  (`<vault>-compaction.sqlite`), which only the two compaction hooks write. That registration supersedes every earlier attempt of the session. So a PreCompact that
  fails after it (a busy vault, an unreadable transcript, nothing extracted, the host's timeout) leaves no snapshot
  to be injected, and an older PreCompact, whether it resumes before or after a newer one stored its state, stores
  nothing. The one case it cannot cover is a disk that refuses the registration and the vault write both: nothing
  can be marked stale without a write.
- The compaction's SessionStart consumes the registration, then takes the row carrying it (reads and deletes it in
  one statement), and injects it once as `<vault-postcompact>` with recent vault decisions. If a newer PreCompact
  of the session registered while the take waited for the vault, or the registration database cannot be read,
  nothing is injected. A state older than 15 minutes is never injected, and a SessionStart for startup, resume,
  clear or fork injects nothing.
- The block is framed as reference data extracted by pattern matching, not as instructions, and every field in it is
  filtered and flattened to one line.
- This relies on Claude Code sending the same `session_id` to PreCompact and to the SessionStart that follows it,
  which is the documented meaning of the field on both events.

**Upgrading from v0.39.x or earlier.** Those versions wrote one `precompact-state.md` per project into Claude Code's
memory directory (`~/.claude/projects/<project>/memory/`) and read it back on every session start in that project.
Four steps:
- Upgrade every ClawMem process that shares the vault: the hooks, the watcher, the MCP server in every open
  session, and the OpenClaw or Hermes plugin. What follows is what an upgraded process does. An older one still
  running keeps its own behaviour until it is upgraded or stopped: it writes and reads the files, injects them,
  and enriches notes from them.
- Re-run `clawmem setup hooks` to move `postcompact-inject` into its own `compact` group. The hook already ignores
  other starts, so this only stops a wasted process launch.
- `clawmem doctor` lists any leftover `precompact-state.md` files. An upgraded ClawMem uses them for nothing; only
  the doctor (to list them) and the indexer (to retire their copies) look at them. Delete them.
- ClawMem recognises those files by the header the old versions wrote. In an upgraded process, search, retrieval,
  globs and the default REST export never return an indexed copy, and enrichment and embedding never read one,
  whatever version indexed it and whether or not the vault has been re-indexed since. `get` by the copy's exact
  path or docid still returns it. An A-MEM note that a copy shaped, or that an older process evolved after the
  upgrade, is never read by an upgraded process's enrichment prompts; it is cleared at the next writable open or
  background pass and rebuilt from the note's own text by the light-lane backfill (`CLAWMEM_ENABLE_CONSOLIDATION=true`,
  in the watcher or the MCP server). A note indexed from a file is also rebuilt when the file changes, or by
  `clawmem reindex --enrich`; one that hooks or the API wrote has no other rebuild path, so without the light lane
  it stays without an A-MEM note (search and injection never use one). The indexer never indexes a copy again and deactivates each
  one whose file it finds, and `clawmem doctor` lists the copies still active. `clawmem doctor` also shows red
  while an older ClawMem keeps writing the files. A file with that name and your own content is indexed as usual.

## Timeouts

All hooks use Claude Code's native `timeout` property (in seconds). Stop hooks use 30s to allow LLM inference to complete; other hooks use 5-8s.

The `context-surfacing` host timeout is derived, not fixed (v0.38.0): `clawmem setup hooks` writes `timeout ≥ ceil((1.5s startup allowance + CLAWMEM_HOOK_BUDGET_MS) / 1000)` and pins the budget into the installed hook command's env prefix, so the installed hook always runs under the budget its timeout was sized for. An existing larger host timeout is preserved (never reduced). `clawmem doctor` verifies the inequality and shows red when the host would kill the hook before its internal deadlines can act. It checks every installed `context-surfacing` entry, and it can read the budget only in the form `setup hooks` writes — a leading `CLAWMEM_HOOK_BUDGET_MS=<n>` assignment before the executable. Any other form (a quoted or escaped value, a shell expansion, `env`/`export`, an assignment after the executable) is reported red as UNVERIFIED, because the value the shell passes cannot be checked. Entries that pin different budgets are a red CONFLICT, and more than one entry is flagged because each runs on every prompt.

**Do not use shell `timeout` wrappers** (e.g., `timeout 10 clawmem hook ...`). When shell `timeout` kills a process, it exits with code 124 and no stderr, which Claude Code reports as "Stop hook error: Failed with non-blocking status code: No stderr output". The native `timeout` property is handled gracefully by Claude Code's hook runner.

## Deduplication

The `context-surfacing` hook suppresses duplicate prompts using SHA-256 hashing with a 600-second window (`hook_dedupe` table). Heartbeat prompts are also detected and skipped.

The Stop-event hooks (`decision-extractor`, `handoff-generator`, `feedback-loop`) use `saveMemory()` which enforces a 30-minute normalized content hash dedup window, preventing duplicate observations across concurrent or rapid sessions.

## What the Stop hooks write

`decision-extractor` does more than persist observations: when a contradiction **judge** is
configured (`CLAWMEM_JUDGE_*`, v0.29.0 — disabled otherwise), it classifies each session's new
facts against the memories they resemble, and a `contradiction` verdict lowers the older
document's confidence by 0.25 (floored at 0.2). That is a ranking signal — the document stays
retrievable.

When erosion reaches the floor the hook can additionally set `invalidated_at`, which removes the
document from FTS and vector retrieval outright. **That step is off by default** — it logs
`WOULD invalidate` and writes nothing until you set `CLAWMEM_CONTRADICTION_INVALIDATE=true`. How
much it would affect your vault depends on your confidence distribution and content-type mix, so
measure before arming: [contradiction invalidation](contradiction-invalidation.md).

## Adding custom hooks alongside ClawMem

If you add your own hooks to `~/.claude/settings.json` alongside ClawMem's (e.g., a custom Stop hook for context management), every code path in your script must output valid JSON to stdout. Claude Code treats a hook that exits 0 with no stdout as an error.

Use this pattern:

```bash
#!/bin/bash
OK='{"continue":true,"suppressOutput":false}'
input=$(cat)

# Every early return must output JSON
transcript=$(echo "$input" | jq -r '.transcript_path // empty')
if [[ -z "$transcript" ]]; then
    echo "$OK"; exit 0
fi

# ... your logic ...

# Default path must also output JSON
echo "$OK"
```

ClawMem's built-in hooks handle this automatically. This only applies to custom scripts you add to the same hook events.

## Profile integration

`context-surfacing` reads `CLAWMEM_PROFILE` to configure its token budget, max results, vector timeout, `factsTokens` sub-budget, and deep escalation (query expansion + reranking on the `deep` profile). Since v0.38.0 the keep/drop decision is the profile-independent relevance admission — the per-profile score thresholds are consulted only by the eval-only composite control arm (`CLAWMEM_ADMISSION_POLICY=composite`). See [Tuning context-surfacing with profiles](../concepts/hooks-vs-mcp.md#tuning-context-surfacing-with-profiles).
