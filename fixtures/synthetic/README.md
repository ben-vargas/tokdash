# Synthetic edge-case fixtures

Hand-authored ccusage outputs that real captures under `fixtures/real/` do not (or cannot reliably)
produce. Each one exists to **force a specific behavior** in the normalizer / merger / zero-fill /
schema layers. Shapes match the real ccusage v20 dialects verified in `PROMPT.md` §2.3 and cross-checked
against `fixtures/real/*` on 2026-07-02.

Field-shape cheat sheet (what the code must tolerate):
- **Unified `daily`/`monthly`** → `{ daily|monthly: [...], totals }`; rows use **`period`**, `agent:"all"`,
  `metadata.agents`, `modelsUsed`, `modelBreakdowns`.
- **Unified `session`** → `{ session: [...], totals }` (**`session` is singular**); rows use `period` = session id,
  `agent` = real harness name, `metadata` = `{lastActivity[, projectPath|reasoningOutputTokens]}` — **absent** for
  hermes/droid/gemini rows.
- **Per-agent dailies** use different dialects: claude/hermes key by **`date`**; codex keys by `date` + **`costUSD`**
  + `models` object; hermes has **no `modelBreakdowns`**.
- `totals` = `{inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, totalCost}`
  (codex uses `costUSD` in totals too).

> **Note — `totalTokens` is authoritative, not derived.** In real ccusage output (and therefore in the
> hermes fixtures here, which use verbatim real numbers) `totalTokens` is frequently **larger** than
> `inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens` — the remainder is reasoning/other
> buckets ccusage folds into the total but does not break out. Code must use the reported `totalTokens`
> and never assume it equals the sum of the four visible classes.

| Fixture | ccusage shape it mimics | What it is | Behavior it must force |
|---|---|---|---|
| `empty-data.json` | unified `daily` | Empty `daily: []` with all-zero `totals`. | Zero-fill / empty-state path: KPIs render `$0` / "—", charts show an elegant empty state, **no crash** and no divide-by-zero in daily-average / projection math. |
| `single-day.json` | unified `daily` | Exactly one day (2026-06-15), two agents, two models. | Degenerate single-point range: charts must still render one zero-filled bar/point; previous-period comparison for a 1-day window must degrade to "—" (prior period not covered), not throw. |
| `zero-usage-gaps.json` | unified `daily` | 4-week window (2026-06-01…-06-28) with only **5** days present; 23 days omitted. | **Zero-fill**: every missing day in the continuous date axis is filled with `$0`; `active days = 5`; daily-average divides by calendar days in range, not by present rows. |
| `unknown-agent.json` | unified `session` | Session rows whose `agent` is **`warpspeed`** (not in the 15-harness allowlist) mixed with a `claude` row. | Unknown harness must **degrade with a warning**, still aggregate its cost, and surface a harness chip — never be dropped or crash the agent-attribution path. |
| `unknown-agent-daily.json` | unified `daily` | A daily row whose `metadata.agents` contains **`warpspeed`**. | The harness-discovery path (chips = agents seen *anywhere*, incl. `metadata.agents`) must accept the unknown name; validation stays permissive. |
| `unknown-dialect.json` | per-agent daily (fallback) | A made-up agent (`goose`) dialect: keyed by **`period`** (not `date`), cost as **`costUSD`**, models as **`modelList`**, plus passthrough extras (`provider`, `region`, `sessionsCount`, `wireVersion`). | Exercises the **permissive fallback adapter**: `date`-or-`period`, `totalCost`-or-`costUSD`, `.passthrough()` unknown fields, log-and-degrade rather than crash. |
| `malformed.json` | unified `daily` (truncated) | **Invalid JSON** — output cut off mid-object (as if the SSH pipe was severed). | `JSON.parse` must be caught → that host/command **degrades with warning** to its last snapshot with a visible error state; must **not** take down the dashboard or other hosts. |
| `hermes-missing-metadata.json` | unified `session` | Two `hermes` rows with **no `metadata` key at all** interleaved with one `claude` row that has it. | Session schema must model `metadata` as **optional/`.nullish()`**, not `.nullable()` alone — otherwise every keyless hermes row is rejected. This is the exact case that silently drops all buildbox hermes sessions. |
| `duplicate-day-hostA-daily.json` + `duplicate-day-hostB-daily.json` | unified `daily` ×2 hosts | Two host snapshots covering the **same** dates (2026-06-01, -06-02) with different agents/models. | Cross-host **additive merge**: hosts are independent, so per-day costs must **ADD** (never dedup). Expected merged `totalCost`: 2026-06-01 = **141.252521** (A 125.5 + B 15.752521), 2026-06-02 = **94.695894** (A 60.25 + B 34.445894); grand total **235.948415**. |
| `huge-cache-read.json` | unified `daily` | `cacheReadTokens` of ~82 billion and ~47 trillion; costs with long float tails (`82.06393750000001`, `39.6598589700001`). | Full-precision aggregation (summed `totalCost` = `121.72379647000011`, itself a long tail) + number formatting that survives 11–14-digit token counts (tabular-nums, no overflow, round only at display). |
| `claude-dialect.json` | `claude daily` | Minimal claude per-agent daily: keyed by **`date`**, `totalCost`, `modelsUsed`, `modelBreakdowns`, no `agent`/`metadata`. | Golden input for the **claude normalizer** (`date` → `period` mapping). |
| `codex-dialect.json` | `codex daily` | Minimal codex per-agent daily: **`costUSD`** (not `totalCost`), **`models`** object (not `modelsUsed`), `reasoningOutputTokens`, `isFallback` flag. | Golden input for the **codex normalizer** (`costUSD` → cost, `models` object → model list). |
| `hermes-dialect.json` | `hermes daily` | Minimal hermes per-agent daily: `date`, `messageCount`, `modelsUsed`, **no `modelBreakdowns`**. | Golden input for the **hermes normalizer**; also proves per-day model stacking must fall back to a single "hermes — no model data" band. Reproduces the `totalTokens > sum(4 classes)` property (real numbers). |

All files except `malformed.json` are valid JSON and internally consistent (row token classes and `totalCost`
sum to `totals`, except the intentional `totalTokens` remainder noted above). `malformed.json` is intentionally
un-parseable.
