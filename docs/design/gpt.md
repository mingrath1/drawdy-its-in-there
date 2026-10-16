# It's In There! protocol proposal

The data shape is the existing `Room`, plus a monotonically increasing revision and a recoverable planting error. Send full snapshots, not patches. Up to 32 targets and 128 league entries make this small enough and remove event-log recovery from the driver. This is a cooperative game, not an anti-cheat system.

## Complete `src/shared/protocol.ts`

```ts
import type { BoardSnapshot, Room } from "./hunt.ts";

export const VERSION = 1 as const;
export const MAX_FRAME_BYTES = 262144;
export type Hello = {
  v: 1; type: "hello"; roomId: string; joinToken: string;
  playerKey: string; name: string; color: string;
};
type Envelope = { v: 1; requestId: string };
export type Command = Envelope & (
  | { type: "prepare"; afterRoundId: string | null; board: BoardSnapshot }
  | { type: "start"; roundId: string }
  | { type: "claim"; roundId: string; targetId: string }
  | { type: "difficulty"; expectedRevision: number; value: number }
);
export type ClientMessage = Hello | Command;
export type ResultCode = "ok" | "stale" | "busy" | "not-ready"
  | "not-live" | "expired" | "unknown-target" | "taken" | "request-conflict";
export type Snapshot = {
  v: 1; type: "snapshot"; revision: number; serverNow: number;
  self: string; room: Room; plantError: string | null;
};
export type Result = {
  v: 1; type: "result"; requestId: string; command: Command["type"];
  code: ResultCode; revision: number;
};
export type Fault = {
  v: 1; type: "fault";
  code: "invalid" | "version" | "auth" | "rate-limit" | "unavailable" | "full";
  retryAfterMs: number;
};
export type ServerMessage = Snapshot | Result | Fault;
export interface HuntHost {
  open(hello: Hello, receive: (message: ServerMessage) => void): Promise<void>;
  send(command: Command): void;
  close(): void;
}

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const own = (x: object, k: string) => Object.prototype.hasOwnProperty.call(x, k);
const one = (...values: unknown[]): Check => x => values.includes(x);
const text = (max: number): Check => x =>
  typeof x === "string" && x.length > 0 && x.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(x);
const number = (min: number, max: number): Check => x =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const integer = (min: number, max: number): Check => x =>
  number(min, max)(x) && Number.isSafeInteger(x);
const uint = integer(0, Number.MAX_SAFE_INTEGER);
const time = integer(0, 8640000000000000);
const difficulty = integer(1, 20);
const coordinate = number(-10000000, 10000000);
const dimension = number(0.001, 1000000);
const id: Check = x => typeof x === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(x);
const hex: Check = x => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const color: Check = x => typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x);
const nullable = (check: Check): Check => x => x === null || check(x);
const array = (check: Check, max: number, min = 0): Check => x =>
  Array.isArray(x) && x.length >= min && x.length <= max && x.every(check);
const shape = (required: Fields, optional: Fields = {}): Check => x =>
  record(x) && Object.keys(required).every(k => own(x, k) && required[k]!(x[k])) &&
  Object.keys(x).every(k => own(required, k) || (own(optional, k) && optional[k]!(x[k])));
const rect = shape({ x: coordinate, y: coordinate, width: dimension, height: dimension });
const itemRect = shape({ x: coordinate, y: coordinate,
  width: number(0, 1000000), height: number(0, 1000000) });
const point: Check = x => Array.isArray(x) && x.length === 2 && x.every(coordinate);
const item = shape({ rect: itemRect,
  kind: one("freedraw", "shape", "text", "image", "line", "other") },
  { strokeColor: color, strokeWidth: number(0, 100), points: array(point, 128) });
const board: Check = x => {
  if (!shape({ frameRect: rect, items: array(item, 512) })(x) || !record(x)) return false;
  const items = x.items as Record<string, unknown>[];
  return items.reduce((n, i) => n + (Array.isArray(i.points) ? i.points.length : 0), 0) <= 8192;
};
const target = shape({ id, stampId: id, rect, rotationDeg: number(-360, 360),
  strokeColor: color, strokeWidth: number(0.01, 100) });
const find = shape({ targetId: id, playerId: hex, playerName: text(64),
  playerColor: color, at: time });
const leagueEntry = shape({ playerId: hex, playerName: text(64), finds: uint, roundsWon: uint });
const unique = (items: unknown, key: string): boolean => {
  if (!Array.isArray(items)) return false;
  return new Set(items.map(x => record(x) ? x[key] : undefined)).size === items.length;
};
const round: Check = x => {
  if (!record(x)) return false;
  const base = { id, frameRect: rect };
  if (x.status === "planting") return shape({ ...base, status: one("planting") })(x);
  const ready = { ...base, targets: array(target, 32, 1) };
  if (!unique(x.targets, "id")) return false;
  if (x.status === "ready") return shape({ ...ready, status: one("ready") })(x);
  const played = { ...ready, startedAt: time, finds: array(find, 32) };
  const valid = x.status === "live"
    ? shape({ ...played, status: one("live"), endsAt: time })(x)
    : shape({ ...played, status: one("ended"), endedAt: time,
        reason: one("all-found", "time-up", "cancelled") })(x);
  if (!valid || !unique(x.finds, "targetId")) return false;
  const end = (x.status === "live" ? x.endsAt : x.endedAt) as number;
  const start = x.startedAt as number;
  if (end < start || (x.status === "live" && end === start)) return false;
  const targets = x.targets as { id: string }[];
  return (x.finds as { targetId: string; at: number }[]).every(f =>
    targets.some(t => t.id === f.targetId) && f.at >= start && f.at <= end);
};
const room: Check = x => {
  if (!shape({ roomId: hex, difficulty, league: array(leagueEntry, 128),
    current: nullable(round), next: nullable(round), roundsPlayed: uint })(x) || !record(x)) return false;
  if (!unique(x.league, "playerId")) return false;
  if (x.next === null) return true;
  if (!record(x.next) || !record(x.current)) return false;
  return (x.next.status === "planting" || x.next.status === "ready") &&
    (x.current.status === "live" || x.current.status === "ended") && x.next.id !== x.current.id;
};
const commands = ["prepare", "start", "claim", "difficulty"] as const;
const commandBase = { v: one(VERSION), requestId: id };
const clientChecks: Record<ClientMessage["type"], Check> = {
  hello: shape({ v: one(VERSION), type: one("hello"), roomId: hex, joinToken: hex,
    playerKey: hex, name: text(64), color }),
  prepare: shape({ ...commandBase, type: one("prepare"), afterRoundId: nullable(id), board }),
  start: shape({ ...commandBase, type: one("start"), roundId: id }),
  claim: shape({ ...commandBase, type: one("claim"), roundId: id, targetId: id }),
  difficulty: shape({ ...commandBase, type: one("difficulty"), expectedRevision: uint, value: difficulty }),
};
const serverChecks: Record<ServerMessage["type"], Check> = {
  snapshot: shape({ v: one(VERSION), type: one("snapshot"), revision: uint,
    serverNow: time, self: hex, room, plantError: nullable(text(256)) }),
  result: shape({ v: one(VERSION), type: one("result"), requestId: id,
    command: one(...commands), revision: uint,
    code: one("ok", "stale", "busy", "not-ready", "not-live", "expired",
      "unknown-target", "taken", "request-conflict") }),
  fault: shape({ v: one(VERSION), type: one("fault"),
    code: one("invalid", "version", "auth", "rate-limit", "unavailable", "full"),
    retryAfterMs: integer(0, 3600000) }),
};
function matches(value: unknown, checks: Record<string, Check>): boolean {
  return record(value) && typeof value.type === "string" && own(checks, value.type) &&
    checks[value.type]!(value);
}
export function validateClient(value: unknown): value is ClientMessage {
  return matches(value, clientChecks);
}
export function validateServer(value: unknown): value is ServerMessage {
  return matches(value, serverChecks);
}
export class ProtocolError extends Error {
  constructor(readonly code: "invalid" | "version") { super(code); }
}
function decode(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES ||
    new TextEncoder().encode(raw).length > MAX_FRAME_BYTES) throw new ProtocolError("invalid");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError("invalid"); }
  if (record(value) && value.v !== VERSION) throw new ProtocolError("version");
  return value;
}
export function parseClient(raw: unknown): ClientMessage {
  const value = decode(raw);
  if (!validateClient(value)) throw new ProtocolError("invalid");
  return value;
}
export function parseServer(raw: unknown): ServerMessage {
  const value = decode(raw);
  if (!validateServer(value)) throw new ProtocolError("invalid");
  return value;
}
export function encode(message: ClientMessage | ServerMessage): string {
  const raw = JSON.stringify(message);
  const value = decode(raw);
  if (!validateClient(value) && !validateServer(value)) throw new ProtocolError("invalid");
  return raw;
}
```

