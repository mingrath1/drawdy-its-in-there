# Live pass 6: competitive layer, final check on board 9dFJUY2k

Worktree `iit-wt/live5` at commit 9974693. Dev server on 5183 (`/version` = 3), not touched. Board opened only at `?local=9dFJUY2k`. Hunt frame: online `LKbozFpniOky` (room `d34cfbb5…`, token `8df9b645…`). Old LocalHost frame `dT0jWxQIjCtA` not used. Task space 34, page p1; `task.finish` not called. No source edits, no commits. No permission prompt appeared, so Escape was never pressed. Bot "Ben" (`scripts/bot-player.mjs`) was stopped at the end; `pgrep` shows no bot process. Times are local (UTC+7) and come from `bot.log`.

## Lanes

| Lane | Verdict | Evidence (docs/qa-live6/) | Notes |
|---|---|---|---|
| N1 Named taunt live (lead changes) | **pass** | `N1-lead-change-roundC.png`; `N3-two-finds-roundD.png`; `bot.log` 17:56:54.289, 17:58:54.260 | Round `5a557f01`: after my tie, Ben's 2nd find at 17:58:12.613 gave 2–1. Banner: **"Ben ขึ้นนำแล้ว! · Ben is out front!"**, with 👑 on Ben. Round `44f33980`: my 2nd find gave 2–1 for me. Banner: **"Mingrath Mekavi… แซงแล้ว! · Mingrath Mekavi… takes the lead!"**. Round `f608127b` also logged "Ben ขึ้นนำแล้ว! · Ben is out front!" at 17:56:54.289 (no screenshot). Generic lines still appear when the lead does not change: "Nothing gets past you." (Ben 2–0), "Spotted!", "ตาไวมาก!". |
| N2 Crown on mid-round tie | **pass** | `N2-tie-roundC-0.3s.png`; `N2-tie-roundB-0.3s.png`, `-1.0s.png` | Round `5a557f01` (17:58:10, after Ben's first find at 17:58:00.66, before his second at 17:58:12.61): score 1–1, **no 👑 on either row**. Banner: **"Mingrath Mekavi… ตามทันแล้ว! · Mingrath Mekavi… ties it up!"**. Round `f608127b` (16.5 s in, 17:56:48): 1–1, no crown, **"Mingrath Mekavi… เท่ากันแล้ว! · Mingrath Mekavi… is level now!"** (both variants seen). |
| N3 You win | **pass** | `N3-round-end-card-roundD.png`; `N3-two-finds-roundD.png`; `N3-roundD-start.png` | Round `44f33980` (Ben `--max 1`, my bird + cat face). Time-up at 17:59:21. Card: **"🏆 คุณชนะรอบนี้! · You win the round!"**, **2–1**, orange card, 👑 on me. Nudge: **"Ben ขอแก้มือไหม? · Rematch, Ben?"**. |
| N4 Got-it-first colour timing | **pass** (removal time only bracketed) | `N4-got-first-roundC-0.3s.png`, `-1.0s.png`, `-3.6s.png` | Round `5a557f01`: I circled the key, which Ben had already found. DOM probe of the box: text `Ben เจอก่อน · Ben got it first`, **background `rgb(37, 99, 235)`, text `rgb(255, 255, 255)`**, present at +0.30 s and +1.05 s, **absent at +2.70 s**. The +3.6 s screenshot shows no got-it-first box. Removal falls between 1.05 and 2.70 s; I did not time it more finely. |
| N5 Ring watch (round-ending find) | **FAIL** | see the N5 section | Attempt 1: the round-ending find had no ring and no tag, ever. Attempts 2 and 4: no tag at ~0.5 s, tag present at +1 s, ring visible at +3 s. |
| N6 Leave cleanly | **pass** | `N6-leave.png`, `N6-leave-final.png` | Leave in a live round. DOM check: no banner after Leave. Bot stopped by SIGTERM at 18:05:32; no bot process left. |

## N5 ring watch

Valid attempts use a wait pattern tied to the round id. In each, Ben had already found every target except the last one, and my single find ended the round all-found.

| Attempt | Round (level) | My find (index) | Round end (all-found) | Ring right after end | Tag at ~0.5 s | Tag at +1 s | After Next round (+3 s) |
|---|---|---|---|---|---|---|---|
| 1 | `fff9cc85` (Lv 3, 5 targets) | flower (4) | 18:00:12.722, "5 of 5 (Ben 4, me 1)", "Ben wins the round!" 4–1 | **no** (`N5-attempt1-roundE-ended.png`) | **no** | **no** | **no** ring (`N5-attempt1-after-next-round-3s.png`), tag **no** |
| 2 | `32d5ae35` (Lv 4, 6 targets) | mushroom (5) | 18:01:40.752, "6 of 6 (Ben 5, me 1)", 5–1 | not confirmed (style panel covers the left edge; `N5-attempt2-roundF-ended.png`) | **no** | **yes** | ring visible (`N5-attempt2-after-next-round-3s.png`), tag yes |
| 3, control only (not N5) | `c381ff25` (Lv 4) | cat face (5), **not** the ender | 18:02:55.419, ended by **Ben's** 5th claim | **yes** (`N5-attempt3-roundH-ended.png`) | yes | yes | tag yes; screenshot not checked |
| 4 | `58884bdd` (Lv 4, 6 targets) | mouse (5) | 18:05:09, "6 of 6 (Ben 5, me 1)", 5–1 | **no** (`N5-attempt4-roundI-ended.png`) | **no** | **yes** (`lZxRU2BNM8QT`) | ring visible (`N5-attempt4-after-next-round-3s.png`), tag yes |

- **Attempt 1, the miss.** The flower's ring never appeared. The stored tag was absent at +0.5 s, +1 s, +3 s, and again at the end of this pass (18:05). Round `fff9cc85` has no `iitFound` entries at all. The SDK events panel was opened (`N5-attempt1-sdk-events-missing-ring.png`). Its newest rows are scene and dom updates. None of the 22 visible rows is an error, but the list is virtualised, so I could not check the rest.
- **Attempts 2 and 4, the late write.** The tag arrived within about a second of the round end, and the ring showed by +3 s. My script opened the SDK panel only when the +1 s tag was still missing, so I did **not** open it for these two. The brief asked for the panel whenever the ring is missing at any point, so this is a gap in my run.
- **Attempt 3, the control.** My wait pattern matched round `32d5ae35`'s line, so I circled the cat face at 18:02:49 while round `c381ff25` had Ben on 3. Ben's own 5th claim ended that round at 18:02:55. That makes it a non-ending find in an all-found round. Its tag and ring were there immediately. This is not an N5 result.
- **Previous pass, anomaly A.** Round `7fbfe7d2` (my find that ended the round last time) still has no tag. This pass shows the same pattern for round-ending finds.
- Pattern: non-ending finds always get a ring and tag immediately (rounds `f608127b`, `5a557f01`, `44f33980`, `c381ff25`). Round-ending finds get no tag in one of three cases, and a late one in the other two.

## Round log (for reference)

| Round | Level | Result | Notes |
|---|---|---|---|
| `02d7fd95` | Lv 3 | time-up, Ben 2–0 | Probe round. My heart circle landed on Ben's find after his 2nd (got-it-first, screenshots `N2-tie-probe-*.png`). |
| `f608127b` | Lv 3 | time-up, Ben 2, me 1 | N2 tie (cat) and lead change to Ben. |
| `5a557f01` | Lv 3 | time-up, Ben 2, me 1 | N1, N2, N4 captured. |
| `44f33980` | Lv 3 | time-up, me 2, Ben 1 | N3 captured (`--max 1`). |
| `fff9cc85` | Lv 3 | all-found, Ben 4, me 1 | N5 attempt 1. Level goes to 4. |
| `1e13ca42` | Lv 4 | time-up, Ben 4 | Not used. |
| `32d5ae35` | Lv 4 | all-found, Ben 5, me 1 | N5 attempt 2. |
| `6a1d5643` | Lv 4 | time-up, Ben 5 | Not used. |
| `c381ff25` | Lv 4 | all-found, Ben 5, me 1 | N5 attempt 3, control only. |
| `068c0a68` | Lv 4 | time-up, Ben 4 | I left mid-round (first N6). |
| `58884bdd` | Lv 4 | all-found, Ben 5, me 1 | N5 attempt 4. |
| `d15a01c0` | Lv 4 | left after the bot stopped | Opened by Next round after attempt 4; bot stopped at 18:05:32.858, then I left. |

## Deviations and evidence caveats

1. **N5-3 is not a valid N5 test.** My wait pattern was not tied to the round id (see above). It is kept as the control.
2. **SDK panel not opened in attempts 2 and 4** (see above). The brief asked for it whenever the ring was missing at any point.
3. **Misleading file names.** `N2-tie-probe-0.3s.png` and `-1.0s.png` are got-it-first captures from round `02d7fd95`, not ties. `N4-got-first-0.3s.png`, `-1.0s.png` and `-3.6s.png` (no suffix) were taken after round `f608127b` had already ended, so they show no got-it-first box. `N1-lead-change-roundB.png` was also taken after that round ended. The lead-change line for round `f608127b` exists only in `bot.log`.
4. **Got-it-first removal** is bracketed between 1.05 s and 2.70 s, not timed exactly.
5. **Driver version** was not read directly. The named taunts and the got-it-first colour both show the new build is running.
6. **Dead heat** (equal scores at round end) was not tested. No round ended tied.
7. **Solo lines** were not tested. Every round here had a second player.

## Layout observations

- **Style panel over the top-left.** When the hunt frame is selected or a round has ended, the frame's style panel (Background Color, Stroke width, Label Size, Layers, Actions) covers about x 12–193, y 82–534 at 67% zoom. During a live round only the Laser Colour panel shows, covering y 82–215. Targets or found rings on the left edge can be hidden. At round end the mushroom in round `32d5ae35` was half under the panel, and its ring's left arc was not clearly visible in the end screenshot.
- **Banner and round-end card over the top-centre.** The live banner covers about x 415–773, y 72–295. The round-end card runs to about y 481. In round `44f33980` the star (fifth listed) sat under the banner's lower edge, with only its tip visible. In the end-card screenshot, the bird's ring and beak peek out from behind the card.
- **Names truncate inside the taunt copy.** "Mingrath Mekavi…" appears in "ties it up!", "is level now!", "takes the lead!", "Rematch, Mingrath Mekavi…?" and "Go again, Mingrath Mekavi…?". It reads acceptably, but the truncation is visible in every named line for this name.
- **Rematch nudge variants.** Both "Rematch, <name>?" (time-up and all-found) and "Go again, <name>?" (all-found, Lv 3 round `fff9cc85`) appeared.
- **Crown.** 👑 goes on the sole leader only. It was absent on the 1–1 tie in both rounds. On the lead change it moved to Ben (round `5a557f01`) and to me (round `44f33980`).
- **Round-end winner colour.** Ben's cards are blue and mine orange, with the winner's name and the score. Found targets are stamped in the finder's colour, which is how the two players are told apart on the board.
- **Level.** A time-up round keeps the level. An all-found round raises it. Lv 4 means 6 targets and 30 s, and it stays at 4 after that.
- **SDK events list is virtualised.** The panel's innerText gives only its header, so the rows can be read only from a screenshot.

## Other

A bash job running `python3` on `/its-in-there` (editing CHANGELOG.md, package.json and manifest.json, then building and testing) was live during this pass. It is not in this worktree, so I left it alone.
