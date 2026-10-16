# Live smoke after fix round 2 (commit 0a8edff)

Board: https://drawdy.io/?local=9dFJUY2k. Dev server on port 5183, `npm run dev` in `iit-wt/live3`. Driver build v1 all session (`.audit/dev-server.log`).

Verifier: test sub-agent. Source was not edited. Own task-space tab only (space 15). No Escape on prompts.

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| S1 start and hit | pending | none yet | First attempt: the round timed out before the laser circle landed. My latency, not a product result. Rerun in progress. |
| S2 frame move then score | pending | S2-before.png, S2-after.png | |
| S3 time-up keeps the level | pass | S3.png | Banner reads "Time's up!" and "Next round (Lv 1)". The round played at level 1 (60 s, started at 0:58). Reached by timeout in the S1 attempt. |
| S4 stop, then Start from the banner | pending | S4.png | |