## Join, creation, and admission

- After the Hunt click, read the selected artwork frame. Create a separate, driver-owned hunt frame over its rect. Do not attach metadata to the user's frame or adopt the user's children. Mint the hunt frame id with `ctx.generateId()`.
- Generate a cryptographically random 32-byte join token. Define `roomId = hex(SHA256("iit-room-v1:" + joinToken))`. Add the new hunt frame with `meta.iit = {v:1, roomId, joinToken}` in that same scene creation. Thus every hunt frame starts with complete credentials. Concurrent creators make distinct hunt frames and rooms, rather than racing to update one frame's metadata. Opening an existing hunt frame never overwrites its credentials.
- Open public `wss://backend/rooms/{roomId}`. The first text frame is `hello`; no query-string credentials. Match the path id and recompute the token-derived id before opening the harness or returning any room data. A valid hello initializes an absent room atomically with difficulty 1. Replaying hello on a fresh socket joins the same room. There is no separate create endpoint or create receipt to lose.
- The Worker accepts `Origin: null`. Origin is not authentication. Use TLS, redact hello bodies from logs, and send no token in snapshots. Return CORS headers allowing `null` for any HTTP preflight; WebSocket authentication does not depend on CORS. Cap unauthenticated sockets and close after five seconds without hello. A second hello on an authenticated socket is invalid.
- Generate a separate private 32-byte `playerKey` per room and store it through gated driver storage only after confirming that storage is user-private. DDP documents driver scoping, not cross-user confidentiality; until the two-user probe proves it, keep the key in memory. Derive `playerId = hex(SHA256("iit-player-v1:" + roomId + ":" + playerKey))`. The room uses this id, never a player id supplied in a claim. Names and colours are unverified display data. Normalize colours to six-digit hex before hello. If storage is denied, retain the key in memory and explain that reload creates a new identity.
- A room token grants equal gameplay rights to its holders. Board editors can copy it; it is not board-membership verification. A copied hunt frame intentionally joins the same room until the user explicitly creates a new hunt. Account authentication, token rotation, and moderation are outside v1.
- Limit each connection to 10 commands/second with burst 20, uploads to one per five seconds, and ingress to 512 KiB/minute with a 256 KiB burst. Persist token-bucket counters in the hibernating socket attachment along with authenticated identity. Invalid frames close with 1002, oversized frames with 1009. Excess traffic gets `fault/rate-limit`, a retry delay, and close 1008. This fault is not a terminal command receipt.
- Also cap 32 authenticated sockets and 128 lifetime player identities per room, and apply Worker-level IP connection/create limits. Per-connection limits alone cannot prevent reconnect abuse. A new identity at capacity receives `fault/full` without mutating the room.

