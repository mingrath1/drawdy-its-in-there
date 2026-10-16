# QA live report: It's In There!

Run date 2026-10-17. Worktree `iit-wt/live` at commit 28fd351. Board `https://drawdy.io/?local=9dFJUY2k`, in my own tab in ego-browser task space 8. Dev server on port 5183, stopped at the end of the run. Source was not edited.

## Lanes

| Lane | Verdict | Evidence | Notes |
|---|---|---|---|
| L1 activation | pass | `L1-activation.png`, `sdk-events-open.png` | After a reload, no prompt appeared. The action button is visible in the right rail at (1154, 649), 30 px square. SDK events before the click held only `command:dom:create-action-button` and `subscription:dom:element-clicked`. |
| L2 start | pass, with a prompt finding | `L2-start.png`, `L2-after-click-1.png`, `L2-retrigger-after-allow.png` | A marquee selected the messy area, and the button was clicked. The "It's In There!" frame wrapped the selection, and the ink stayed visible. The banner showed the Thai and English goal with a countdown (0:46, then 0:43). The laser tool became active. The storage and collaboration prompts were both allowed. See Finding 2. |
| L3 targets | pass | `L3-targets.png` | At 81% zoom, five line-art targets sat over the ink, inside the frame, in the board's stroke style. |
| L4 hit | pass | `L4-hit.png` | One six-point loop around the crescent moon. The target turned orange, an orange found ring appeared, the count went from 0/5 to 1/5, and the taunt "Nothing gets past you." showed. |
| L5 miss | pass | `L5-miss.png` | A six-point loop in an empty area, in the same round. The count stayed at 1/5 and no marker appeared. |
| L6 whole-frame | pass | `L6-whole-frame.png` | A six-point loop around the whole frame scored nothing, and the banner read 0/5 at 0:06. Control: smaller loops in the same round still scored. |
| L7 all found | could not run | `L7-attempt-3-of-5.png`, `L7-attempt-lv7-3-of-5.png` | The best result was 3 of 5 in two rounds. Rounds at level 5 and up lasted 27 to 28 s, and my drawing took longer. See Finding 6. The all-found banner was never reached. |
| L8 next round | pass, partial | `L8-next-round-red-reveal.png`, `L8-red-reveal-lv6.png` | Next round gave more targets and a shorter timer: 4 targets at about 40 s, then 5 targets at about 30 s. Unfound targets turned red at time-up and stayed red. The 3 s blink was not captured. The board opened at level 2, not level 1. See Finding 5. |
| L9 stop | pass | `L9-stop.png` | After Stop, the banner and the target previews were gone. The frame and the orange found rings stayed. |
| L10 rejoin | pass | `L10-rejoin.png` | With the frame in view, the action button joined the same frame. The newest SDK rows show `query-rect` and `element-rects` on the existing frame, and no `add-drawdy-elements`. One frame is on screen, and a new round started. |
| Console and [iit] lines | could not run | none | The page target recorded no console or exception events, with Runtime and Log enabled. The driver's `[iit]` lines come from the sandboxed bootstrap iframe target. This harness cannot attach to that target, because `page.cdp` takes no session id. |

## Findings

### 1. Writing any file under the worktree reloads the driver, and the hunt is lost

**Reproduction.** Run `npm run dev -- --port 5183`. Start a hunt. Write any file under the worktree, for example `docs/qa-live/x.png`. `curl localhost:5183/version` rises by 2 per write (21, 23, 25 observed). Within about 3 s, the banner and the previews vanished. The banner upserts stopped at `0:43`.

**Logs.** `docs/qa-live/dev-server-output.txt` shows `built v1` through `built v25`. The last banner payload in the SDK panel is `iit:banner` at x 420, y 72, with `0:43`.

**Best guess.** `vite.config.ts:6-9` sets no `server.watch.ignored`, so Vite watches the whole worktree. Each change bumps the version, and Drawdy reloads the driver. The reload drops the in-memory hunt in `src/driver/hunt.ts`. The fix is to add `watch: { ignored: ['**/docs/**'] }` to the server block, or to write QA artifacts outside the project root during a run.

