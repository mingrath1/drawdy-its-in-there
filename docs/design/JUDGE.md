# Cross-judge: It's In There! protocol arena

Judge: Claude Opus 5.5. I ran no candidate. I read FACTS.md, hunt.ts, and all four proposals in full. I compiled each protocol.ts and ran a few parser probes through `tsx`.

## Compile results

Each TypeScript fence was extracted to `/tmp/iit-arena/check-<name>/protocol.ts` with `hunt.ts` beside it, then checked with `npx -p typescript tsc --noEmit --strict --target es2022 --moduleResolution bundler --module esnext --allowImportingTsExtensions`.

| Candidate | Rubric flags | + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `lib es2022,webworker` | + `erasableSyntaxOnly` |
|---|---|---|---|
| A gpt | **pass** | pass | **fail**: `constructor(readonly code …)` at gpt.md:155 is a parameter property. esbuild accepts it, but Node strip-types does not. It is a one-line fix. |
| B grok | **pass** | pass | pass |
| C muse | **pass** | pass | pass |
| D gemini | **pass** | pass | pass |

Parser probes:
- A rejects unknown fields. A snapshot round-trips through `encode` and `parseServer`.
- B's `parseServerEvent` accepts `targets: [{bogus:1}]` and `finds: [42]` on a live round. grok.md:280 passes the arrays through without checking them. B's `toWire` does strip a ready `next`'s targets.
- C and D both accept a `result` whose `command` is `"bogus"`. They cast it instead of checking it (gemini.md:271, 290).
- D does not export `LocalHost`, although gemini.md:345 says it is "defined in protocol.ts above". D's `target.claim` accepts any `player.id` (gemini.md:31).

## Scores (1 to 5)

| Criterion | A gpt | B grok | C muse | D gemini |
|---|---|---|---|---|
| 1. First-claim and requestId idempotency | **5** | 4 | 3 | 3 |
| 2. Recovery | **5** | 3 | 4 | 3 |
| 3. Smallest protocol | 2 | 3 | **4** | **4** |
| 4. Security that fits the threat | **4** | 3 | **4** | 2 |
| 5. Driver ergonomics | **4** | 3 | 3 | 3 |
| 6. Fit with hunt.ts | **5** | 4 | **5** | **5** |
| **Total** | **25** | 20 | 23 | 20 |

### 1. Correctness of first-claim-wins and requestId idempotency
- **A (5).** Receipts are keyed by `(playerId, requestId)` and store a canonical fingerprint. An identical replay returns the stored result. A changed payload gets `request-conflict` and the original is kept (gpt.md:208). Overdue rounds are reconciled first, and then the receipt is looked up before any state check. So an earlier winning claim still replays `ok` after the round ends, and a new claim gets `expired` or `stale` (gpt.md:206). Same-millisecond claims resolve by commit order (gpt.md:241). It explicitly warns that a per-socket queue is not a concurrency guarantee (gpt.md:196). A is the only candidate that handles a changed payload.
- **B (4).** The receipt is read in the same transaction as the mutation (grok.md:325). `decideClaim` is pure, and its `now >= endsAt` check closes the deadline race (grok.md:109-117). A late claim ends the round itself (grok.md:349). Same-millisecond claims are handled (grok.md:351). Receipts are keyed only by `requestId` across all players, and a changed payload silently gets the old verdict.
- **C (3).** It uses `receipts(requestId PK…)` (muse.md:145) and replays stored verdicts (muse.md:176). The finder comes from the socket attachment (muse.md:152), and same-millisecond claims are covered (muse.md:178). It never detects a changed payload. It prunes receipts 24 hours after a round ends (muse.md:176), which is acceptable because roundId guards then reject the claim.
- **D (3).** The receipt is checked first and `now < endsAt` is required (gemini.md:320). `claimed:true/false` is clear (gemini.md:321-322). But each claim carries its own `player` (gemini.md:31), so the finder's identity comes from the payload. A changed payload is not detected.

### 2. Recovery
- **A (5).**
  - Plant output publishes only if its slot still holds its round id (gpt.md:229).
  - `endedAt = endsAt` even when the alarm is late (gpt.md:230).
  - A single alarm takes the minimum of all timed work (gpt.md:231).
  - It is the only candidate that names and closes the gap between a state commit and setting the alarm. It pre-arms an early alarm and reconciles in the constructor (gpt.md:232).
  - A failed plant stays visible as `plantError` instead of a fabricated `ended` round (gpt.md:229).