## Room state and each message

All mutation decisions run inside a single `harness.commit`, including receipt lookup. Keep the Room document, revision, planting error, immutable plant inputs, and receipt documents in the same pi-durable storage. Do not copy the template's per-socket queue as the concurrency guarantee; different sockets still race. Commit serialization is the guarantee.

| Input | Admission and atomic result |
| --- | --- |
| `hello` | Authenticate, bind the socket attachment, register or refresh the league display name, reconcile an expired round, then send the entire snapshot before accepting commands. Other sockets receive a snapshot if public state changed. |
| `prepare` | Any player may upload geometry. `afterRoundId` must equal `current?.id ?? null`. With no current round, reserve `current`; with a live or ended current, reserve `next`. Reject an occupied slot with `busy`, except a failed planting slot may be replaced with a fresh id. Reject while current is planting or ready. Persist the bounded board, random seed, bundled stamp catalogue version, difficulty, count, new round id, and durable task together. Return `ok` for admission, not completion. |
| `start` | Any player may start `current` when ready, or promote a ready `next` when current has ended. Match the explicit round id. Never start during a live round, and never implicitly queue a start. Set `startedAt = now`, `endsAt = now + 60000`, and empty finds. Set room difficulty to this round's captured difficulty. |
| `claim` | Require current id to match, status live, `now < endsAt`, and an existing, unclaimed target. Copy the authenticated player's profile into `Find`, using server time. Append the find and increment that player's league finds in the same commit. Unknown ids receive `unknown-target`; an already claimed target receives `taken`. No client timestamp can win or extend a round. |
| `difficulty` | Any player may set 1..20 only when no live round and no nonfailed planting task exist. Require `expectedRevision` to match. Abort failed work, discard unplayed ready/failed slots, clear the error, preserve an ended current and the league, then set difficulty. The next prepare uses this explicit choice. A stale command cannot override a later round. |

