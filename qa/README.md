# cockpit-qa — Level-1 deterministic QA engine (+ Level-2 performance)

Black-box QA for the FlytBase cockpit. Drives the real app (cockpit `:4010`, backend `:4000`, live
simulator) with Playwright and checks the UI against backend ground truth. Nothing is mocked and no
product code is modified. This package is standalone: it is **not** part of the root npm workspaces.

## Install

```bash
cd qa
npm install
npx playwright install chromium
```

Needs the stack running (`docker compose watch` from the repo root) and Node 18+.

## Run

```bash
npm run qa                                  # all scenarios (findings tagged KNOWN/NEW if a baseline exists)
npm run qa -- --scenario 004                # one scenario ("4", "004", "scenario-004", or "1,3")
npm run qa -- --tag responsive              # by tag
npm run qa -- --fail-on new                 # exit 1 only for findings not in the baseline
npm run qa -- --record-baseline --runs 3    # record the clean-app baseline from 3 real runs
npm run qa -- --repeat 10                   # reliability: 10 consecutive runs -> evidence/reliability.json
npm run qa -- --mutation-check              # baseline-aware mutation validation -> evidence/mutation-report.json
npm run qa -- --mutate row-click-dead       # run against one runtime mutation
npm run qa -- --self-test                   # verdict model + convergence/baseline logic on synthetic cases
npm run qa -- --selector-audit              # every registry selector: strategy + live match count
npm run qa -- --healing-demo                # self-healing cost proof (LLM run vs memory run vs stale memory)
npm run qa -- --reset-healing-memory        # forget learned selector repairs
npm run qa -- --list | --list-mutations | --headed | --no-baseline
npm run typecheck
```

## Verdicts and exit codes

| verdict | meaning | exit |
|---|---|---|
| `PASS` | scenario executed, every invariant held | 0 |
| `DEFECT_FOUND` | scenario executed correctly, ≥1 product invariant violated, evidence complete | 1 |
| `BLOCKED` | a required service/state was unavailable (backend down, simulator disconnected, unmet precondition); no verdict about the product | 2 |
| `HARNESS_ERROR` | the QA system itself failed (exception in harness code, evidence not collected) | 3 |

Worst verdict wins (for the scenario and for the exit code): HARNESS_ERROR > BLOCKED > DEFECT_FOUND > PASS.
How the classifier guarantees this:

- Product observations only reach the verdict through recorded checks (`assertions/checks.ts`).
- User interactions go through `utils/actions.ts`. There, a Playwright actionability failure is a `not_actionable` check, not an exception.
- Ground-truth outages (network errors, 502–504) and `check.precondition` raise `Blocked`.
- Any other exception out of a step can therefore only be a harness bug.
- A `DEFECT_FOUND` whose required evidence is missing is downgraded to `HARNESS_ERROR`.

## Findings and fingerprints

Every check declares `id` (invariant), `target` (semantic element, e.g. `testid:map-view-2d`,
`device:drone-4`, `pair:region:video-tile|testid:map-view-toggle`), `type` (closed vocabulary:
`covered`, `overlap`, `mismatch`, `lag`, …) and a discrete `state`.

```
signature   = scenario_id | check_id | target | failure_type | state
fingerprint = sha1(signature)[0:12]
```

The signature excludes numbers, timestamps, run ids and message text. Those are kept under `observed` as evidence instead. Other properties:

- One finding is recorded per fingerprint; repeats increment `occurrences`.
- Findings whose affected screen boxes intersect share an `incident` id: one root symptom seen several ways.

## Interaction stages

`utils/actions.ts` keeps three stages apart, each with its own result type:

- `probeActionable()` → ACTIONABLE / NOT_ACTIONABLE. This is a probe only: nothing is clicked.
- `click()` → ACTION_EXECUTED.
- `interact()` → POSTCONDITION_SATISFIED or POSTCONDITION_FAILED.

Each step in `result.json` carries an `interaction_stage`. A dead handler shows up as ACTION_EXECUTED followed by POSTCONDITION_FAILED.

## Map observation (scenario-006)

