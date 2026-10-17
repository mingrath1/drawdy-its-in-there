# Changelog

## 0.2.0

Racing each other.

- A scoreboard on the banner, with two or more players: each player's colour, finds this round, and rounds won. A crown marks the player strictly ahead.
- "Got it first": circle a target someone else already found, or lose a claim by a moment, and the banner names who beat you, in their colour.
- The round's end names the winner with the score, or calls a tie.
- The host's taunts name players when the lead changes, and nudge the last-place player for a rematch. Playing alone keeps the plain lines.
- After a dropped connection, the banner no longer keeps a taunt that the room has moved past.
- A found ring whose write failed is retried after you leave and rejoin the frame, and one failed ring no longer holds back the others.
- `scripts/bot-player.mjs`, a test bot that plays as a second player, and `scripts/race-check.mjs`, a two-player check against a backend.

## 0.1.0

The first release.

- Select some drawings, or scroll so they fill your view, and click the magnifier button to start a hunt. The extension wraps the area in a frame named "It's In There!" and hides small line drawings inside it.
- Circle each target with the laser pointer. The extension switches to the laser for you, and `K` brings it back. A loop around the whole frame does not count.
- Finds turn the finder's colour and leave a small ring on the board. When time runs out, the targets nobody found blink red.
- Four levels, from 3 targets in 60 seconds to 6 targets in 30 seconds. Clearing a round raises the level, and a round that times out keeps it.
- The banner and the taunts are in Thai and English.
- Plays offline by default, with each player racing alone. Deploy the Cloudflare Worker in `server/` and set `BACKEND_URL` in `src/driver/config.ts` to race together in one shared room per hunt frame.
- Asks for `dom`, `scene` and `collaboration`, and only after the first click on the magnifier button. It never edits your drawings. It adds only the hunt frame and one ring per find.