Before every authenticated command, reconcile `now >= endsAt`. Then look up its receipt before evaluating command-specific state. This preserves an earlier successful claim's `ok` even after the round ends. A rejected new claim at the deadline gets `expired`; older round ids get `stale`. Resolve all other state conflicts to the codes above.

Receipts are keyed by `(playerId, requestId)` and contain the canonical command fingerprint, command kind, and terminal result. Canonicalize object keys before hashing, while preserving array order. Store successes and gameplay rejections for the room's lifetime. An identical retry returns the exact result; changed payload under an existing id returns `request-conflict` without replacing the original. Do not acknowledge transient storage failures. Close 1011 and let replay discover whether a commit happened. Never prune receipts while still promising lifetime retry safety.

Increment revision once per public-state commit, not on receipt-only commits or replay. Broadcast the committed snapshot, then return the receipt. A replay also gets a fresh snapshot, because its stored result revision may be old. Clients ignore snapshots with lower revisions within a room. No durable replay cursor, per-find event, presence stream, or agent transcript crosses this socket.

## Judgment, previews, and scene writes

The driver evaluates the shared `JudgeFn(circle, target)` locally and sends one claim per matched target. It tracks the full laser array as a multiset of stroke fingerprints, rather than rejudging every stroke on every pointer-up. Reset that tracking on round changes and the empty fade event. Claims are never emitted from scene-change events, which have no author.

Laser attribution is undocumented. If collaborators' trails appear locally, the driver must filter using a locally initiated pointer gesture or offer a scoped DOM drag-circle control like drawdy-bomb. That control builds the same `Circle` and calls the same JudgeFn. Do not claim every visible remote stroke. The room intentionally trusts a valid player's claim; even sending the circle would not prevent a modified client from cheating.

Every player renders only the current ready/live targets as local previews, rebuilding them from snapshots after reconnect. `next` is never rendered. Stamp ids refer only to bundled art. A find removes that target preview and shows the burst in the winner's colour. Wire version 1 pins the bundled catalogue and geometry conventions; incompatible changes require a wire-version bump. An unknown stamp id is a protocol incompatibility, never a substitute drawing.