- The Cesium viewer is read-only. It is found by following React's fiber pointer on `[data-testid=map-canvas]` to the component's ref, and matched by shape: camera, scene and `isDestroyed`.
- After that, only public Cesium API is read: `camera.pitch` and `scene.screenSpaceCameraController.enableTilt`.
- Nothing is written, and `window.Cesium` is not assumed. It does not exist in this app.
- ARIA (`aria-pressed`) is checked separately and never trusted alone. The `map-toggle-fake-state` mutation proves this.

## Baseline

`--record-baseline` runs the whole suite N times against the unmutated app. If every run reaches a valid verdict, it writes:

- `baseline/baseline.json`:
  - identity and timestamp;
  - harness version and source hash;
  - product git commit and a dirty flag;
  - per-scenario verdicts over the N runs;
  - every finding, with its signature, observed values, `seen_in_runs` and evidence path.
- `baseline/evidence/<scenario>/`: a copy of that evidence (gitignored).

Each finding gets a baseline state: `STABLE_BASELINE` (seen in every run), `INTERMITTENT` (in more than one run but not all), `TRANSIENT` (in exactly one run) or `UNCONFIRMED` (the baseline has only one run). Nothing is promoted: 2 of 3 stays INTERMITTENT. Normal runs tag each finding with its state, or `NEW_DEFECT`. A stable baseline finding that does not reproduce is reported as `BASELINE_DEFECT_MASKED`, never as a silent fix. Normal runs also and warn when the harness or product changed since it was recorded.

`--mutation-check` works in two stages:

1. It first checks that the clean app reproduces the baseline exactly.
2. It then runs **every** mutation against **every** scenario. Each scenario is tagged `NEW_DEFECT`, `STABLE_BASELINE`, `INTERMITTENT`, `BASELINE_DEFECT_MASKED` or `UNCHANGED_PASS`, and each mutation gets an outcome: `DETECTED`, `DETECTED_WITH_MASKING` (suspicious), `MASKED_ONLY` (suspicious; counts as missed) or `MISSED`.

A static lint (`runner/decoupling.ts`) fails the check if a mutation locates its target with a test id, a registry selector or a detector state class.

A mutation counts as detected only by fingerprints that are not in the baseline. `expectedToFail` in `runner/mutations.ts` is a report annotation only.

## Self-healing selector execution

When a UI change breaks a selector but the user's intended control still exists, the engine finds that control again without anyone rewriting the test. Healing repairs **locators only**, never behaviour.

```
known selector ──resolves to ≥1 element──► use it                         (tier 1: deterministic, as before)
     │ resolves to NOTHING  (only then; a hidden, covered or dead element is a product finding, never healed around)
     ▼
memory ──exactly one live element with the remembered semantic signature──► use it          (memory hit)
     │ zero or several matches → the entry is marked stale, and never redirects the action
     ▼
local ranking ──HIGH──► use it                                                               (tier 2)
     │ NONE → TARGET_ABSENT · AMBIGUOUS → HEALING_REJECTED (the LLM is not asked: nothing separates twins)
     ▼ MEDIUM / LOW
LLM resolver (only for actions with a postcondition) → strict JSON parse → re-validated on the live DOM
     ▼
click → verify the scenario's postcondition → ONLY THEN write memory
```

### How the rest of the suite is protected

- **A healed click is not success.** "Switch to 2D" passes only when the live map is actually top-down. A healed element that fails the postcondition gives `HEALING_FAILED` plus a real check failure, and nothing is written to memory.
- **No LLM for every action.** A normal run makes 0 LLM calls. The LLM is consulted only when the known selector *and* memory *and* the local ranker all fail.
- **No unverified guesses for measurements.** Measurement lookups (scenario-003 layout geometry) use tiers 1, memory and HIGH-confidence local only. An unverified LLM guess must never decide which element an invariant is measured on.
- **Fingerprints don't change.** Checks keep their semantic `target` ids, so baseline fingerprints are unaffected. A healed selector appears as the verdict-neutral warning `healing.selector_drifted`, which gives the old selector and the suggested new locator.

### Semantic action schema (`healing/types.ts`, catalog in `scenarios/actions.ts`)