- **B (3).** It has a recovery watchdog alarm (grok.md:345) and a no-re-mint resume (grok.md:343), and it reloads in the constructor (grok.md:367). It never says a plant result must match the slot's round id before it publishes. `cancelled` deletes `next` (grok.md:347), so a still-running old task could write into a newer `next`.
- **C (4).** Completion commits only if `next` is still that planting id, and late results are dropped (muse.md:158). It has a watchdog alarm (muse.md:162), and resume is deterministic because the seed is persisted. It has no alarm pre-arm.
- **D (3).** Finalize checks the round id (gemini.md:317) and the alarm is multiplexed (gemini.md:325). But it uses `endedAt: now` on a late alarm (gemini.md:325). Its cold path also starts a new `current` plant while `next` may still be planting (gemini.md:314), which can leave two plant tasks running for one room.

### 3. Smallest protocol that covers the game
- **A (2).** The wire is small: hello, 4 commands, and 3 server messages. The behaviour around it is heavy:
  - player keys hashed into player ids (gpt.md:189)
  - `expectedRevision` on difficulty
  - fingerprint canonicalization
  - limits of 32 sockets and 128 lifetime identities, plus IP limits (gpt.md:192)
  - a byte-rate ingress bucket (gpt.md:191)
  - a two-step `prepare` then `start` (gpt.md:201-202)

  That is a lot for two builders in one night.
- **B (3).** It has 5 commands and 4 server messages. The rekey, epoch, and "write meta from the snapshot handler, then read it back" handshake (grok.md:357-359) is the costliest part of any candidate's join flow.
- **C (4).** It has 4 retriable commands plus ping. Losing `board.offer` calls are a harmless `ok` no-op (muse.md:151). The cold start goes from planting to live on its own (muse.md:150).
- **D (4).** It is the leanest wire: 4 commands, 3 events, and no hello. `round.start` both promotes the next round and pre-plants from the same board, so it needs no upload message (gemini.md:313). Its unauthenticated `POST /api/rooms` brings back an endpoint the others removed.

### 4. Security that fits the threat
- **A (4).**
  - The token travels in the hello body, not the URL (gpt.md:187).
  - `roomId = SHA256(token)` makes a URL/body mismatch checkable (gpt.md:186).
  - Identity is derived on the server (gpt.md:189).
  - Rate-limit counters survive hibernation (gpt.md:191).

  It is over-built for trusted collaborators. And when private storage is unavailable, `playerKey` loses identity on every reload (gpt.md:189).
- **B (3).** The token is a query parameter (grok.md:357), which ends up in URL logs. `playerId` is asserted by the client (grok.md:198). The buckets live in memory, so eviction clears them (grok.md:361).
- **C (4).** The token is in the hello and is stored as a SHA-256 hash (muse.md:168). There is no create endpoint (muse.md:169). Failed hellos are throttled per room. It honestly documents that identity is self-asserted (muse.md:192). This fits the stated threat best for its cost.
- **D (2).** The token is in the query string (gemini.md:333). Anyone can mint rooms through the unauthenticated `POST /api/rooms` (gemini.md:332). Identity is in each claim (gemini.md:31), so any socket can score for anyone. Its `timingSafeEqual` comparison is good.

### 5. Driver ergonomics
- **A (4).**
  - `open(hello, receive)`, `send`, and `close` are clean, and `open` resolves on the first snapshot (gpt.md:40-44, 237).
  - The FIFO outbox replays only after the snapshot (gpt.md:239).
  - LocalHost runs the same reducer (gpt.md:243).
  - Only the winning originator writes the found marker, with a journaled id (gpt.md:220).
  - It is the only candidate to handle laser attribution and the "full visible set" laser semantics (gpt.md:214-216).

  The two-step start and the `playerKey` storage dance are friction.