Only the driver that originated the winning claim writes its small found marker, inside the owned hunt frame with explicit `frameId`. It mints and privately journals one Drawdy id per `(roomId, roundId, targetId)` before the write. Retry the same id, query before retry after a timeout, and treat an existing matching marker as success. Other drivers do not write that marker. Multi-tab instances keep distinct claim requestIds; only the successful request owner writes. Marker failure never reverses a committed score. There is no cross-service transaction, so a winner who permanently disappears may leave no persistent marker; everyone still sees the authoritative find through the snapshot.

No gated scene, storage, collaboration, or DOM operations run at activation. Only the action button and its ungated click subscription run then. The official examples inform the preview and floating-control APIs, not permission sequencing. All Drawdy commands need schema validation and a timeout.

## Pre-planting, difficulty, and alarms

- Immediately after observing a live round with `next === null`, participating drivers may upload `prepare` using a fresh scene snapshot, excluding our own frames, markers, and previews. Jitter uploads to reduce collisions; first committed admission wins. This is an upload-triggered durable task, not browser background computation. A joining player can supply a missing upload. The room never fetches the board itself.
- Preparing behind a live round captures `min(20, room.difficulty + 1)`. Preparing after an ended round also uses that value, unless an explicit difficulty change has set a private pending override. Consume that override on preparation. The first round uses room difficulty. Persist the selected value with the plan so recovery never recomputes it from mutable room state.
- Create a background `PrepareRound` task owned by the root conversation. It creates a Plant child that invokes the shared deterministic `PlantFn`, then Verify children for containment, overlap, allowed stamps, and geometric findability. The parent commits waiting states with `policy: "allSettled"`, reads outcomes, and publishes ready only if all checks pass. Children are pure and may rerun. Fixed input seed and catalogue/algorithm version make reruns reproducible. No model secret is needed.
- Each task publishes only if its reserved slot still contains its round id. Difficulty changes or replacement plans cannot receive stale output. A failed task keeps its slot planting and stores `plantError`; a fresh prepare may replace that failed reservation. Do not fabricate a played `ended` round with nonexistent start timestamps. No `hunt.ts` changes are required; this error and plan bookkeeping live beside Room.
- When all targets are found, end immediately. Otherwise the deadline ends the round with `endedAt = endsAt`, even if the alarm arrived late. Ending increments roundsPlayed exactly once. Award one roundsWon to every player tied for the highest positive find count in that round; a zero-find round awards none. Do not increment finds again at round end. Never auto-start the next round without a click.
- Cloudflare has one platform alarm. Extend the template's serialized alarm reconciler to choose the minimum of live `endsAt`, task recovery deadlines, and optional persisted daily-hunt deadlines. Never let task completion delete a live-round alarm. Reconcile overdue rounds before any snapshots or commands and on alarm wake.
- Close the state/alarm crash gap by arming an early recovery alarm before any commit that introduces timed work. For start, pre-arm no later than the intended deadline, then commit. After commit, recompute the exact minimum. On constructor wake reopen the Harness, resume tasks, finalize overdue rounds, and recompute the alarm before serving clients. An unnecessary early alarm is harmless; a missing wake-up is not.
- Optional daily alarms may prepare a ready round from a retained, explicitly reusable board snapshot. They cannot read a changed board or silently start a live round. This adds no wire message.

## Reconnect and offline execution

`HuntHost.open` resolves after the first authenticated snapshot and calls `receive` with it. `send` synchronously validates and enqueues an immutable command, then sends when connected. The RemoteHost owns reconnect, exponential jittered backoff capped at 30 seconds, and a FIFO outbox. Enqueue before transmission. Retain original requestIds and payloads until a matching terminal result arrives; faults retain the outbox. Stop automatic reconnect on auth/version failure. Do not queue new guesses while disconnected, because the authoritative deadline continues.