```ts
{
  step_id: 'map-view-2d',
  intent: 'Switch the map to the 2D view',          // sent to the LLM verbatim
  target: 'testid:map-view-2d',                     // semantic target id (findings/fingerprints)
  selector?: '[data-testid="map-view-2d"]',         // known selector (derived from target if omitted)
  roles: ['button'],                                 // HARD: roles as computed by Playwright
  accessible_name?: '2D',                            // SOFT: the name when the test was written
  semantic_hints?: ['2D'],                           // SOFT
  context?: 'Map view',                              // SOFT: enclosing landmark / group / section
  required_text?: ['Drone 2'],                       // HARD: identity (another drone is never "the same row")
  forbidden_text?: ['3D'],                           // HARD: the semantic opposite
  expected_postcondition?: 'map is top-down (pitch -90°) with tilt disabled',
}
```

APIs are backward compatible: `ctx.healing.perform(check, action, postcondition?)` for clicks and `ctx.healing.locate(check, action)` for measurements. Scenarios that still use raw locators work unchanged. Today scenarios 002, 003, 004 and 006 use semantic actions.

### Local recovery (`healing/rank.ts`)

Candidates are collected by `healing/candidates.ts` from what the browser can observe:

- semantic interactive elements;
- the outermost element of each `cursor: pointer` region, because React click handlers are invisible to the DOM.

Each candidate is described by role, approximate accessible name, visible text, test id, aria-label/pressed, disabled state, visibility, landmark/group/section context and a few stable attributes. Playwright 1.63 has no `page.accessibility` API, so the chosen element's role is **confirmed with Playwright's own `getByRole` engine** before use.

- **Hard constraints** (an ineligible element is never clicked and never shown to the LLM): visible, enabled, role in `roles`, all `required_text` present (whole-phrase), no `forbidden_text`.
- **Soft score** (weights sum to 1):

  | Feature | Weight | Meaning |
  |---|---|---|
  | `name_exact` | 0.45 | normalised accessible name equals `accessible_name` |
  | `identity` | 0.30 | all `required_text` phrases present |
  | `hints` | 0.10 | share of `semantic_hints` present |
  | `context` | 0.10 | `context` phrase in the landmark/group/heading chain |
  | `testid` | 0.05 | token overlap between the old and new test id |

- **Confidence levels:**

  | Level | Rule | Result |
  |---|---|---|
  | `NONE` | no eligible candidate | TARGET_ABSENT |
  | `AMBIGUOUS` | top candidates share a semantic signature (role \| identity \| context) | refuse, no LLM |
  | `HIGH` | score ≥ 0.45 **and** margin to the runner-up ≥ 0.2 **and** strong identity evidence (exact name, required-text identity, or ≥ 0.5 test id overlap) | use it |
  | `MEDIUM` / `LOW` | anything else | LLM tier if configured, otherwise HEALING_UNRESOLVED |

  Thresholds can be overridden with `QA_HEAL_HIGH`, `QA_HEAL_MARGIN` and `QA_HEAL_MEDIUM`.

### LLM tier (`healing/resolver.ts`)

It's provider-neutral: `SemanticResolver.resolve({ action, failed_selector, candidates, page })` returns `{ candidate_id, confidence, reason }`.

