# Live smoke after fix round 3 (commit e711a49)

Board: https://drawdy.io/?local=9dFJUY2k. Dev server on port 5183, `npm run dev` in `iit-wt/live4`, driver build v1 all session.
Verifier: test sub-agent. Source was not edited. Own tab only (space 16). No Escape on prompts.
Screenshots are the lane evidence (`docs/qa-live4/<lane>.png`).

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| F1 action button, target, laser score | pass | F1.png | Banner "✓ mouse", "Found 1/3", "เจอแล้ว!". The laser circle landed on the mouse. The first attempt (round at 0:57) timed out before the circle landed. That was verifier latency. The retry clicked the action button from the time-up state, and it started a new round at 0:56. So F1 ran from time-up, not from idle. |
| F2 frame drag mid-round, then score | pass | F2.png | Frame dragged 200 px down by its title label, with Select, during a live round (round at 0:54 when the drag began). Frame top moved from y 368 to y 565. Then the laser circled the key at its new spot. Banner shows "✓ key", "Found 1/3", "เจอแล้ว!" at 0:14. Caveats: (1) the first try in the same round (script r10) did not move the frame. The retry did. (2) An earlier attempt (round at 0:33) timed out before the laser circle landed. (3) In that earlier attempt a Select drag moved the "Review Friday" sticky about 15 px left and 36 px down. I dragged it back by the same offset, and its position matches the earlier screenshot by eye. Verifier side effect, on the test board only. |
| F3 time-out, Next round (Lv n), banner Start | pass | F3.png | Time-up with red unfound targets (flower, small house). Orange found target (key). Banner "Time's up!", "Found 1/3", "Next round (Lv 1)" and "Stop". Clicking "Next round (Lv 1)" started a new round: timer 0:59, "Found 0/3", "Leave" button. |
| F4 Stop clears banner and previews | pending | | |

Not covered: (none yet)
