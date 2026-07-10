# TokDash — Design Brief

This is the visual specification for the TokDash frontend. The Phase-3 builder implements it; the
Phase-5 design reviewer judges the shipped UI against it. Where this document gives a value, use
that value. Where it gives a rule, any deviation needs a stated reason in code comments.

**Intended impression:** a calm, dense, professional cost-analytics product — the confidence of
Linear, the restraint of Vercel, the data seriousness of Grafana Cloud. Dark, slightly warm,
hairline-bordered, money-first. A visitor should be able to read last month's spend in under two
seconds and never once think "admin template."

Money is the hero everywhere: cost leads every card, every table sorts by cost by default, tokens
are the supporting act.

---

## 1. Design tokens

All colors are CSS custom properties on `:root` (dark, the default) and `.light` (or
`[data-theme="light"]`). Components reference **only semantic tokens** — never raw hex in
component code. Map these into Tailwind v4 via `@theme` so utilities like `bg-surface` exist.

### 1.1 Dark theme (default)

Warm neutral scale — hue ~30° (brown-leaning), saturation 3–6%. Never pure black, never pure gray.

```css
:root {
  /* surfaces */
  --bg:              #131211;  /* page background */
  --surface:         #1b1918;  /* cards, filter bar, table containers */
  --surface-raised:  #232120;  /* dropdowns, dialogs, tooltips, hover rows */
  --surface-hover:   #262322;  /* interactive hover fill on surface */
  --surface-inset:   #0f0e0d;  /* code/mono wells, sparkline track */

  /* borders */
  --border-hairline: #2c2927;  /* 1px card & divider borders */
  --border-strong:   #3d3936;  /* inputs, focused-adjacent, chip outlines */

  /* text — muted carries data (axis ticks, chip costs, captions) and must
     clear WCAG AA 4.5:1 on every dark surface: #918980 is 5.43:1 on --bg,
     5.08:1 on --surface, 4.65:1 on --surface-raised. disabled is
     decorative-only (WCAG-exempt) and stays low-contrast by design. */
  --text-primary:    #f2efec;
  --text-secondary:  #b3aca4;
  --text-muted:      #918980;
  --text-disabled:   #55504a;

  /* the ONE accent — interaction chrome only, never a data series */
  --accent:          #5a9df6;
  --accent-hover:    #7ab2f8;
  --accent-muted:    rgba(90, 157, 246, 0.14);  /* selected fills */
  --focus-ring:      rgba(90, 157, 246, 0.55);

  /* semantics */
  --positive:        #57c785;  /* spend went DOWN / success */
  --positive-muted:  rgba(87, 199, 133, 0.14);
  --negative:        #e5695e;  /* spend went UP / errors */
  --negative-muted:  rgba(229, 105, 94, 0.14);
  --warning:         #e0b25f;  /* stale, approximate */
  --warning-muted:   rgba(224, 178, 95, 0.14);

  /* charts */
  --chart-grid:      #262322;  /* horizontal gridlines */
  --chart-axis:      #918980;  /* tick label fill = text-muted */
  --chart-cursor:    rgba(242, 239, 236, 0.05); /* hover band behind bars */
}
```

### 1.2 Light theme

Warm paper, not clinical white-gray. Same token names.

```css
.light {
  --bg:              #faf9f7;
  --surface:         #ffffff;
  --surface-raised:  #ffffff;   /* differentiated by shadow, §5.2 */
  --surface-hover:   #f4f2ef;
  --surface-inset:   #f2f0ec;

  --border-hairline: #e8e4de;
  --border-strong:   #d5cfc7;

  --text-primary:    #1c1917;
  --text-secondary:  #57534e;
  --text-muted:      #78726a;  /* AA: 4.52:1 on --bg, 4.76:1 on white */
  --text-disabled:   #b8b2a9;

  --accent:          #2e6fd8;
  --accent-hover:    #2258b4;
  --accent-muted:    rgba(46, 111, 216, 0.10);
  --focus-ring:      rgba(46, 111, 216, 0.45);

  --positive:        #1a7f4b;
  --positive-muted:  rgba(26, 127, 75, 0.10);
  --negative:        #c23b2e;
  --negative-muted:  rgba(194, 59, 46, 0.10);
  --warning:         #9a6b0a;
  --warning-muted:   rgba(154, 107, 10, 0.12);

  --chart-grid:      #ece8e2;
  --chart-axis:      #78726a;
  --chart-cursor:    rgba(28, 25, 23, 0.04);
}
```

