# cockpit-qa — Level-1 deterministic QA engine

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
  scenarios/   types.ts (Scenario contract) · actions.ts (semantic action catalog) · s001..s006 · index.ts
  healing/     session.ts (tier cascade) · candidates.ts · rank.ts · resolver.ts (LLM adapters) · memory.ts · types.ts
  assertions/  checks.ts (structured checks) · polling.ts · layout.ts (DOM geometry, hit-tests) · cockpit.ts
  utils/       api.ts (ground truth) · selectors.ts (only place selectors live) · actions.ts (user interactions)
  memory/      history.ts -> run-history.jsonl · healing-memory.json (learned, verified selector repairs)
  baseline/    baseline.json (+ evidence/, gitignored)
  evidence/    <scenario-id>/, summary.json, reliability.json, mutation-report.json, _mutations/, _reliability/
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
