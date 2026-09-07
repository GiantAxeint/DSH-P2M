# 插件冲突管家（P2M）· Plugin Conflict Manager for DSH

[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

**English** | [**中文**](./README.md)

**DSH Plugin Conflict Manager (P2M): pre-empts crash-causing conflicts — duplicate service registration, peer version drift, patch override clashes — isolates the offending plugin and ranks plugins by cumulative usage time, alongside unified enable/disable control and dynamic maintenance priority.**

> The repo/package identifiers stay `DSH-P2M` / `dsh-p2m` (technical identifiers unchanged); P2M is the public nickname.

## What it solves

| Problem | What DSH-P2M does |
| --- | --- |
| No unified plugin management | Register/enable/disable/isolate/restore every plugin in one place; every decision is written to a **single guard file** and survives restarts |
| Conflicts only handled reactively | Detect (boot-crash attribution / runtime auto-disable / static patch scan) → decide by priority → record & rollback |
| No concept of priority | Fixed `DSH > P2M > others`; others are ranked live by **cumulative usage time**: when B outlives C in usage, maintenance order becomes `DSH > P2M > B > C > …` |

**Extra in v1**: "trial before you really enable it" — after a plugin is downloaded, it is dry-run once in a child process before being actually enabled; on failure a dialog offers **Cancel enable** / **Ignore risk & continue**.

## Priority mechanism

```
tier 0  DSH core        (name starts with @deepseek-ai/ or in configured coreEntryIds)
tier 1  P2M itself      (entry id: p2m — suicide-immune; guard rows naming it are self-healed away)
tier 2  other plugins   (sorted by cumulative usage ms from usage.json = maintenance priority)

Invariant: tier 0/1 entries are NEVER auto-disabled; on same-tier conflicts the
least-used plugin is sacrificed.
```

Dynamic example: ledger `B=12h, C=5h, D=2h` → order `DSH → P2M → B → C → D`. When C is idle and D reaches 3h → `DSH → P2M → B → D → C`.

## How it works (one-minute version)

- A DSH plugin is a Cordis **loader entry**: an npm package whose `cordis.patch.yml` declares its mount row.
- Config layers merge in order; the `--patch` overlay (guard file) wins last, so it is the strongest place to express "disabled".
- P2M uses the loader hot-management API (`create/update/remove`) for runtime scheduling; the root tree's `write()` is a no-op, so **every decision is dual-written**: guard (persistent across restarts) + runtime hot update (immediate).
- Full design (conflict matrix, guard protocol, file formats, limits): [DESIGN.md](./DESIGN.md).

## Install

Requires DSH (`dsh` CLI installed globally) and Node ≥ 18.

### Option A — official plugin CLI (after the repo is public)

```bash
dsh plugin --profile web add github:GiantAxeint/DSH-P2M
```

### Option B — local link (development / unpublished)

1. Put this repo anywhere (e.g. `E:\DeepseekHome\Plugin\DSH-P2M`).
2. Edit the profile's `package.json` (`%USERPROFILE%\.dsh\profiles\web\package.json` on Windows):
   - `dependencies`: add `"dsh-p2m": "link:E:/DeepseekHome/Plugin/DSH-P2M"`
   - prepend `"dsh-p2m"` to `dsh.profile.bundles` (loads it first, honoring `DSH > P2M`).
3. Run `pnpm install` in the profile directory (DSH uses a pnpm workspace).
4. Restart DSH (prefer the v2 launcher below).

> The P2M entry id is fixed to `p2m` — do not change it (guard self-heal depends on it).

### Upgrade the launcher (recommended)

`launcher/dsh-safe.mjs` is the v2 supervisor: **pure boot supervision** (emergency isolation only), the canonical guard lives at `<DSH_HOME>/p2m/plugin-guard.yml` shared with P2M via the same lock/backup protocol, and boot crashes land in the same `incidents.jsonl`. Copy it over your old `dsh-safe.mjs` (the old one is backed up first). One-click on Windows:

```
scripts\install-safe.cmd
```

## Usage

P2M works automatically once loaded. State lives under `<DSH_HOME>/p2m/` (default `~/.dsh/p2m/`):

| File | Contents |
| --- | --- |
| `plugin-guard.yml` | The single guard (persistent disabled list, injected at boot via `--patch`) |
| `usage.json` | Per-plugin cumulative usage ledger (30s sampling, configurable) |
| `incidents.jsonl` | Append-only audit trail (conflicts / isolates / restores / dialog decisions) |
| `state.json` | p2m state (boot counter, snapshots) |

### Boot log: what "boot #N" means

Every time DSH starts and loads P2M, the log shows a line with a number N (e.g. `boot #11`):

```
[p2m] boot #11 | guard=<...> | autoIsolate=true
```

- **`#N` is not a level or phase** — it is the **machine-wide cumulative count of successful boot runs**. The counter lives in `state.json#bootCount`, incremented by 1 on every boot and never reset (restarts after a crash or repeated in-process loads also bump it, so it ≈ "number of startups", not an exact process count).
- **Every boot does exactly the same work regardless of N**: read state → self-heal immunity (remove p2m/core entries from the guard if present) → capture a dependency resolve snapshot (E2) → run the peer-version preflight (E3) → static-scan all patch layers (E4) → print this line.
- **How to use it when debugging**: N increasing steadily means P2M is running on every startup; if N did not change between two startups, P2M was not loaded at all that time (disabled / not enabled). When an incident happens, align N with the `incidents.jsonl` timeline (e.g. "crashed on boot #11" → inspect incidents around that boot).
- **Reset the counter**: delete the `bootCount` field (or the whole file) from `state.json` — P2M recreates it automatically; guard/usage/incidents are untouched.

### Log display rules (levels & colors)

P2M logs have three levels:

| Level | Prefix | Color | When |
| --- | --- | --- | --- |
| info | — | none | normal actions: boot, isolate, enable, reconcile decisions |
| **Advisory** | `[WARNING]` | **yellow** | non-fatal issues that need attention: resolve drift, preflight peer violations, static-scan conflicts, self-heal, loader unavailable |
| **Fatal / internal** | `[ERROR]` | **red** | interrupted or internal failures: a protected entry auto-disabled by the loader, p2m internal errors |

- **Every `[WARNING]` / `[ERROR]` is followed by an indented English `hint:` line** telling you which file/path to check or what the conflict is about (e.g. `~/.dsh/p2m/incidents.jsonl`, the profile `package.json`, the guard file).
- Sub-detail lines (per-bundle declared/resolved comparison, fix commands) are indented without repeating the prefix.
- **Colors adapt automatically**: they degrade to plain text when stderr is not a TTY (redirected/piped logs) or when `NO_COLOR` is set, so log files never contain ANSI escape garbage; force colors with `logColor: 'always'` (or disable with `'never'`).

Example (preflight violations found):

```
[WARNING] [p2m] preflight: 2 peer violation(s) — 建议先按下方 fix 命令钉版本，再重启 DSH
    @foo/bar peer @deepseek-ai/dsh-settings: declared ^0.1.1-rc.2, resolved 0.1.2-rc.1 | fix: pnpm add @deepseek-ai/dsh-settings@^0.1.1-rc.2
    hint: Check the peer ranges declared in <profile>/package.json against the resolved versions above, then run the fix command (pnpm add ...) inside the profile before restarting DSH.
```

The launcher (`DSH-safe.cmd` → `dsh-safe.mjs`) follows the same rules.

### ctx.p2m API

| Method | Purpose |
| --- | --- |
| `list()` | Priority-ordered list (tier / usageMs / running / disabled) |
| `status()` | Current config & guard state |
| `usage()` / `incidents(n)` | Ledger / last n audit entries |
| `scanConflicts()` | Run one static+runtime conflict scan (report only) |
| `enable(id)` / `disable(id)` | Restore / disable (enable goes through the trial gate; protected ids cannot be disabled) |
| `trial(id)` | Manual child-process dry run → verdict ok/crash/timeout/unsupported |
| `preflight()` | Run one peer-version preflight (E3) → findings + summary |
| `reconcile()` / `sample()` | Manual reconcile / sampling tick |

### Trial gate

- Before enabling a new or guard-isolated plugin, it is dry-run in a **child process** (import + apply).
- On failure (crash/timeout/undecidable) a desktop dialog asks: **Cancel enable** (default, safe) / **Ignore risk & continue** (audited; if it crashes again, it is auto-isolated during a cooldown window to avoid popup storms).
- Disable with `autoGateRisk:false`, or `ui:'none'` to never pop up (always defaults to cancel).

## Configuration (entry config)

| key | default | description |
| --- | --- | --- |
| `sampleIntervalMs` | 30000 | usage sampling interval |
| `autoIsolate` | true | auto-isolate runtime failures (false = report only) |
| `autoGateRisk` | true | enable the trial gate |
| `ui` | 'auto' | dialog mode: auto/desktop/none |
| `popupCooldownMs` | 120000 | per-plugin popup cooldown |
| `trialTimeoutMs` | 15000 | child-process trial timeout |
| `coreNamePrefixes` | ['@deepseek-ai/'] | DSH-core detection prefixes |
| `coreEntryIds` | [] | extra DSH-core entry ids |
| `knownCoreServices` | ['sessionPersistence'] | C7 known engine-core service list (set [] to silence) |
| `preflightOnBoot` | true | E3: run peer preflight at boot (report only) |
| `scanBootLayers` | true | E4: static-scan all patch layers at boot |
| `patchLayers` | [] | extra patch files for `scanConflicts()` (auto-discovered by default) |
| `logColor` | 'auto' | log colors: auto (TTY & no NO_COLOR) / always / never |

## Conflict types at a glance

| Kind | Meaning | Handling |
| --- | --- | --- |
| C1 boot crash | boot fails matching `failed to … loader entry` | dsh-safe v2 emergency isolate + audit |
| C2 runtime auto-disable | loader disabled an entry, not persisted | trial: conflict→isolate; self-crash→dialog |
| C3 config clash | layers give one id different configs (incl. factory-disabled overridden by profile) | report + either-or advice (manual fix) |
| C4/C5 duplicate id / duplicate module name | structural | report (manual fix) |
| C6 self/privilege violation | guard names p2m/core | self-heal removal + audit |
| C7 same-name service registration | two plugins would register the same cordis service (or collide with engine-core defaults like `sessionPersistence`) | pre-boot preflight report + either-or advice |
| version drift (preflight) | peer range vs actually-resolved version mismatch (local dep missing → climbs to a stale global CLI copy) | pre-boot report + pin command (`DSH_P2M_PREFLIGHT=block` to refuse boot) |

> Resolve-path drift (E2): every reconcile records each plugin's `require.resolve` destination + version; a drift writes a `resolve-drift` audit and persists into `state.json#lastResolve`.

## Tests

Zero-dependency unit tests (`node:test`):

```bash
node --test test/*.test.mjs   # 74 cases: guard/ledger/priority/conflicts/policy/yaml/trial/C7/preflight/resolve
```

## Layout

```
DSH-P2M/
├─ lib/            P2M (ESM, zero runtime deps)
│  ├─ index.js     entry: ctx.p2m service, sampling, reconcile, gate
│  ├─ guard.js     single guard writer (lock+backup+migration)
│  ├─ yaml-min.js  bundled loader-patch-dialect YAML parser
│  ├─ ledger.js    usage ledger (pure tick())
│  ├─ priority.js  tiers & dynamic ordering
│  ├─ conflicts.js conflict detection (static+runtime+C7 service preflight)
│  ├─ policy.js    decision engine
│  ├─ preflight.js peer-version preflight (E3, zero-dep semver subset)
│  ├─ trial.js     child-process dry run (R5)
│  └─ dialog.js    two-button crash-risk dialog (R5)
├─ launcher/       dsh-safe v2 boot supervisor (copy over old one)
├─ test/           unit tests + dry-run fixtures
└─ DESIGN.md       full design & limits (read first)
```

## Safety & limits (honest notes)

- P2M has **zero runtime dependencies** (even YAML parsing is bundled) — it cannot create dependency conflicts itself.
- Decisions touching DSH core or itself are always report-only, never auto-disabled; guard rows naming itself are self-healed.
- The trial catches import/apply-level crashes; process-killing hard crashes are covered by the dsh-safe boot fuse instead.
- The official `dsh plugin add` flow is "download then restart": p2m cannot intervene before that restart (v2 launcher fuse + audit covers it); all p2m-controlled entry points (hot mounts, manual restore) go through the trial gate.

## License

[MIT](./LICENSE) © 2026 Erius (GiantAxeint)
