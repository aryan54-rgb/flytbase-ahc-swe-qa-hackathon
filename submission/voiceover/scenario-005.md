# Scenario 005 — Route Robustness / Fallback (PASS)

Video: `videos/scenario-005-route-robustness.webm` (3.8 s)

> Here the user opens an address the cockpit doesn't know. The agent visits the home page, then eight unknown addresses — like admin, settings and unauthorized, plus path-traversal and script-injection attempts. After each reload it verifies the app falls back to the cockpit home, the device list returns, and nothing from the address runs or appears on the page. The result is PASS.

*69 words · ~28 s spoken*

Note: the starter app has no login, so this is fallback and injection robustness — not authentication testing. The recording shows the page only (no address bar); the visited paths are listed in `results/scenario-005-result.json`.
