# Live regression after fix round 1 (build 4cfa1a9)

Board: https://drawdy.io/?local=9dFJUY2k. Dev server on port 5183.

The QA agent drove every lane and saved screenshots. It then hit its model quota before writing this report, so the coordinator wrote the verdicts by reading the screenshots and the dev-server log. A lane is marked pass only where a screenshot shows the outcome.

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| R1 no prompt before click | pass | R1.png, R1-sdk-events.png | |
| R2 start, no storage prompt | pass | R2.png | The manifest no longer asks for storage. |
| R3 targets visible | pass | R3.png | |
| R4 hit scores | pass | R4.png | |
| R5 miss scores nothing | pass | R5.png, R5-round3-start.png | |
| R6 whole-frame circle scores nothing | pass | R6.png | |
| R7 frame follow | pass, partial | R7.png, R7-frame-moved.png | The targets drew at the frame's new position. A score at the new position is not shown in a still. |
| R8 level after all-found | pass | R8-all-found.png, R8-round2-start.png | 3 of 3 found, and the banner offers "Next round (Lv 2)". |
| R9 docs write during a live round | pass | R9.png, r9-probe.txt, dev-server-output.txt | The round stayed live at 0:26 after the write at 03:41:02, and the dev server built only v1 all session. |
| R10 stop | pass | R10-before-stop.png, R10.png | |
| R11 rejoin | pass | R11.png | |

Not covered: the time-up path that keeps the level (R8 was run as all-found), and a live two-player round. A two-client round ran against wrangler dev instead, see docs/e2e-local.txt.