### 1.3 Delta semantics — deliberate decision

This is a **cost dashboard**: more spend is bad.

- **Cost-like KPIs** (`totalCost`, `totalTokens`, `dailyAverageCost`): a positive delta
  (`deltaPercent > 0`) renders in `--negative` (red badge, `▲` glyph); a negative delta renders in
  `--positive` (green badge, `▼` glyph). Zero delta: neutral gray badge (`--text-muted` on
  `--surface-hover`), "+0%".
- **Neutral KPIs** (`activeDays`): always the neutral gray badge with `▲`/`▼` direction glyph —
  more active days is neither good nor bad.
- `--positive`/`--negative` therefore mean "good/bad," **not** "up/down." Never use raw
  green-for-plus logic anywhere.
- Errors, failed hosts, failed test-connections use `--negative`; staleness and approximation use
  `--warning`; success confirmations use `--positive`.

### 1.4 Accent discipline

One accent. It is used for: focus rings, links, the active date-preset segment, toggle/switch "on"
tracks, primary buttons, text-input focus borders, the refresh button spinner. It is **never** a
chart series, chip identity, or badge color. Data identity comes exclusively from the categorical
system in §2. (The accent is intentionally a clear azure — distinct in hue from all three host
colors and all eight harness colors.)

---

## 2. Categorical color system

Three independent palettes. **Rule: only one categorical palette is ever visible inside a single
chart** (stack dimension is host OR harness OR model), so distinctness is only required *within*
each palette, and identity is required *across the whole app* for hosts and harnesses.

### 2.1 Hosts — config-owned, permanent identity

Host colors come from `tokdash.config.json` (`HostRef.color` in every API response) and are used
verbatim in **every** context: chip identity, stacked bars, cumulative lines, table swatches,
legend, freshness dots, settings list.

| host  | color     | swatch context |
|-------|-----------|----------------|
| local | `#7c8cf8` | periwinkle |
| mm    | `#4ec9b0` | teal |
| clawd | `#e8a951` | amber |

User-added hosts supply their own hex (config-validated). Never recolor, never theme-adjust: the
same hex is used in dark and light (all three sit at L* ~65–75 and pass as fills on both themes;
chip text handling in §6.1 keeps labels legible).

### 2.2 Harnesses — fixed 8 + 2 overflow

Fixed assignments, identical on both themes, chosen at L* ~60–72 so they work as bar fills on
`#131211` and `#ffffff` alike. These are constants (`HARNESS_COLORS` in the web layer):

| harness  | color     | note |
|----------|-----------|------|
| claude   | `#d97757` | clay |
| codex    | `#5da9e9` | steel blue |
| hermes   | `#e0709e` | rose |
| pi       | `#9dc45f` | lime |
| droid    | `#4cc9e0` | cyan |
| opencode | `#c084e8` | orchid |
| gemini   | `#e8c268` | gold |
| amp      | `#5fbf9a` | emerald |

**Overflow (+2):** any harness not in this table (ccusage detects up to 15; unknown names pass
through the data layer) gets `--cat-unknown-a: #8a837a` or `--cat-unknown-b: #6f7d8c`, assigned by
alternating in ascending name order of the unknown harnesses present. Deterministic within a
dataset, muted on purpose — unknowns should read as background players.

### 2.3 Models — ranked ramp derivation

Model names are opaque, messy, unbounded (`[pi] claude-opus-4-8`, `hf:zai-org/GLM-5.2`,
`gpt-5.3-codex-spark` — 90+ distinct in real data). Never hash model names to colors and never use
them in selectors/DOM ids.

**Derivation rule:** `/api/usage` already reduces models to top-8-by-cost + `__other__`. Assign the
ordered model ramp by cost rank — rank 1 (highest cost) gets `m1`, rank 2 gets `m2`, etc. `Other`
is always the neutral. Colors are stable within a rendered view; they may reassign when the filter
changes ranking — acceptable and documented (the legend is always visible on the model dimension).

```
m1 #6f9ef2   m2 #e0876b   m3 #58c1a8   m4 #c58cf0
m5 #e5c05e   m6 #d876a8   m7 #7fc470   m8 #62b8d8
Other (__other__): #8d867e   (always last / bottom of stack order per API key order)
```

**"No model data" bands (FR3):** a `__no_model_data__:<agent>` series renders in that harness's
§2.2 color at **40% opacity with a 45° hatch pattern** (SVG `<pattern>`, 4px stripe) so it is
visibly "lesser" than real model data. Legend label comes from the API key label
(`hermes — no model data`).

