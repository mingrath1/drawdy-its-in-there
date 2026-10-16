# It's In There! Fact sheet for builders

Read this in full before writing code. Every builder, reviewer, and verifier works from it.

## The product

You select a frame on a Drawdy board and press **Hunt**. Line-art stamps (cats, the number 229, and others) are now hidden inside what your group drew. Everyone races to circle them with Drawdy's laser pointer. Each find bursts in the finder's colour, and the scoreboard ticks. The next, harder round is already being hidden while you play.

Three rules hold everywhere.
1. **The AI never draws.** Stamps are bundled line art. The host only chooses where to hide them, checks they are findable, and writes the taunts.
2. **The user's elements are never edited.** Targets are drawn as local preview elements on each player's screen. The only scene writes are a small "found" marker per find and the hunt frame, both inside our own frame.
3. **Nothing gated runs before a click.** A dismissed permission dialog silently saves Deny for good. Issue no `dom`, `scene`, `collaboration`, or `storage` command until the user clicks our action button. Creating the action button is ungated.

## Layout

| Path | Owner | What it holds |
|---|---|---|
| `manifest.json`, `src/` | driver | The Drawdy driver. Drawdy builds `src/index.ts` with esbuild into one CommonJS file. Relative imports only. The only package import allowed is `@drawdy/driver-protocol`, which is types only. |
| `src/shared/hunt.ts` | shared | The hunt domain model. Both sides import it. Do not fork it. Propose changes in your report. |
| `src/shared/protocol.ts` | shared | The wire protocol between driver and room. Arrives from the design step. |
| `server/` | backend | The Room backend, copied from `earendil-works/pi-durable-cloudflare` at commit `dcb56ce` (MIT, keep the notice). |
| `docs/` | coordinator | Facts, plan, and decisions. |

Commands, from the repo root:
- `npm run dev -- --port 5183` runs the dev server. **Use port 5183.** Port 5173 belongs to another project running on this machine.
- `npm run typecheck`
- `npm run build` writes `dist/mingrath1-its-in-there.drawdyx`

## Probe facts already measured on this machine

These come from a sibling project's probes on 2026-10-17, on a local Drawdy board.
- The starter hot-reloads on save. Dev links work only on local boards. A cloud board needs a private extension installed from a public GitHub repo.
- The worker origin is `null`. The backend's CORS and WebSocket handling must accept `Origin: null`.
- From the driver worker, public HTTPS `fetch` works and `WebSocket` exists. **`localhost` is blocked.** A backend must be on public HTTPS to be reachable from Drawdy.
- A webview (`command:webview:create`) is a fixed 320 by 500 docked panel. It can talk to the driver through `acquireDrawdyApi()`.
- A floating element `iframe` with `srcDoc` can be any size, but it cannot talk to the driver.
- A malformed DOM schema, such as `fontSize: 11` instead of `[11, "px"]`, gets **no response at all**, so the awaiting call hangs. Validate DOM schemas in our own code and use a timeout on every command.
- Reloading `drawdy.io/` opens the most recent board. Always navigate to the exact `?local=<id>` URL.
- `webview:create` needs `dom`. `subscription:dom:element-clicked` and the first `create-action-button` are ungated.

## Protocol facts that shape the design

These are from `research/context/ddp-llms-full.txt` in the parent folder. A line number is in brackets.
- **Preview elements are local.** They never persist, sync, or survive a refresh [303]. A hit-testable preview reports clicks without selecting [321]. Every player's driver draws its own copy of the targets from the shared round.
- **`subscription:tool:laser`** fires on pointer-up with **every** currently visible laser stroke of the session, not a delta. It fires once more with an empty list when the trail fades [1585 to 1596]. Track which strokes you already judged. Whether collaborators' lasers are included is undocumented, so each finder's driver reports its own finds.
- **`LocalAnimation`** is an element property that syncs. Its playback phase does not [963]. Use it for the find burst on our own marker element.
- **Scene events carry no author** [1472 to 1499]. Drag events carry ids only, and `dragEnd` carries nothing [1562 to 1567].
- **`add-drawdy-elements` fails the whole batch** if any id already exists [271]. Mint ids with `ctx.generateId()` [1286].
- **Frames clip their children.** Membership is explicit through `frameId` [272 to 274].
- **`capture-screenshot`** returns a PNG blob of a canvas rect [264 to 266].
- **Presence is read-only.** `command:collaboration:get-all-users-in-board` and `subscription:collaboration:presence-changed` give each user's id, name, colour, and cursor [565 to 590, 1603 to 1607].
- **There is no audio API and no video element.**
- **`auth:check-logged-in` returns only a boolean.** There is no board id. The room id lives in the hunt frame's `meta`.

## Backend facts

- `server/` starts from `pi-durable-cloudflare`. It has one Durable Object per session, hibernating WebSockets with broadcast, DO SQLite storage for pi-durable, recovery and schedule alarms, a `requestId` receipt for retries, and tests that use a fake model provider and evict the object mid-run.
- **No model API key exists on this machine.** The default host is deterministic. It places targets with a density heuristic and verifies them with geometry, and its taunts are bundled Thai and English lines. An LLM host is optional, turned on only by a Worker secret. Tests never call a paid model.
- pi-durable still earns its place without a model:
  - planting and verifying run as durable child tasks with `allSettled`
  - the next round is prepared during the current one
  - finds are deduplicated by `requestId`
  - the room's league and difficulty persist
  - an alarm can open a daily hunt
- The repo has no auth. Add a per-room join token stored in the hunt frame's `meta`, and a simple per-connection rate limit.

## Working rules

- Work only in the worktree path your brief names. Run every command there.
- Commit in small steps with clear messages. Do not push and do not deploy. The coordinator does both.
- Keep comments only for a non-obvious why.
- End with a report covering what you built, what you verified and how, what is unverified, and your commit SHAs.