| Variable | Meaning |
|---|---|
| `QA_LLM_PROVIDER` | `none` (default, fully deterministic) · `gemini` · `openrouter` · `openai` |
| `QA_LLM_MODEL` | defaults: gemini `gemini-2.5-flash`, openrouter `google/gemini-2.5-flash`, openai `gpt-4o-mini` |
| `QA_LLM_API_KEY` | generic key, else `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `OPENROUTER_API_KEY`, `OPENAI_API_KEY` |
| `QA_LLM_BASE_URL` | override for any OpenAI-compatible endpoint |
| `QA_LLM_MIN_CONFIDENCE` | default 0.8 |
| `QA_LLM_TIMEOUT_MS` | default 20000 |
| `QA_LLM_REASONING_EFFORT` | reasoning models only (`gpt-5*`, `o*`), default `low` |

```bash
QA_LLM_PROVIDER=gemini     GEMINI_API_KEY=...     npm run qa -- --healing-demo
QA_LLM_PROVIDER=openrouter OPENROUTER_API_KEY=... npm run qa -- --mutation-check
QA_LLM_PROVIDER=openai     QA_LLM_MODEL=gpt-5-nano npm run qa -- --mutate heal-label-changed
```

The prompt contains:

- the intent and its expected effect;
- the failed selector;
- the expected role, the previous name, hints, context and the forbidden meaning;
- a compact description of each eligible candidate (role, name, context, pressed state);
- the page title, path and landmarks.

It never contains keys, cookies or page dumps.

Every response is **rejected** if any of these holds:

- it isn't strict JSON;
- `candidate_id` is anything other than an offered id or `null`;
- confidence is outside [0, 1] or below the minimum;
- the choice fails the hard constraints;
- the choice is indistinguishable from another candidate;
- Playwright doesn't confirm its role.

After that, the postcondition decides.

**Security rules for API keys:**

- Keys are read from the environment at call time and sent only in headers (`Authorization` / `x-goog-api-key`), never in URLs.
- They are never written to memory, logs, screenshots or `result.json`.
- Transport errors are scrubbed of anything key-like and of `sk-`/`proj_`/`org-` identifiers before they are recorded.
- Tier 3 never runs unless `QA_LLM_PROVIDER` is set explicitly.

### Memory (`qa/memory/healing-memory.json`, gitignored, human-readable)

```json
{
  "key": "27988b3fa173d1ca",                         // sha1(application | page | intent | original target), no timestamps
  "application_identity": "flytbase-cockpit@http://localhost:4010",
  "page_identity": "/",
  "scenario_id": "scenario-006", "step_ids": ["map-view-2d"],
  "intent": "Switch the map to the 2D view",
  "original_target": "testid:map-view-2d", "original_selector": "[data-testid=\"map-view-2d\"]",
  "healed_target": { "role": "button", "name": "Top-down", "context": "main > group:map view",
                     "suggested_locator": "getByRole('button', { name: 'Top-down' })" },
  "semantic_signature": "button|top-down|main > group:map view",
  "learned_via": "llm", "confidence": 0.92, "status": "active",
  "first_success": "...", "last_success": "...", "success_count": 4, "stale_count": 0,
  "learned_on_commit": "16db625d..."
}
```

- An entry is written only after its postcondition is verified.
- When reused, the entry must match exactly one live element that passes the hard constraints. Otherwise it's marked `stale`, with a reason.
- `--reset-healing-memory` deletes learned entries.
- `--mutation-check` and `--healing-demo` use their own isolated memory files.

### Metrics

Each action in `result.json` under `healing.actions[]` records:

- `deterministic_attempt`, `deterministic_success`;
- `memory_lookup`, `memory_hit`, `memory_stale`;
- `local_recovery_attempt`, `local_recovery_success`;
- `llm_attempt`, `llm_success`, `llm_provider`, `llm_model`, `llm_latency_ms`, `llm_tokens`, `llm_reason`;
- `recovery_tier`, `recovery_confidence`, `confidence_level`, `recovery_latency_ms`;
- `candidates_considered`, `healed_description`;
- `outcome`, `postcondition`, `clicks_dispatched`.

Scenario totals (`healing.summary`) and run totals (`summary.json` → `healing`) report:

- total actions and deterministic actions;
- healed actions, split into memory hits, local recoveries and LLM successes;
- LLM calls, with their latency and tokens;
- unresolved, rejected and target-absent actions;
- healing failures.

### Healing mutations (`runner/mutations.ts`, decoupled from detector selectors)

| mutation | change | expected |
|---|---|---|
| `heal-testid-changed` | data-* hooks on the map buttons get new values | local recovery → PASS |
| `heal-dom-moved` | the button group moves into the banner, and the buttons lose their hooks | local recovery (new context) → PASS |
| `heal-label-changed` | hooks removed, buttons relabelled "Top-down" / "Tilted" | with a provider: LLM → verified → PASS; without one: clean HEALING_UNRESOLVED, 0 calls, 0 clicks |
| `heal-ambiguous` | hooks removed, both buttons labelled "View" | HEALING_REJECTED, 0 clicks, map unchanged |

`npm run qa -- --healing-demo` is the cost proof. Its three runs:

1. `heal-label-changed` with empty memory → LLM → memory written.
2. The same mutation → memory hits, **0 LLM calls**.
3. `heal-ambiguous` with that memory → the entries go stale → refusal.

## Layout

```
qa/
  runner/      run.ts (CLI) · executor.ts (verdict engine) · findings.ts (fingerprints, incidents, diff)
               baseline.ts · version.ts · evidence.ts · fixture.ts · mutations.ts · selftest.ts · config.ts
  scenarios/   types.ts (Scenario contract) · actions.ts (semantic action catalog) · s001..s006 · p001..p003 (Level-2) · index.ts
  performance/ types.ts · config.ts · probe.ts · metrics.ts · invariants.ts · baseline.ts · stepper.ts · safety.ts
               scenario.ts (perf scenario skeleton) · reporting.ts · selftest.ts
  healing/     session.ts (tier cascade) · candidates.ts · rank.ts · resolver.ts (LLM adapters) · memory.ts · types.ts
  assertions/  checks.ts (structured checks) · polling.ts · layout.ts (DOM geometry, hit-tests) · cockpit.ts
  utils/       api.ts (ground truth) · selectors.ts (only place selectors live) · actions.ts (user interactions)
  memory/      history.ts -> run-history.jsonl · healing-memory.json (learned, verified selector repairs)
  baseline/    baseline.json (+ evidence/, gitignored) · performance-baseline.json (Level-2 profile)
  evidence/    <scenario-id>/, summary.json, reliability.json, mutation-report.json, _mutations/, _reliability/,
               P001..P003/, performance-summary.{json,md}