### 2.4 Swatches

Everywhere a categorical color accompanies text (legends, tooltips, table rows): an 8×8px square,
`border-radius: 2px`, flush-left of the label with 6px gap. Lines in the cumulative chart use a
10×2px rounded rect swatch instead.

---

## 3. Typography

### 3.1 Stacks

```css
--font-sans: ui-sans-serif, -apple-system, "SF Pro Text", "Inter", "Segoe UI",
             Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code",
             Menlo, Consolas, monospace;
```

System-first (this is an offline localhost tool — no font downloads, no FOUT). If Inter is
installed locally it slots in naturally.

### 3.2 Scale

4px-aligned line heights. Sizes are fixed px (this is a data app, not an article).

| token | size/line | weight | tracking | used for |
|---|---|---|---|---|
| `text-hero`    | 32/38 | 650 | -0.015em | Total-cost KPI value only |
| `text-kpi`     | 26/32 | 620 | -0.01em  | all other KPI values |
| `text-title`   | 16/24 | 600 | -0.01em  | app name in header |
| `text-section` | 13/20 | 600 | 0        | card/section titles ("Daily cost", "By harness") |
| `text-body`    | 13/20 | 400 | 0        | table cells, dialog copy, inputs |
| `text-label`   | 12/16 | 500 | 0.01em   | KPI labels, chip text, legend, column headers |
| `text-caption` | 11/16 | 500 | 0.02em   | axis ticks, delta badges, freshness text, footnotes |
| `text-mono`    | 12/18 | 450 | 0        | session ids, project paths, shell/stderr snippets |

Column headers additionally: `text-transform: uppercase; letter-spacing: 0.05em; color:
var(--text-muted)`. No other uppercase anywhere.

### 3.3 Numeric rules

- `font-variant-numeric: tabular-nums` on **every** metric: KPI values, deltas, all table numeric
  cells, axis ticks, tooltip values, chip counts, freshness ages. Apply via a `.tabular` utility
  and audit for it in review.
- All number strings come from `src/shared/format.ts` — the UI never re-rounds
  (`formatCurrency` → `$5,354.90`, `formatTokens` → `74.9M`, `formatDelta` → `+18%`,
  `formatPercent`, `formatRelativeTime`, `formatDateLabel`).
- Numeric table columns are right-aligned; text columns left-aligned. Cost columns render in
  `--text-primary`; token columns in `--text-secondary` (cost is the hero).
- Session ids and project paths: `--font-mono`, `--text-secondary`, middle-truncated with
  full value in `title` tooltip.

---

## 4. Spacing & layout

### 4.1 Rhythm

4px base unit; everything sits on the 4/8 grid: 4, 8, 12, 16, 20, 24, 32, 48. Component-internal
padding uses 8/12/16; gaps between siblings 12; gaps between page sections 24.

### 4.2 Page grid at 1440px

Max content width **1360px**, centered, `padding: 0 24px`. Top-to-bottom:

1. **Header** (56px tall, full-bleed, `--bg` with hairline bottom border): app name left; right
   cluster = per-host freshness (§6.9), refresh button, theme toggle, settings gear. Not sticky.
2. **Filter bar** (§6.1): sticky at `top: 0`, z-index above charts, background `--bg` at 92%
   opacity + `backdrop-filter: blur(8px)`, hairline bottom border when stuck.
3. **KPI row**: 8 KPI cards in a 4-column grid (2 rows), `gap: 12px`.
4. **Chart grid**: Daily cost (stacked bars) full-width, height 320px. Below it, a 2-column row
   (`gap: 12px`): Cumulative cost (left) and Token composition (right), height 260px each.
5. **Breakdown tables**: By host / By harness / By model as three cards in a 3-column grid
   (`gap: 12px`); each collapses gracefully since host table has ≤ a handful of rows.
6. **Sessions table**: full-width card.

### 4.3 Responsive collapse (down to 390px)

