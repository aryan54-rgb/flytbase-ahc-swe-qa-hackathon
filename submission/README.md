# Final submission — Agentic QA for the FlytBase Live Incident Response Cockpit

**Official evaluation document:** [evaluation-document.md](evaluation-document.md). It covers the system design, the six numbered scenarios with video links, mutation validation, reliability results and limitations.

This folder has six real-time browser recordings, each of one scenario executed by our QA agent against the **unmodified** cockpit. Each recording comes with its voiceover script, its structured result and its full evidence.

Every scenario was run once, on its own, against the clean application:

- no mutations;
- no LLM provider;
- nothing learned from self-healing (no stored repairs).

| Scenario | User goal | Verdict | Video | Voiceover | Evidence |
|---|---|---|---|---|---|
| 001 Device Integrity | See every drone in the fleet, each with its dock | **PASS** | [scenario-001-device-integrity.webm](videos/scenario-001-device-integrity.webm) (2.4 s) | [scenario-001.md](voiceover/scenario-001.md) | [evidence/scenario-001](evidence/scenario-001) |
| 002 Selection Sync | Clicking another drone moves the whole cockpit's focus to it | **PASS** | [scenario-002-selection-sync.webm](videos/scenario-002-selection-sync.webm) (4.8 s) | [scenario-002.md](voiceover/scenario-002.md) | [evidence/scenario-002](evidence/scenario-002) |
| 003 Responsive 375px | Use the cockpit on a phone-sized screen | **DEFECT FOUND** | [scenario-003-responsive-375.webm](videos/scenario-003-responsive-375.webm) (7.5 s) | [scenario-003.md](voiceover/scenario-003.md) | [evidence/scenario-003](evidence/scenario-003) |
| 004 Flight Consistency | Trust the cockpit's status and altitude while a drone takes off | **PASS** | [scenario-004-flight-consistency.webm](videos/scenario-004-flight-consistency.webm) (12.0 s) | [scenario-004.md](voiceover/scenario-004.md) | [evidence/scenario-004](evidence/scenario-004) |
| 005 Route Robustness | Unknown addresses never leave the user on a broken page | **PASS** | [scenario-005-route-robustness.webm](videos/scenario-005-route-robustness.webm) (3.8 s) | [scenario-005.md](voiceover/scenario-005.md) | [evidence/scenario-005](evidence/scenario-005) |
| 006 Map Toggle | Switch the map between 2D and 3D, and the map really changes | **PASS** | [scenario-006-map-toggle.webm](videos/scenario-006-map-toggle.webm) (11.6 s) | [scenario-006.md](voiceover/scenario-006.md) | [evidence/scenario-006](evidence/scenario-006) |

All scripts are also collected in [voiceover/all-scripts.md](voiceover/all-scripts.md). Machine-readable details are in [results/manifest.json](results/manifest.json) and `results/scenario-00N-result.json`.

## What each scenario shows

**001: Device Integrity (PASS).**
- **Action:** the agent opens the cockpit and reads the device list.
- **Check:** the four drone rows, each with its dock folded in, are compared against the backend's device inventory of four drones and four docks. Identity, count, dock names and each row's flight status must match the simulator, with nothing missing, extra, duplicated or hidden.
- **Meaning:** the fleet the operator sees is exactly the fleet the system knows about.

**002: Device Selection Synchronization (PASS).**
- **Action:** the agent clicks Drone 4, then Drone 1.
- **Check:** a click is never counted as success on its own. After each click, exactly that row must be selected and visibly highlighted, the telemetry and video headers must follow it, and the telemetry data must belong to that drone: the heading changes from 47° to 318°, matching the simulator.
- **Meaning:** selection really re-focuses the whole cockpit, not just the row.

**003: Responsive 375px (DEFECT FOUND).**
- **Action:** at a 375×667 viewport the agent checks for sideways scrolling and clipping, then tests whether a tap on each interactive control would actually reach it.
- **Finding:** the **2D and 3D map buttons are covered by the video tile**. A tap lands on the video instead. The two widgets overlap by 2,140 px².
- **Meaning:** this is a genuine usability defect in the product on phones, and it is not fixed here. It reproduced as the same finding in every run and is a stable baseline defect. The recording shows it, and `evidence/scenario-003/failure-annotated.png` outlines the covered buttons and the tile covering them.
- **What still works:** drone selection still works at this width.

**004: Cross-Tier Flight State Consistency (PASS).**
- **Action:** the agent confirms Drone 1 is on standby at 0 m and commands a takeoff.
- **Check:** it compares the cockpit with the simulator's ground truth several times a second. A bounded delay is allowed rather than trusting any single sample. The status must go from standby to taking off to in flight, never ahead of the simulator. Altitude must rise steadily to 30 m, and speed must reach cruise.
- **Meaning:** what the operator sees tracks the real drone state within a bounded delay.

**005: Route Robustness (PASS).**
- **Action:** the agent visits the home page and then eight unknown paths, including path-traversal and script-injection attempts.
- **Check:** each must fall back to the cockpit home, the cockpit must fully render again, and nothing from the address may execute or be echoed onto the page.
- **Meaning:** a mistyped or malicious link never strands the user.
- **Scope:** the starter app has no login, so this tests fallback and injection robustness, not authentication.

**006: Map 2D/3D Toggle (PASS).**
- **Action:** the agent clicks 2D, then 3D, then 2D again.
- **Check:** after each click it reads the **live map itself**, not the button: the camera angle and whether tilting is allowed. The map must be top-down in 2D and tilted in 3D, with the right button pressed.
- **Meaning:** the control genuinely changes the map, and a button that merely looks pressed would fail.

## Capture and video checks

- **Capture command:** `bash submission/capture.sh`, run from the repository root with the stack up. For each scenario it calls `npx tsx runner/run.ts --scenario <id>` from `qa/`, then copies the scenario's own Playwright recording, result and evidence here. It refuses to overwrite final files unless `FORCE=1` is set.
- **The manifest** is regenerated with `node submission/build-manifest.cjs`. It re-probes the videos and recounts the script words.
- **Video format:** all six files are WebM (Matroska) with VP8 video at 25 fps, non-empty, at the scenario's real viewport. Scenario 003 is 374×666: Playwright rounds 375×667 down to even dimensions for the VP8 encoder.
- **Verified in each result file:** `mutation: null`, no self-healing was needed, and the LLM provider was `none`. Scenario 003's three findings are all `STABLE_BASELINE`, and there are 0 new findings anywhere.
- **Content checks:** key frames were inspected.
  - 001 shows the cockpit loading and the device list;
  - 002 shows Drone 4 selected (header "Drone 4", 318°);
  - 003 shows the covered 2D/3D control;
  - 004 shows `taking_off` at 12 m, then `in_flight` at 30 m and 10 m/s;
  - 005 shows the cockpit reloading after each jump to an unknown address;
  - 006 shows a top-down 2D view, then a tilted 3D view.

## Notes for editing

- The recordings are real time and short (2.4–12 s). The spoken scripts run about 22–26 s. When pairing them, hold the last frame or play slower; don't cut or reorder content.
- The recordings show the page only, with no browser address bar. The paths visited in 005 are listed in `results/scenario-005-result.json`.
- Scenario 006 also logs one warning, kept visible and not a failure: at startup 3D is selected while the camera is top-down.