```

## Evidence (per scenario, overwritten each run)

| file | when |
|---|---|
| `recording.webm` | always |
| `failure.png`, `failure-annotated.png`, `dom.html` | any non-PASS; the annotated screenshot outlines every affected box |
| `final.png` | PASS |
| `console.json` | always: console, uncaught page errors, failed requests, HTTP ≥400, dialogs, harness notes |
| `ground_truth.json` | always: backend health/devices/state at preflight/start/end + per-step traces |
| `result.json` | always: verdict + reason, findings (with evidence paths and observations), every check, versions, evidence integrity |

Responsive findings carry the following in `observed`:

- viewport size;
- the element's selector or test id, its rectangle and its visible rectangle;
- the covering widget and its rectangle;
- the overlap area and overlap rectangle;
- 3×3 hit-test coverage;
- the result of a real Playwright trial click.

---

# Level-2 — performance testing

**Question answered:** as real-time workload increases, when does the cockpit stop giving the operator a responsive and correct experience?

Level-2 is an extension of the engine above, not a second framework. Performance scenarios are ordinary `Scenario`s run by the same executor, so they share verdicts, checks, findings, evidence, run history and the healing-aware semantic actions. They live in a separate list (`perfScenarios`). `npm run qa`, `--repeat`, `--mutation-check` and `--record-baseline` still run only the Level-1 suite.

## Run

```bash
npm run qa -- --perf                          # P001 -> P002 -> P003, in that order
npm run qa -- --perf --scenario P001          # one scenario ("P1", "p001", "P001,P003")
npm run qa -- --perf --record-baseline        # record the N=4 performance profile -> baseline/performance-baseline.json
npm run qa -- --perf --self-test              # offline self-test of the performance logic (no browser, no stack)
npm run qa -- --perf --list
```

The perf logic self-test also runs inside `npm run qa -- --self-test`. Exit codes follow the executor: 0 PASS · 1 DEFECT_FOUND · 2 BLOCKED · 3 HARNESS_ERROR. The **performance verdict** is reported separately (see below).

| scenario | workload axis | what happens |
|---|---|---|
| **P001** adaptive drone workload | fleet size N (≈ 9N telemetry msg/s) | K baseline windows at N=4, then N = 8, 12 … 32. At each level: fleet change → stabilize 4 s → observe 5 s → 3 selections alternating between the newest drone and the first → judge. The first failing level is bracketed and binary-refined to ±1 drone. |
| **P002** telemetry + interaction stress | interaction interval 2.0 → 1.0 → 0.5 s | 6 drones, 3 of them flying. The operator alternates "select drone" and "2D/3D toggle", each measured to its postcondition. A video transition (stop → "off", start → "live" → decoded frames) is timed before stress and after every phase. |
| **P003** stability soak | elapsed time (~150 s after warm-up) | 2 drones flying. Every 15 s: a 3 s window, a map interaction, heap (performance.memory + CDP post-GC), DOM size, rendered track size and errors, then trend analysis. |

## Workload limits (hard, cannot be raised by env)

| limit | value |
|---|---|
| drones | ≤ 32 |
| simulation speed | ≤ 5x |
| video streams started by a scenario | ≤ 3 (the backend's autostarted streams are not counted) |
| spacing between operator interactions | ≥ 500 ms |
| workload phase of a scenario | 180 s hard timeout. Page load before it and cleanup after it are not counted. The controller stops **gracefully** before the timeout and reports the result as truncated. |

**Abort immediately** on any of these:

| condition | how it is detected | outcome |
|---|---|---|
| Page freeze > 5 s | the page does not answer a probe call within 5 s, or a frame gap > 5 s | `HARD_INVARIANT_BREACH` + abort. The recovery time after cleanup is recorded. |
| Repeated backend outages | 3 consecutive network / 502–504 | `BLOCKED` |
| Simulator disconnect | `GET /api/health` | `BLOCKED` |
| Renderer crash | Playwright `crash` event | functional defect |

## Metrics (`performance/types.ts`, catalog in `performance/metrics.ts`)

Every sample carries the workload context: scenario, axis, level, fleet size, sim speed, scenario video streams and phase. It also carries the wall-clock time, the time relative to the scenario start, and its window id.

- **Browser** (in-page probe, installed with `addInitScript` before the cockpit loads):
  - Long tasks (`PerformanceObserver longtask`): count, maximum, total blocking time (TBT) per window and per second.
  - Long-animation-frame script attribution, when supported.
  - Frame cadence from a `requestAnimationFrame` loop: mean FPS, 10th-percentile per-second FPS, frames > 33.3 ms, longest frame gap.
  - Event Timing of clicks.
  - JS heap: `performance.memory`, precise mode enabled at launch.
  - DOM element count.
  - Uncaught errors, unhandled rejections, `webglcontextlost`.
  - CDP `Performance.getMetrics` (Chromium only): main-thread busy ratio and script busy ratio per window.
  - Cesium scene render count and render time, from `preRender`/`postRender` listeners on the viewer. The viewer is found read-only through the React fiber, as in `assertions/cesium.ts`.
- **Interaction latency** is measured in the page. The clock starts at the click event's timestamp and stops at the first animation frame in which the **intended postcondition** holds:
  - selection: the row is selected AND the telemetry header names the drone;
  - map: the button is pressed (`map_ack_ms`) and the camera is at the target pitch and at rest (`map_settle_ms`, which includes the 0.8 s camera flight).

  A dispatched click without the postcondition is `POSTCONDITION_FAILED` and is never counted as a latency.
- **Backend:** `/api/health` and `/api/control/state` round trips every second during a window. Failures are labelled `outage` (environment) or `http`.
- **Simulator:** tick rate, speed and running state from ground truth.
- **Product:**
  - fleet convergence: API ack of the fleet change → every row rendered, timed in the page;
  - telemetry freshness;
  - video transition timings;
  - "telemetry belongs to the selected drone": the displayed values must match a frame from that drone's own stream.
- **Telemetry freshness is measured on the browser clock only:** now − arrival of the newest frame whose values are on screen. The simulator container's clock drifted by several hundred ms within seconds against the host (measured: `arrival − payload.timestamp` ranged from about −800 to +2000 ms). Cross-clock ages are therefore kept as `age_raw_ms` for diagnosis and never used for verdicts. That also means transit delay *before* the browser receives a frame is not measurable in this environment.

Metrics a runtime cannot provide (no `performance.memory`, no CDP, map not observable, no Event Timing) are `null` with a reason in `unavailable_metrics`. They are never reported as 0 and never fail a scenario on their own.

## Contracts (`performance/invariants.ts`, all configurable)

| contract | metric | NOMINAL | ELEVATED | DEGRADED | BREACH |
|---|---|---|---|---|---|
| operator responsiveness | interaction latency (window median) | ≤ 150 ms | 150–300 ms | 300–1000 ms | > 1000 ms |
| main-thread stalls | longest task | ≤ 150 ms | ≤ 300 ms | ≤ 500 ms | > 500 ms (severe) |
| smoothness | mean FPS | ≥ 30 | ≥ 25 | ≥ 20 | < 20 |
| freezes | longest frame gap | ≤ 100 ms | ≤ 250 ms | ≤ 500 ms | > 500 ms |
| freshness | displayed telemetry age (window max) | ≤ 1000 ms | ≤ 2000 ms | ≤ 3000 ms | > 3000 ms |
| convergence | fleet change → rows | ≤ 1000 ms | ≤ 1250 ms | ≤ 1500 ms | > 1500 ms |
| stability | uncaught exceptions, WebGL context losses | 0 | — | — | ≥ 1 |
| memory (P003) | post-saturation heap slope | judged only after the track history reaches its cap; otherwise UNAVAILABLE ||||

The 150–300 ms gap is its own category (ELEVATED), not hidden. Thresholds can be overridden with `QA_PERF_INVARIANTS='{"responsiveness.interaction":{"breach":800}}'`.

**Step verdict:**

- `HARD_INVARIANT_BREACH` if a hard contract is breached;
- `DEGRADED` if a contract is DEGRADED or there is a baseline-relative regression;
- `HEALTHY` otherwise;
- `INCONCLUSIVE` if the responsiveness and smoothness metrics are all unavailable.

Two rules make the verdict robust:

- **Isolated outlier vs sustained:** a first window that is not clearly healthy is re-observed. A verdict requires both consecutive windows to agree; the single bad window is listed as an isolated outlier. Stability contracts (exceptions, WebGL) count any single occurrence.
- **Pre-existing violations:** a contract the baseline workload itself already violates is reported under "Contracts already violated at the baseline workload". At higher load it counts only if it gets worse.

## Baseline methodology (`performance/baseline.ts`)

- Baseline workload: **N=4, 1.0x, no faults**. After a discarded 5 s warm-up, **K=5 windows** of 5 s are collected (`QA_PERF_BASELINE_WINDOWS`).
- Per metric, the profile stores n, median, mean, min, max, P5, P95, Q1, Q3 and **IQR**. When lower is worse (FPS), the limits mirror at P5 and are clamped at 0.

| class | rule |
|---|---|
| `NORMAL_VARIANCE` | ≤ P95 + 1.5·IQR |
| `OUTLIER` | beyond that, but not in 2 consecutive windows |
| `PERFORMANCE_REGRESSION` | > P95 + 3.0·IQR in **2 consecutive** windows |
| `INSUFFICIENT_BASELINE` | fewer than 3 baseline values: not judged, never a regression |

- Each metric has an absolute floor, so a zero-IQR baseline (e.g. 0 long tasks in every window) cannot turn one sample of noise into a regression.
- Only user-facing metrics are judged relatively: interaction latency, longest task, TBT/s, FPS, longest frame gap, API RTT and telemetry age. Metrics that scale with load by design (message rate, heap, DOM size, busy ratio) are diagnostics for correlation.
- The constants live in `perfConfig.tukey`.
- Regression detection uses the **in-run** baseline: same browser, same stack, minutes apart. `baseline/performance-baseline.json` (written by `--perf --record-baseline`, a separate file, so the Level-1 `baseline.json` schema is untouched) is compared as cross-run drift in `recorded_baseline_drift`.

## Adaptive ramp (`performance/stepper.ts`: `stabilize()`, `observe()`, `evaluateInvariants()`, `bracketKnee()`)

```
4 PASS → 8 PASS → 12 PASS → 16 FAIL        bracket [12, 16]
refine: 14 PASS → 15 FAIL                  boundary [14, 15]: safe capacity 14, onset 15
```

`bracketKnee` is pure orchestration with an injected evaluator, which is how it is unit-tested. It never claims a boundary it did not establish:

- **all levels pass** → "no degradation up to 32", with no onset claimed;
- **the first level fails** → no safe capacity claimed;
- **the time budget runs out** → truncated, bracket reported as unrefined;
- **inconclusive level** → the search stops;
- **severe abort during level L** → onset L, with the bracket from the last passing level, not refined.

Results where a level passes above a failing one are reported as `non_monotonic`.

## Bottleneck correlation (`performance/reporting.ts`)

At the onset level, signals are compared with the baseline:

| signals | consistent with |
|---|---|
| high API RTT + normal main thread | backend |
| normal API + high long tasks / blocking time / busy ratio | frontend main thread (with long-animation-frame script attribution) |
| high telemetry age + socket instability | transport / realtime |
| low FPS + normal API + higher Cesium render time | map rendering |
| falling tick rate | simulator |

Every statement reads "signals consistent with …". Correlation is never reported as a root cause.

## Performance verdict

| verdict | meaning |
|---|---|
| `HEALTHY` | every judged level healthy. Contracts that could not be measured anywhere are named ("NOT measurable: …"). |
| `DEGRADED` / `HARD_INVARIANT_BREACH` | the worst sustained level, with where it happened and why |
| `INCONCLUSIVE` | nothing could be judged |
| `BLOCKED` / `HARNESS_ERROR` | outage / harness failure; these always win over measurements. **A harness error never becomes a performance defect.** |

Executor status vs performance verdict:

- **Functional failures under load are defects (DEFECT_FOUND), exactly as in Level-1:** wrong device rows, telemetry from another drone, an interaction that never takes effect, uncaught exceptions, WebGL context loss, renderer crash.
- **Capacity results are the performance verdict** in `performance.json`, plus verdict-neutral `perf.contract` warnings. Pushing the system until it degrades is the ramp's purpose, not a defect by itself.

## Evidence (`evidence/<P00x>/`)

| file | content |
|---|---|
| `recording.webm`, `console.json`, `ground_truth.json`, `result.json` | as in Level-1 (same executor) |
| `performance.json` | baseline profile, recorded-baseline drift, every workload step with its windows (raw browser/CDP/API/telemetry/simulator metrics and interactions), invariant results, baseline comparisons, all samples with timestamps and workload, knee/boundary, verdict, bottleneck signals, unavailable metrics, safety events, cleanup report, scenario details |
| `summary.md` | scenario · workload axis · baseline · measurements table · safe capacity · degradation onset · primary signals · verdict · evidence path |
| `degradation-annotated.png` | the cockpit at the first failing level, with a banner (workload, verdict, key metrics) and the device list / map outlined. The banner is composed in a separate page, so it is produced even when the cockpit page is frozen (via a CDP screenshot). |
| `dom.html` | the DOM under load |

A run also writes `evidence/performance-summary.{json,md}`.

## Safety and cleanup

Every change goes through a `WorkloadLedger`, and cleanup runs as an `always` step, whatever happened before. Cleanup:

1. stops video started by the scenario and restores video it stopped;
2. removes the drones it added;
3. sets speed to 1x;
4. resets and restarts the simulator;
5. **verifies** the stack is back at its starting fleet, 1x, running, all drones in standby.

Preconditions: a perf scenario starts only from the baseline stack (the stock 4 drones, no faults); otherwise it is BLOCKED. On Ctrl-C the CLI undoes any open ledger. A cleanup failure is `HARNESS_ERROR`, or `BLOCKED` if the backend was unreachable, and lists the leftovers. It is never a performance result.

## Limitations

- **Headless Chromium renders WebGL through SwiftShader (CPU).** The renderer string is recorded in `performance.json`. Cesium frame cost, FPS and the recurring ~300 ms Cesium frames seen at N=4 depend on this software renderer, and the absolute numbers do not represent a GPU operator workstation. Relative results (the knee, regressions against the in-run baseline) are the meaningful part.
- The Playwright video recording (required evidence) adds its own load to every level equally.
- Probe `page.evaluate` calls add small main-thread tasks (about 1 per second).
- **Cross-clock transit** (simulator → browser) is not measurable, because the simulator container's clock drifts against the host. Freshness is the browser-side age of what is on screen.
- **The P003 heap contract is post-saturation.** The track cap is 2000 points per drone at 2 points/s (≈ 1000 s), beyond the 180 s safety limit, so in a default run it is UNAVAILABLE with a projected saturation time. The pre-saturation slope is reported but not judged.
- **The P001 boundary depends on how long the session has run.** From reading the code (not measured in isolation): `CesiumMap.tsx` runs `syncEntities` on every store update, and that rebuilds each drone's full track polyline. So the work per telemetry message should grow with fleet size × track length. That is why the `track pts` column is reported next to each level; the boundary is a property of the session, not a constant.
- The backend autostarts video only for boot-time drones, so P002 times video on one of those drones.
- Event Timing and long-animation-frame APIs are Chromium features; elsewhere they are reported as unavailable.