| breakpoint | behavior |
|---|---|
| ≥1280 | layout above |
| 1024–1279 | KPI grid → 4 cols stays; breakdown tables → 2 cols then the third wraps full-width; chart 2-up row stays |
| 768–1023 | KPI grid → 2 cols; chart 2-up row → single column stack; breakdown tables → single column |
| ≤767 | everything single column; page padding 16px |
| **390 spec** | KPI cards **2-up** (compact variant: value 22/28, label 11/16); charts full-width, height 240px, y-axis width trimmed (ticks `74.9M` style, no axis title); filter bar stays sticky — date presets and chips become **one horizontally scrolling row each** (no wrap, `-webkit-overflow-scrolling: touch`, 16px edge fade masks, no visible scrollbar); breakdown tables keep table layout with **horizontal scroll**, first (label) column sticky with a hairline right border and `--surface` background; **sessions table switches to a card list** at ≤640px (§6.5); dialogs go full-screen sheet at ≤640px |

Decision recorded: breakdown tables = horizontal scroll + sticky label column (few columns, worth
comparing); sessions = cards (too many columns to scroll usefully).

### 4.4 Radii

```
--radius-control: 6px   (buttons, inputs, segmented controls)
--radius-card:    10px  (cards, tables, charts)
--radius-dialog:  12px
--radius-pill:    999px (chips, badges, freshness dots' container)
```

---

## 5. Borders & elevation

Hairlines over shadows. Elevation is reserved for things that float.

### 5.1 Dark

- Cards/tables/filter bar: `background: var(--surface); border: 1px solid var(--border-hairline);`
  **no shadow**.
- Floating (dropdown, dialog, tooltip, toast): `background: var(--surface-raised); border: 1px
  solid var(--border-strong); box-shadow: 0 4px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4);`
- Dialog scrim: `rgba(10, 9, 8, 0.6)`.

### 5.2 Light

- Cards: `background: var(--surface); border: 1px solid var(--border-hairline); box-shadow:
  0 1px 2px rgba(28,25,23,0.04);`
- Floating: `box-shadow: 0 8px 24px rgba(28,25,23,0.12), 0 2px 6px rgba(28,25,23,0.08); border:
  1px solid var(--border-hairline);`
- Dialog scrim: `rgba(28, 25, 23, 0.35)`.

### 5.3 Focus

Keyboard focus everywhere: `outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px
var(--focus-ring);` (ring outside a 2px gap). Applies to chips, buttons, inputs, table sort
headers, dialog close.

---

## 6. Component specifications

### 6.1 Filter bar & chips

Layout (single card, `padding: 10px 12px`, contents `gap: 12px`, wrapping):
`[date presets segmented control] [custom range trigger] | divider | [host chips] | divider |
[harness chips]`. Dividers are 1px × 20px `--border-hairline` verticals (hidden when wrapped).

**Date presets** — segmented control: container `--surface-inset`, radius 6, 2px inner padding;
segments `Today 7d 14d 30d 60d 90d MTD`, 12/16 500, `padding: 4px 10px`; active segment
`background: var(--surface-raised)` (light: `--surface`) + `color: var(--text-primary)` + hairline
border + (light) `0 1px 2px rgba(28,25,23,0.08)`; inactive `--text-secondary`, hover
`--text-primary`. When a custom range is active, no segment is active.

**Custom range** — a ghost button showing `Jun 1 – Jul 1` (or "Custom…"), calendar icon 14px.
Opens a floating panel (§5 floating): two native-styled date inputs From/To (styled to token set —
do not ship raw UA styling), validation inline (`from > to` → `--negative` caption), Apply
(primary) / Clear. Applying updates the URL query. Ranges older than the cached window are allowed
(server handles the wider refetch) — show a `--warning` caption "outside cached window — fetching
older data" when `/api/status` reports a refresh triggered.

**Chip anatomy** (host and harness chips share it): pill, height 28px, `padding: 0 12px 0 10px`,
12/16 500, containing an 8px identity dot (host color / harness color) + label + (host chips only)
that host's cost for the active range in `--text-muted` tabular (e.g. `mm · $1,917`).

- **Active (included):** `background: color-mix(in srgb, <identity> 16%, transparent)`; `border:
  1px solid color-mix(in srgb, <identity> 45%, transparent)`; text `--text-primary`; dot full
  identity color.
- **Inactive (excluded):** `background: transparent`; `border: 1px solid var(--border-hairline)`;
  text `--text-muted`; dot desaturated to `--text-disabled`.
- **Hover:** active → identity mix to 22%; inactive → `background: var(--surface-hover)`, text
  `--text-secondary`.
- Click toggles; state lives in the URL. Never remove chips for excluded items — excluded is a
  visible state. A disabled host (config `enabled:false`) renders its chip at 50% opacity,
  non-interactive, tooltip "disabled in settings."

**Empty selection** is allowed (yields the FR7 empty state, §6.8) — do not auto-reselect.

