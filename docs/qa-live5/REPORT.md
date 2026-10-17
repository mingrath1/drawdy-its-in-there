# Live pass 5: competitive layer on the Drawdy board 9dFJUY2k

Worktree `iit-wt/live5`, commit 5d36541. Dev server on 5183, driver version 1. Test bot "Ben" (`bot-player.mjs`, deployed room). Verifier: test sub-agent, task space 34, page p1. No source edits, no commits, no `task.finish`. No Escape pressed on any prompt; no permission prompt appeared in this pass.

## Lanes

| Lane | Verdict | Evidence (docs/qa-live5/) | Notes |
|---|---|---|---|
| L1 Solo | pass | `L1-5-solo-deployed-found.png`, `L1-6-solo-deployed-ended.png` (deployed room, no bot). Earlier run on the old local frame: `L1-2-solo-found.png`, `L1-3-solo-ended.png` | No scoreboard. Found: "✓ ร่ม · umbrella" in my orange, "เจอแล้ว 1/3 · Found 1/3", toast "เจอแล้ว!". Ended: "หมดเวลา! · Time's up!", "Time's up. They were right there.", "รอบต่อไป · Next round (Lv 1)", "พอแล้ว · Stop". The action button starts a round on open, so no Start click was needed. |
| L2 Scoreboard | partial | `L2-0-round-start.png` (no rows before Ben's first find), `L2-scoreboard-ben-2-me-0.png`, `L2-round3-ben-2-me-1.png`, `L4-round-3-end.png` | Two rows: 👑 Ben with a blue swatch, and me with an orange swatch. Counts updated 0 → 1 → 2. The crown sits on the sole leader and is gone on the 2–2 tie. **Not verified:** the crown disappearing mid-round on a 1–1 tie. My first circle landed after Ben's second find in both rounds (about 17:30:39 vs Ben at 17:30:30; about 17:32:34 vs Ben at 17:32:21). |
| L3 Got it first | pass | `L3-got-it-first-round3.png` | "Ben เจอก่อน · Ben got it first" in Ben's blue. A computed-style probe read the box background as `rgb(37, 99, 235)` (#2563eb), text white. The 2.5 s removal was not timed. The first capture in round 2 (`L3-got-it-first.png`) showed the box dark. Later captures show it blue (`L2-scoreboard-ben-2-me-0.png`), so this was probably a first-render transient. Not confirmed. |
| L4 Winner card | pass | `L4-round-2-end.png`: "🏆 Ben ชนะรอบนี้! · Ben wins the round!" and "2–1" in a blue card. `L4-round-3-end.png`: "🤝 เสมอ! · It's a tie!" and "2–2", no crown | Round 3's scoreboard, after Ben's first find, showed "👑 Ben 🏆 1 2" (the winner's row carries 🏆 1). After the tie both rows show 🏆 2. **Not tested:** "🏆 คุณชนะรอบนี้! · You win the round!", because I never won a round outright. |
| L5 Leave | pass | `L5-leave.png` (Stop on the ended banner), `L5-leave-live.png` (Leave in a live round) | Banner gone both ways. The round's stamps were removed and the found rings stayed. "Leave" exists only in the live header; the ended banner offers "พอแล้ว · Stop" instead. |

## Setup changes (read first)

1. **The hunt frame on this board runs on the local host, not the deployed room.** The frame from an earlier build stores `backendUrl: null`, so the driver plays its rounds in-browser (LocalHost). The bot could not join: `bot-attempt1-local-frame.log` shows "no round yet". That frame's stored `roomId` (`5cba1c23…`) also does not match `deriveRoomId` of its join token (current code gives `9054107d…`), which suggests an older build.
2. **Workaround:** I panned the board away from that frame and clicked the action button. That created a new frame with `backendUrl` set to `https://its-in-there-room.mingrath.workers.dev`, room `d34cfbb5…`, join token `8df9b645…(redacted)`. Every bot run after 17:30:06 used this token. Evidence: `setup-panned-away.png`, `L1-4-new-frame-deployed.png`.
3. **The board now has two hunt frames.** The old LocalHost frame is untouched. The new deployed frame sits in empty canvas below it. The view is panned; "Back to content" returns to the old frame. Delete one if you want only one.
4. **Bot process leak, found and fixed.** My first bot launch was `cd … && node … &`, so `$!` recorded a subshell. Killing it left node running. I then killed both orphaned node processes by PID. Both logged "stopped by SIGTERM" (17:37:05). The second bot ran until 17:37:05, so it claimed in the 5-target round I started for `L5-leave-live` (claims at 17:36:06 and 17:36:16). I clicked Leave at about 17:35:58, before any claim, so L5 is unaffected. The first bot had been connected to the old token's room for about 10 minutes, with no effect on the board.

## Timeline (deployed room, bot Ben: first claim +10 s, second +20 s)

- Round 2, Lv 1, 3 targets: live 17:30:10.2. Ben's fish 17:30:20.2. Ben's heart 17:30:30.1. My mushroom 17:30:56.9, all found, Ben wins 2–1.
- Round 3, Lv 2, 4 targets: live 17:32:00.9. Ben's cat face 17:32:11.0. Ben's star 17:32:20.9. My key about 17:32:35. My umbrella 17:32:37.1, all found, 2–2 tie.
- Round 4 (`L5-leave-live`), Lv 3, 5 targets: I clicked Leave while live, at 0 of 5. The bot kept playing after that and ended the round at 17:36:36, Ben 2 of 5.

## Anomalies

**A. A round-2 find has no found ring.** My mushroom (round 2's last find, the one that ended the round all-found at 17:30:56) turned my orange but has no ring. Rounds 1 and 3 each have a ring for every find of mine. The stored board elements contain no `iitFound` tag for round 2 (`7fbfe7d2…`) at all. Not reproduced, cause not found. The SDK events panel holds only 1000 events, and that window is gone. To settle it, check the driver console for "writing found markers" warnings around 17:30:56, or repeat a round where my find ends it.

**B. Ties and solo rounds both credit a round win.** `rules.ts`: "Everyone tied for the most finds wins it." So the 2–2 tie gives both players 🏆 2. My solo round (one find, time-up) gave me 🏆 1, and that stays on the scoreboard later. Confirm this is the intended rule for the spec.

**C. Missed-target reveal not confirmed in the deployed solo round.** The local-host round (`L1-3-solo-ended.png`) shows unfound targets in red. The deployed one (`L1-6-solo-deployed-ended.png`) shows the unfound cat and key in their normal colour. The reveal lasts about 3 s and my screenshot may have come after it. Not confirmed either way.

## Layout observations

- **Selection style panel covers the board's top-left.** When the hunt frame is selected, Drawdy's shape style panel (Background Color, Stroke width, Label Size, and so on) appears at about x 12–193, y 82–534, replacing the Laser Colour panel. The frame stayed selected after creation and through the rounds. It partly covers the umbrella ring in `L4-round-3-end.png` and `L5-leave.png`. Targets can sit in that area.
- **The banner covers the top-centre of the frame,** about x 415–773, y 72–265 at 67% zoom. No target was hidden under it in the rounds I watched, but it covers that strip of the frame.
- **Text and colour are readable.** The got-first line is white on Ben's blue. The winner card is blue with white text. Scoreboard names truncate cleanly ("Mingrath Mekavi…").
- **Taunts:** the deployed room returns the old generic lines ("Spotted!", "ตาไวมาก!", "Nothing gets past you.", "Ready, set, squint."), as expected.

## SDK events

The panel shows 1000 events (its cap), newest first. The newest window has no error entries, and the request/response pairs match there (`sdk-events-after-round3.png`, `L5-leave-live.png`). The round-2 window is gone.

## State left behind

- Deployed room `d34cfbb5…`: me 4 finds and 2 rounds won; Ben 6 finds and 3 rounds won (the orphan-bot round added to Ben's totals).
- My hunt is closed (Leave or Stop). The SDK panel is closed. No bot processes are running. Space 34 is still open; `task.finish` was not called.
- Files: `baseline.png`, `L1-*`, `L2-*`, `L3-*`, `L4-*`, `L5-*`, `setup-panned-away.png`, `sdk-events-after-round3.png`, `bot.log` (deployed frame, rounds 1 to 4), `bot-attempt1-local-frame.log` (the first, failed attempt).
