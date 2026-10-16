# Live smoke after fix round 3 (commit e711a49)

Board: https://drawdy.io/?local=9dFJUY2k. Dev server on port 5183, `npm run dev` in `iit-wt/live4`, driver build v1 all session.
Verifier: test sub-agent. Source was not edited. Own tab only (space 16). No Escape on prompts.
Screenshots are the lane evidence (`docs/qa-live4/<lane>.png`).

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| F1 action button, target, laser score | pass | F1.png | Banner "Found 1/3" with "✓ mouse" and the found marker in orange. The laser circle landed on the mouse at its new spot. The first attempt (round at 0:57) timed out before the circle landed. That was verifier latency. The retry clicked the action button from the time-up state, and it started a new round at 0:56. So F1 ran from time-up, not from idle. |
| F2 frame drag mid-round, then score | pending | | |
| F3 time-out, Next round (Lv n), banner Start | pending | | |
| F4 Stop clears banner and previews | pending | | |

Not covered: (none yet)