### 6.2 KPI cards

Eight cards: Total cost (hero), Total tokens, Daily avg cost, Active days, Projected month-end,
Most expensive day, Top model, Top harness.

Anatomy (`padding: 16px`, radius 10, min-height 96px):

- **Label** top: `text-label`, `--text-secondary`, sentence case ("Total cost" — never uppercase;
  uppercase is reserved for table column headers).
- **Value**: `text-hero` for Total cost, `text-kpi` for the rest, `--text-primary`, tabular. Cost
  via `formatCurrency`, tokens via `formatTokens` with `formatFullNumber` in a tooltip.
- **Delta badge** (bottom row, cards with `KpiValue.comparison`): pill, 11/16 600 tabular,
  `padding: 2px 8px`, glyph + `formatDelta` + suffix `vs prior 30d` (match preset label; custom
  ranges say `vs prior 31d` using the range length) in `--text-muted` outside the pill. Colors per
  §1.3. `deltaPercent === null` with a comparison present (prior period was $0) → neutral badge
  "new".
- **"—" state**: when `comparisonUnavailableReason === "prior-period-not-covered"`, render an
  em-dash badge (neutral gray) with a hover/focus tooltip: "No comparison — the prior 90d period
  isn't covered by the fetched 90-day window." Tooltip is the §6.7 tooltip card. Never leave the
  dash unexplained.
- **Special cards**: Most expensive day shows `$1,717.38` + `Jun 14` as secondary line. Top
  model/harness show the (truncated, `title`-tooltipped) name as value at `text-body` weight 600
  and cost as secondary — with the harness identity dot for Top harness. Projected month-end
  shows the value + caption `naive linear projection · day 2 of 31` in `--text-muted` 11px.
  Null KPIs (no data) render an em-dash value.

### 6.3 Charts (Recharts)

Global chart chrome (all three charts):

- Card wrapper with a header row: section title left; controls right (stack-dimension segmented
  control on Daily cost; log/% segmented control on Token composition); legend below header, 12px,
  wraps, swatches per §2.4. Legend on top — never Recharts' default bottom legend.
- `CartesianGrid`: horizontal only (`vertical={false}`), `stroke: var(--chart-grid)`, solid 1px.
- Axes: `axisLine={false}`, `tickLine={false}`, tick `fontSize: 11`, `fill: var(--chart-axis)`,
  tabular. X ticks via `formatDateLabel` ("Jun 15"), thinned with `interval="preserveStartEnd"` /
  `minTickGap={28}`. Y ticks: cost axes `$1.2k`-style compact; token axes via `formatTokens`.
  No axis titles, no chart borders, no background fills.
- Hover cursor: bars get `cursor={{ fill: 'var(--chart-cursor)' }}`; lines get a 1px
  `--border-strong` vertical cursor line.
- Margins tight: `{top: 8, right: 8, bottom: 0, left: 0}`; y-axis `width` fit to tick text.

**Daily cost, stacked bars** — segmented control Host / Harness / Model switches the series (all
three come precomputed in the response). Colors per §2. Stack order = API key order; only the
topmost segment of each bar gets `radius: [2, 2, 0, 0]` (compute per-bar: the last nonzero key).
`maxBarSize: 28`, `barCategoryGap: "20%"`. Zero-filled axis is already continuous — never let
Recharts skip dates.
**Approximate badge (FR3):** when `DailyStackedSeries.exact === false`, show a pill next to the
title: `≈ approximate`, 11/16 600, `--warning` text on `--warning-muted`, hairline
`--warning`-mixed border; hover tooltip shows `series.note` verbatim. Hatch the
`no-model-data` bands per §2.3.

**Cumulative cost line** — one `Line` per host (host color, `strokeWidth: 1.5`) + Combined
(`--text-primary` at 90%, `strokeWidth: 2`), `dot={false}`, `activeDot={{ r: 3 }}`,
`type="monotone"`. No area fills.