Replay begins only after the new connection's snapshot. Replay old commands unchanged even when the snapshot looks newer, because a lost receipt may represent committed work. The explicit round ids and revision preconditions prevent replay from affecting a newer round. Persist the outbox and private player key through gated driver storage when permitted and confirmed user-private; without that guarantee, socket reconnect is recoverable but worker reload loses pending commands. A reload still reconstructs scores and targets from the room snapshot. `close` stops transport, not the durable round.

Eviction loses only process memory. SQLite retains room state, scores, receipts, plan inputs, task checkpoints, and deadline. Hibernating socket attachments retain identity and rate counters. Reopen the registered task definitions and resume them. Send fresh snapshots to surviving authenticated sockets. If two players claim the same target in the same millisecond, commit order chooses exactly one winner. Timestamp equality does not create a tie, and a later transaction sees the first find. Fairness is server arrival/commit order, not latency compensation.

With no backend URL, instantiate LocalHost, not a fallback after network failure. It implements the identical HuntHost contract, runs the same reducer, validation, PlantFn, JudgeFn, receipt rules, and snapshots, and derives the same identities locally. Replace durable task execution with local promises and the platform alarm with a timeout plus deadline checks on every command/open. Save local state after each transition if driver storage is available; on reload, resume pending deterministic planting and expire overdue rounds. Otherwise label the session memory-only. Keep local credentials/state in private storage, not shared frame metadata, so another player's offline driver cannot pretend to join a shared league. An offline frame contains only a local-mode marker. No automatic merge of local and online leagues exists.

## Three principal risks and their tests

1. Atomic scoring, task publication, and alarm recovery can diverge around crashes. Adapt `test/recovery.test.ts` with faux/no-model task definitions. Evict before and after receipt commits, after pre-arming but before start commit, between task child completion and publication, and at the deadline. Race 100 claims for one target with a frozen millisecond. Assert one find, one league increment, stable retry result, no stale plan publication, and a retained minimum alarm. Repeat alarm delivery and assert roundsPlayed and roundsWon do not increase twice.
2. The trust boundary can leak credentials or admit unbounded work. Fuzz both parsers with wrong versions, prototype-shaped keys, unknown fields, binary frames, oversized UTF-8, duplicate target ids, nonfinite geometry, and huge arrays. Test wrong token, URL/body room mismatch, stolen room token without playerKey, expired hello timeout, and counter recovery after hibernation. Verify logs never contain tokens and no unauthenticated snapshot or plant task is produced. Probe driver KV with two different users before treating it as private credential storage. Admit explicitly that room members can make dishonest find claims.
3. Browser behavior can break local judgment and replay. Run two real Drawdy workers against a public test backend, observe local versus remote laser arrays, circle once while older trails remain, disconnect after commit before receipt, and reload during planting. Assert one claim per local stroke/target, one winning writer, matching previews, preserved source artwork, and no permission prompt before the click. Run the identical scripted command traces against LocalHost and RemoteHost with a fake clock and compare snapshots after excluding server-specific timing. Cover denied storage and label its weaker reload guarantee.

## Evidence and scope

Inspected `docs/FACTS.md` in full, `src/shared/hunt.ts`, the DDP reference's scene/laser contracts, and the official bomb, math-symbol, and presentation implementations. Read upstream `src/session.ts`, `src/protocol.ts`, `src/client/command-outbox.ts`, and `test/recovery.test.ts` at `dcb56ce` through `gh api`, plus the full local pi-durable README. Retain the upstream MIT notice when copying the backend.

Verification extracted the TypeScript fence in memory and compiled it with strict TypeScript, `noUncheckedIndexedAccess`, and the actual `hunt.ts`. It passed. Ten valid client/snapshot round trips and seven malformed-input rejection cases passed without writing another file. This is parser smoke coverage, not the recovery suite above.

Model the Domain shaped the discriminated messages and existing Round state machine. Make Operations Idempotent shaped atomic receipts, generation-checked task publication, and replay. Design work ran in-thread as the assigned arena candidate; no nested delegation, repository edits, install, clone, deployment, or paid-model call was needed. This document proposes behavior; backend and browser recovery remain implementation tests, not claimed results.