- **B (3).** It has a good `connect`/`subscribe` split (grok.md:62), and `connect` resolves on the snapshot (grok.md:365). LocalHost round-trips through `toWire` and the parser (grok.md:371). It never says who writes the found marker. It sends no `serverNow`, so the countdown drifts with the client clock.
- **C (3).** `HuntHost` has no connect step, and `send` takes `hello` and `ping` (muse.md:47-48). The marker writer is ambiguous ("their own scene marker", muse.md:152), which risks one duplicate marker per driver. The outbox is well specified (muse.md:176).
- **D (3).** `claimed:true` picks the marker writer, and a `meta.iitFound` check prevents duplicates (gemini.md:341). Its LocalHost is promised in protocol.ts but missing (gemini.md:345). With no hello, identity rides on every command.

### 6. Fit with hunt.ts
None of the four changes hunt.ts.
- **A (5).** It uses `Room` as-is and keeps `plantError` beside it. Its wire-only shapes are envelopes only.
- **B (4).** It adds 5 wire-only shapes: `WireRoom`, `WireCurrent`, `WireNext`, `PlayerCard`, and `FrameMeta` (grok.md:14-30). They exist on purpose, to hide unplayed targets.
- **C (5).** It uses `Room` plus `PlayerInfo` and `Snapshot`.
- **D (5).** It uses `Room` as-is plus `PlayerIdentity`.

## Recommended base: A (gpt), trimmed

A is the only candidate whose idempotency, stale-plant guard, and alarm recovery are all correct as written, and its validators are the strictest. Its weakness is size. The fix is to delete parts, not redesign anything. Before building, cut these:
- **`playerKey` and hashed player ids.** Use the Drawdy user id from `collaboration:get-all-users-in-board` as `playerId`. It is self-asserted, which the trusted-collaborator threat allows. It is stable across reloads and matches presence colours. Relax the `hex` checks on `playerId`, `self`, and `league` to `id`.
- **`expectedRevision` on `difficulty`.** Keep only the "no live round, no planting" guard.
- **The 128-identity cap, IP limits, and the byte-rate bucket.** Keep 10 commands per second with a burst of 20, one upload per 5 s, and the 256 KiB frame cap.
- **Fingerprint canonicalization.** The driver replays the identical object, so `JSON.stringify` of the parsed command is a stable fingerprint.
- **The parameter property at gpt.md:155.** Assign `code` in the constructor body instead.

## Grafts worth porting

1. **Single-step start with an auto-live cold path, and no-op losers for pre-plant uploads.** Source: muse.md:150-151 (with gemini.md:313 for reusing the start board). This replaces A's `prepare` then `start` pair (gpt.md:201-202) and its `busy` code for racing uploads. The click becomes `start{board}`. The cold path goes from planting to live in one step. A ready `next` is promoted. A losing pre-plant upload receives `ok` with no effect.
2. **A pure `decideClaim`, shared by the Room and LocalHost.** Source: grok.md:104-117. It is the concrete "same reducer" that A promises at gpt.md:243. It is also unit-testable for the same-millisecond case without a Worker.
3. **Hiding unplayed targets on the wire with `toWire`.** Source: grok.md:92-104, with the test at grok.md:379. A sends a ready round's targets to every client before the round is live, and so do C and D. One function on the server, one check in the parser, and the round cannot be spoiled from devtools.
4. **Dedupe the found marker by a scene meta tag, not a private journal.** Source: gemini.md:341, tagging with `meta.iitFound = "<roundId>:<targetId>"`. Combine it with A's "only the winning originator writes" rule (gpt.md:220). A query of the hunt frame replaces A's privately journaled id, so marker retries need no driver storage.

## What every candidate got wrong

1. **A moved hunt frame breaks every round.** `Target.rect` is in canvas space (hunt.ts:19-20), and no candidate re-anchors to the hunt frame's current position. C names the risk (muse.md:193) but does not fix it. Previews and `JudgeFn` should translate by the difference between the frame's current position and `round.frameRect`. That is a driver-side fix with no wire change.
2. **No candidate designs the second player's join.** A collaborator's driver cannot read the frame `meta`, draw previews, or subscribe to the laser until that user clicks our action button (FACTS rule 3). Nothing ungated can even tell it a hunt is running. Every proposal describes the creator's click. None says the button needs a "Join hunt" state, or that each player must click before their previews appear.
3. **No candidate validates `meta.iit` when reading it from the scene.** A copied, hand-edited, or older hunt frame can carry a malformed or foreign `{roomId, token}`. A's server-side `roomId = hash(token)` check (gpt.md:186) catches a mismatch, but no driver rejects a bad shape before connecting.