**Token composition** — four classes stacked: input `#6f9ef2`, output `#e0876b`, cache-create
`#e5c05e`, cache-read `#3d4c63` dark / `#c4cede` light (cache-read is deliberately the most muted
color — it's 100× everything else and must recede). Segmented control `Linear / Log / %`:
- Linear: stacked areas (`type="monotone"`, fillOpacity 0.85, no stroke).
- Log: **unstacked lines**, y `scale="log"` with explicit `domain={[1, 'auto']}` and `allowDataOverflow`
  (zero values clamp to the floor — note this in a caption "log scale; zero days clamped").
- %: 100%-stacked areas (`stackOffset="expand"`), y ticks 0/25/50/75/100%.
Default: **%** (the mode where all four classes are actually visible).

**Tooltip card (all charts):** custom `content` — §5 floating card, radius 8, `padding: 10px 12px`,
min-width 180px. Header: date via `formatDateLabel` + weekday ("Sun · Jun 15"), 12/16 600. Rows
(sorted by value desc, zero rows omitted): swatch + label (`--text-secondary`, truncated 24ch) left,
value right-aligned tabular `--text-primary`. Cost tooltips show exact cents (`formatCurrency`);
token tooltips `formatTokens` plus `formatFullNumber` for the total row. Footer hairline + Total
row (600 weight) on stacked charts.

### 6.4 Breakdown tables (by host / harness / model)

Card with section title + row count (`--text-muted`). Table: `border-collapse: collapse`; header
row per §3.2 column-header style with hairline bottom border; body rows 36px tall, hairline
separators at 50% opacity (`color-mix(in srgb, var(--border-hairline) 50%, transparent)`), hover
`--surface-hover`. Columns:

`[swatch+label] [Cost] [Share] [Tokens] [In] [Out] [Cache W] [Cache R] [Trend]`

- Label cell: identity swatch (§2.4) + label; model labels mono? **No** — models stay in sans,
  truncated with `title`.
- **Sortable headers**: click cycles desc → asc; active sort header `--text-primary` + an 8px
  ↑/↓ glyph after the label; inactive headers show no arrow (not a dimmed one). Default sort:
  Cost desc. Sorting is instant (no animation).
- **Share-of-total bar**: in the Share cell, a 48×4px track (`--surface-inset`, radius 2) with a
  fill in the row's identity color (models: their ramp color; `Other`/unknown: `#8d867e`), plus
  `formatPercent(share)` text right of it.
- **Sparkline** (Trend): 96×20px inline SVG polyline of `BreakdownRow.sparkline` (aligned 1:1 to
  `dateAxis`), stroke = row identity color, 1.25px, no dots, no axis; flat-zero rows render a
  centered 1px `--border-hairline` line. Not interactive (tooltip: range covered, e.g. "daily cost,
  Jun 2 – Jul 1").

### 6.5 Sessions table

Full-width card. Header row: title "Sessions" + `top 100 by cost` caption + **search input**
right-aligned: 240px wide, height 28px, `--surface-inset` background, hairline border, radius 6,
magnifier icon 14px, placeholder "Search session or project path…" (`--text-muted`), clear ×
button when non-empty. Filters client-side via `filterSessionRows` as you type (no debounce needed
over ≤100 rows); result count caption updates ("14 of 100").

Columns: `[Session] [Host] [Harness] [Models] [Last activity] [Tokens] [Cost]`.

- Session: `--font-mono` 12/18, middle-truncated to ~18ch (`0012d8bf…da21e9`; codex path ids keep
  the tail: `…/rollout-2026-04-27`), full id + projectPath in tooltip; projectPath (when present)
  as a second line, mono 11px `--text-muted`, truncated from the left.
- Host: chip-let — 6px dot in host color + host label, 12px.
- Harness: same pattern with harness color.
- Models: first model + `+N` overflow pill (neutral), all names in tooltip.
- Last activity: `formatRelativeTime` ("3h ago"), `--text-secondary`; `null` (hermes/droid/gemini)
  → em-dash with tooltip "no session metadata for this harness."
- Tokens `formatTokens`, Cost `formatCurrency` (600 weight — hero column), both right-aligned.
- Default sort Cost desc; sortable per §6.4 rules.

**≤640px card list:** each session is a card (radius 8, hairline, padding 12): line 1 = mono id +
cost (600, right); line 2 = host dot+label · harness dot+label · relative time; line 3 = tokens +
first model, all 11px `--text-muted`. Search input goes full-width above the list.

### 6.6 Settings / host management (FR5)

Modal dialog: 560px wide (full-screen sheet ≤640px), §5 floating treatment, `padding: 20px`,
title row "Hosts" + close ×. Esc and scrim-click dismiss (FR7).

- **Host list**: one row per host — drag-free, config order. Row: color swatch (12px, radius 3) ·
  label (600) + `id` in mono 11px `--text-muted` · ssh alias or "local" chip · enabled toggle
  switch · overflow: Edit / Test connection / Remove. Disabled hosts render at 60% opacity.
- **Toggle switch**: 32×18px track, radius 999; off `--surface-inset` + hairline; on `--accent`;
  knob 14px white (dark theme knob `#f2efec`), 120ms ease-out slide.
- **Add/Edit form** (inline expansion below the row, not a nested modal): fields Label, Id (mono),
  Color (native color input + hex text field, live swatch), SSH alias (empty = local), ccusage
  command (mono textarea, 2 rows). Field spec: 32px height, `--surface-inset` bg, hairline border,
  radius 6, focus per §5.3; labels 12/16 500 `--text-secondary` above; validation errors 11px
  `--negative` below the field (zod messages from the API surfaced verbatim). Footer: Cancel
  (ghost) / Save (primary: `--accent` bg, hover `--accent-hover`; label is white in the LIGHT
  theme only — in the dark theme the label is `--bg` (near-black), because white on the dark
  azure #5a9df6 measures 2.77:1 vs 6.76:1 for the dark label; bright-accent-with-dark-label is
  the Linear/Vercel idiom. `.btn-danger` follows the same rule on `--negative`). Save PUTs
  config; success toast; no restart needed.
- **Remove** asks inline confirmation (row turns `--negative-muted`, "Remove mm? Its cached data
  will stop being shown." + Confirm/Cancel) — never a browser `confirm()`.

### 6.7 Test connection, tooltips & toasts

**Test connection** button per host: click → button shows inline spinner (12px, `--accent`) +
"Testing…", disabled. Result renders as an inline result panel under the row (radius 6, 12px
padding, mono for technical values):

- **Success:** `--positive-muted` bg, `--positive` left border 2px. Line 1: ✓ `ccusage 20.0.14 ·
  842 ms`. Line 2: `agents: claude, codex, pi` (harness dots inline).
- **Failure:** `--negative-muted` bg, `--negative` left border 2px. Line 1: ✕ + human message
  mapped from exit code (255 → "SSH connection failed", 127 → "command not found — check PATH",
  2 → "ccusage rejected arguments", timeout → "timed out after 45s"). Line 2: `stderrTail` in a
  mono well (`--surface-inset`, 11px, max-height 96px, scroll) — the real stderr, verbatim.

**Tooltips** (non-chart): §5 floating card, radius 6, `padding: 6px 10px`, 12/16, max-width 280px,
appear after 300ms hover / immediately on focus, no arrow. Used for "—" comparisons, truncated
names, freshness detail, approximate note.

**Toasts**: bottom-right (bottom-center ≤640px), stack max 3, width 360px, §5 floating, radius 8,
`padding: 12px 14px`, left accent border 2px (`--positive`/`--negative`/`--warning`/`--accent` for
info). Content: 13/20 600 title + optional 12/16 `--text-secondary` detail **including the actual
failure reason** (e.g. "Refresh failed for mm — ssh exit 255: connection refused"). Auto-dismiss
6s (errors 10s), hover pauses, × always present. Enter: 200ms ease-out slide-up + fade; exit fade
150ms.

### 6.8 Skeletons, empty states, onboarding

**Skeletons (first load only** — subsequent filter changes keep the old view until data arrives;
TanStack `placeholderData: keepPreviousData`): blocks in `--surface-hover` with a 1.6s
`animation: pulse` opacity 0.6→1.0 loop; shapes mirror the real layout (8 KPI cards with label +
value bars, chart cards with a grid of faint horizontal lines, table cards with 6 row bars). Never
spinners for page content.

**Empty state (filters exclude everything):** centered in the content area, max-width 360px: a
40px muted glyph (empty-chart line art, `--text-disabled` stroke), "Nothing in this view" 16/24
600, "No usage matches the current date range, hosts, and harnesses." 13/20 `--text-secondary`,
and a ghost button "Reset filters" (returns to 30d / all hosts / all harnesses). KPI cards render
$0.00 values — the empty state replaces charts/tables only.

**Onboarding (no hosts configured):** full-content centered card, max-width 440px: title "Add your
first host", copy explaining local vs SSH in two sentences, a primary "Add host" button opening
§6.6, and a mono example block showing the local default (`bunx ccusage@latest`).

### 6.9 Header: freshness, refresh, theme toggle

**Per-host freshness** (from `/api/status`): one compact cluster per host — host identity dot
(8px) + 6px **status dot** overlapping its corner: `fresh` = `--positive`, `stale` = `--warning`,
`error` = `--negative`, `never` = `--text-disabled`. Hover tooltip: "mm · fresh · refreshed 3m ago"
or "clawd · error: ssh exit 255 (showing cached data from 2h ago)". At ≤767px the cluster
collapses to a single worst-status dot + count ("3 hosts").

**Refresh button**: ghost icon button (28px, radius 6) with a refresh glyph + relative age text
"3m ago" (`--text-muted`, 11px, hidden ≤767px). Click POSTs `/api/refresh`; while
`StatusResponse.refreshing`, the glyph spins (1s linear infinite, `--accent`) and the button is
inert (single-flight). Completion updates the age text; failures toast per host.

**Theme toggle**: ghost icon button, sun/moon glyph, persists to `localStorage("tokdash-theme")`,
default dark, applies class on `<html>` before first paint (inline script — no flash). Icon swaps
with a 150ms cross-fade; the page itself does **not** animate theme change (instant token swap).

---

## 7. Motion

Base curve `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`; base duration 200ms.

**Animates (200ms ease-out):**
- Chart geometry on filter/dimension change: Recharts `isAnimationActive={true}`,
  `animationDuration={200}`, `animationEasing="ease-out"` — bars/lines transition to new values.
- Chip active/inactive fills and borders; segmented-control active segment slide.
- Dialog: 200ms fade + 8px translate-up; scrim fade 150ms.
- Toast enter (§6.7); tooltip fade 120ms.
- Hover states: 120ms (fast tier).

**NEVER animates:**
- **Numbers.** KPI values, deltas, table cells, tooltip values snap instantly — no count-up
  tickers, ever. Numbers are facts, not fireworks.
- Table sorts and search filtering (rows reorder/appear instantly).
- Theme switching (instant), layout/breakpoint changes, skeleton→content swap (simple replace),
  the sticky filter bar (no shrink/grow effects).
- Initial page load beyond the skeleton pulse — no staggered card entrances.

`@media (prefers-reduced-motion: reduce)`: all durations → 0ms except the refresh spinner
(replaced by a static "Refreshing…" text) and skeleton pulse (static fill).

---

## 8. Taste — the don'ts

The intended impression, restated: quiet surfaces, sharp numbers, one accent, colors that always
mean something. Concretely:

1. **No pure black (`#000`) or pure white (`#fff`) backgrounds** — the neutral scale in §1 is the
   floor and ceiling. (Light-theme cards are the one `#ffffff` exception, by token.)
2. **No default Recharts anything** — no default category colors, no bottom legend, no vertical
   gridlines, no axis lines, no default tooltip. If it looks like the Recharts docs, it's wrong.
3. **No heavy cards** — no drop shadows on resting surfaces (dark), no 2px+ borders, no nested
   card-within-card-within-card. Hairlines and spacing do the separating.
4. **No 12-column Bootstrap energy** — no colored card headers, no icon-in-a-circle KPI badges, no
   gradient stat tiles, no badge-soup. One font, two weights per surface, generous alignment.
5. **No semantic color freelancing** — red/green appear only with the §1.3 meanings; the accent
   never colors data; host/harness colors never decorate unrelated chrome.
6. **No count-up number animations, easing "juice," or chart entrance theatrics** — motion is
   limited to §7's list.
7. **No raw model names in layout-breaking positions** — every model/session/path string is
   truncated with a tooltip; nothing external ever widens a column or wraps a KPI.
8. **No unexplained dashes or silent degradation** — every "—", every ≈ badge, every stale dot has
   a tooltip saying exactly why, sourced from the API's own reasons/warnings.

---

## 9. Reviewer checklist (Phase 5)

- [ ] Semantic tokens only in components; dark and light both match §1 hexes.
- [ ] Host colors from config appear identically in chips, bars, lines, tables, legends, status.
- [ ] Harness colors match §2.2 everywhere; unknown harnesses get the muted overflow pair.
- [ ] Delta badges: cost up = red, cost down = green; activeDays neutral; "—" has the tooltip.
- [ ] `tabular-nums` verified on KPIs, tables, axes, tooltips (inspect computed style).
- [ ] 390px: single column, scrolling chip rows, sticky-first-column breakdown tables, session
      cards, full-screen dialogs — genuinely usable, no horizontal page scroll.
- [ ] Model chart under a harness subset shows ≈ badge + hatched no-model-data bands.
- [ ] Numbers never animate; charts transition in 200ms; reduced-motion honored.
- [ ] Every error surface (toast, test-connection, freshness) shows the real underlying reason.