**Unverified.** The SDK list showed no second `create-action-button` after the reload, so the exact reload mechanics are a guess.

### 2. A storage prompt vanished with no answer, and the driver can wait up to 120 s on it

**Reproduction.** Load the board fresh. Select an area and click the action button. The "wants to save data on this device" prompt shows for about 3 s, then is gone, with no click from me. The SDK list shows `request command:kv-storage:get` with no response. Clicking the action button again brought the prompt back, and I allowed it. The collaboration prompt followed.

**Best guess.** Drawdy closes the prompt on its own. The driver waits on it for `PROMPT_TIMEOUT_MS`, which is 120000 (`src/driver/command.ts:49`, used at `:80`). Then `loadDifficulty` catches the timeout and starts at level 1 (`src/driver/hunt.ts:275-281`). That would silently drop the stored level.

**Unverified.** I cannot tell whether the vanished prompt was saved as Deny. FACTS rule 3 says a dismissal can be saved. The later Allow worked, so the permission is granted now.

### 3. Laser drawing takes about 0.8 s per pointer move in this harness

**Measured.** A 24-point loop with the laser active took about 20 s. In Select mode, 20 hover moves took 195 ms, and an 8-move drag took 698 ms.

**Cause unknown.** It could be the CDP round trip while the laser trail renders, or the laser handler in `src/driver/hunt.ts`. Check it in a normal browser before treating it as a product bug.

### 4. My drag moved a user sticky, and I reverted it

**Reproduction.** When a round ends, the driver restores the Select tool (`src/driver/hunt.ts:407-411` calls `restoreTool`, defined at `:513`). My remaining laser loops were then dragged in Select mode. One began inside the "งบ Q3" sticky and moved it about (-59, -32) px. I moved it back by the same offset. Undo did not restore it, because the move was not in the undo history. The sticky now sits where it was before the move, to within a few px, and that is not pixel-verified. This broke FACTS rule 2 for one sticky, and I caused it.

### 5. Round size and level

The first round before my reload had 3 targets. After the reload, the board opened at 4 targets. Stored difficulty is read at `src/driver/hunt.ts:275-283`, and the local room is built with it. So L8's "level 2" could not be checked as written. Observed sizes: 4 targets (Lv 2), then 5 targets at Lv 3 through Lv 11.

### 6. L7 did not complete

Rounds at level 5 and up lasted about 27 to 28 s. From reading a screenshot to the first stroke took about 20 s, and each target took about 4 s to draw. Two rounds reached 3 of 5. A scripted read of the target requests from the SDK panel also failed. Its per-row lookup took the first `pre` in a shared container, so all five targets resolved to one point. Next step: fix that lookup, then read and draw in one call.

## Notes

- The found rings from the test rounds are still on the QA board. They are scene elements the driver writes by design. Delete them by hand if you want a clean board.
- The screenshots were written to the OS temp folder while the run was live. Copies were made here after the dev server stopped. Some copies come from the image-tool results, which hold the same frames.
- Commit contains only `docs/qa-live/`.

## Files

Lane screenshots: `L1-activation.png`, `L2-start.png`, `L3-targets.png`, `L4-hit.png`, `L5-miss.png`, `L6-whole-frame.png`, `L7-attempt-3-of-5.png`, `L8-next-round-red-reveal.png`, `L9-stop.png`, `L10-rejoin.png`.

Supporting: `sdk-events-open.png`, `L2-after-click-1.png` (storage prompt), `L2-pre-selection.png`, `L2-prompts-allowed.png`, `L2-retrigger-after-allow.png`, `L2-wait-8s.png`, `reset-no-banner.png` (banner gone after the rebuild), `round-start-after-reload.png`, `L7-attempt-lv7-3-of-5.png`, `L8-red-reveal-lv6.png`, `probe-with-panel.png`, `probe-row-expanded.png` (banner payload), `dev-server-output.txt`.
