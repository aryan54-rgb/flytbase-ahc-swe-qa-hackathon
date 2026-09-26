# Voiceover scripts — all six scenarios

Each script follows the exact order of actions in its recording. Spoken at ~150 words/min.

---

## scenario-001 — Device List Integrity — PASS

Video: `videos/scenario-001-device-integrity.webm` (2.4 s) · 55 words · ~22 s spoken

> Here the user wants to see every drone in the fleet. The agent opens the cockpit and waits for the device list. It compares the four drone rows, each with its dock, against the backend's device inventory — checking identity, count, and that each row shows the flight status the simulator reports. The result is PASS.

---

## scenario-002 — Device Selection Synchronization — PASS

Video: `videos/scenario-002-selection-sync.webm` (4.84 s) · 62 words · ~25 s spoken

> Here the user wants to switch focus to another drone. The agent clicks Drone 4, then back to Drone 1. A click alone isn't treated as success: each time it verifies that exactly that row is selected, the telemetry and video follow it, and the data belongs to that drone — the heading changes from 47 to 318 degrees. The result is PASS.

---

## scenario-003 — 375px Responsive Integrity — DEFECT FOUND

Video: `videos/scenario-003-responsive-375.webm` (7.52 s) · 65 words · ~26 s spoken

> Here the user wants to use the cockpit on a phone. The agent opens it at 375 pixels wide and tests whether a tap on each control would actually reach it. The 2D and 3D map buttons fail — the video tile covers them. After measuring the overlap and confirming drone selection still works, it reports DEFECT FOUND: a reproducible usability defect, proven on this recording.

---

## scenario-004 — Cross-Tier Flight State Consistency — PASS

Video: `videos/scenario-004-flight-consistency.webm` (12.04 s) · 63 words · ~25 s spoken

> Here the user wants to trust the cockpit while a drone flies. The agent confirms Drone 1 is on standby, then commands a takeoff. It compares the cockpit with the simulator's ground truth several times a second, allowing a short, bounded delay instead of trusting one sample. Status goes standby, taking off, in flight, and altitude reaches 30 metres. The result is PASS.

---

## scenario-005 — Route Robustness — PASS

Video: `videos/scenario-005-route-robustness.webm` (3.8 s) · 62 words · ~25 s spoken

> Here the user opens an address the cockpit doesn't know. The agent visits the home page, then eight unknown addresses — like admin, settings and unauthorized, plus path-traversal and script-injection attempts. After each reload it verifies the app falls back to the cockpit home, the device list returns, and nothing from the address runs or appears on the page. The result is PASS.

---

## scenario-006 — Map View Toggle Behaviour — PASS

Video: `videos/scenario-006-map-toggle.webm` (11.64 s) · 59 words · ~24 s spoken

> Here the user wants to switch the map between 2D and 3D. The agent clicks 2D, then 3D, then 2D again. It doesn't trust how the buttons look: after each click it reads the live map — the camera angle and whether tilting is allowed — confirming it is truly top-down in 2D and tilted in 3D. The result is PASS.
