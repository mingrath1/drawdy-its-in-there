# Live smoke after fix round 2 (commit 0a8edff)

Board: https://drawdy.io/?local=9dFJUY2k. Dev server on port 5183, `npm run dev` in `iit-wt/live3`. Driver build v1 all session, no errors in `.audit/dev-server.log`.

Verifier: test sub-agent. Source was not edited. Own task-space tab only (space 15). No Escape on prompts. Screenshots are the lane evidence. Intermediate frames stayed in `/tmp`.

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| S1 start and hit | pass | S1.png | The action button starts the round at Lv 1 with 3 targets. Mushroom circled with the laser. The banner shows "✓ mushroom" and "Found 1/3", and a ring sits around it. A first attempt timed out before the circle landed. That was verifier latency, not a product result. |
| S2 frame move then score | pass | S2-before.png, S2-after.png | Frame dragged by its title label about 200 px down, with Select. Then K. The fish moved from about (1090, 735) to (1090, 935). Circled at the new spot. The banner shows "✓ fish" and "Found 1/3", and a ring sits there. The score landed with 0:03 left. |
| S3 time-up keeps the level | pass | S3.png | Banner reads "Time's up!" and "Next round (Lv 1)". The round played at level 1 (60 s, started at 0:58). Reached by a timeout in the S1 attempt. |
| S4 stop, then Start from the banner | pass, partial | S4.png | Stop cleared the banner. The action button rejoined, and a live round started at 0:59 with no Start click. The banner's own Start button never appeared. It shows only in the idle phase, which this run did not reach. So the banner Start path is not verified. |

Not covered: a live two-player round, and the banner's idle Start button.
