# It's In There! wire protocol

One Durable Object, class `Room`, per hunt frame. The driver (origin `null`) and that object speak the messages below. With no backend URL, `LocalHost` runs the same messages in process. A round's targets stay inside the object until that round is `live` or `ended`. No change to `hunt.ts`.

## `src/shared/protocol.ts`

```ts
import type { BoardItem, BoardSnapshot, Find, LeagueEntry, Rect, Room, Round } from "./hunt.ts";
export const PROTOCOL_VERSION = 1, MAX_FRAME_CHARACTERS = 200_000, MAX_REQUEST_ID_CHARACTERS = 64;
export const MAX_BOARD_ITEMS = 120, MAX_POINTS = 48, MAX_STAMP_IDS = 32, MAX_DIFFICULTY = 8, ROUND_MS = 60_000;
export const MAX_CONNECTIONS = 32, RATE_WINDOW_MS = 10_000, RATE_MAX_MESSAGES = 30, RATE_MAX_CLAIMS = 10;
export const RATE_UPLOAD_GAP_MS = 5_000, RECOVERY_ALARM_MS = 60_000;
/** Hunt-frame `meta.iit`. The room id is the frame element id. */
export type FrameMeta = { v: 1; roomId: string; token: string; epoch: number };
export type PlayerCard = { playerId: string; playerName: string; playerColor: string };
/** `planting` and `ready` omit targets. `next` is only this shape. */
export type WireCurrent =
  | { status: "planting"; id: string; frameRect: Rect }
  | { status: "ready"; id: string; frameRect: Rect }
  | Extract<Round, { status: "live" | "ended" }>;
export type WireNext = { status: "planting" | "ready"; id: string };
export type WireRoom = {
  roomId: string;
  difficulty: number;
  league: LeagueEntry[];
  current: WireCurrent | null;
  next: WireNext | null;
  roundsPlayed: number;
};
export type Hello = {
  v: 1;
  type: "hello";
  playerId: string;
  playerName: string;
  playerColor: string;
  rekey?: true;
};
export type RetryCommand =
  | { v: 1; type: "round.start"; requestId: string; board?: BoardSnapshot; stampIds?: string[] }
  | { v: 1; type: "board.upload"; requestId: string; roundId: string; board: BoardSnapshot; stampIds: string[] }
  | { v: 1; type: "find.claim"; requestId: string; roundId: string; targetId: string }
  | { v: 1; type: "difficulty.set"; requestId: string; difficulty: number }
  | { v: 1; type: "round.cancel"; requestId: string; roundId: string };
export type ClientCommand = Hello | RetryCommand;
export type CommandName = RetryCommand["type"];
export type CommandError = { code: string; message: string };
export type CommandResult = {
  v: 1;
  type: "command.result";
  command: CommandName;
  requestId: string;
  ok: boolean;
  error?: CommandError;
};
export type ServerEvent =
  | { v: 1; type: "snapshot"; you: string; epoch: number; room: WireRoom }
  | { v: 1; type: "room"; room: WireRoom }
  | CommandResult
  | { v: 1; type: "error"; error: CommandError };
/** Both the Durable Object socket and the offline host implement this. */
export interface HuntHost {
  connect(player: PlayerCard, join: { roomId: string; token: string; rekey: boolean }): Promise<void>;
  send(command: RetryCommand): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
  close(): void;
}

export class InvalidMessage extends Error {}

const KINDS = new Set(["freedraw", "shape", "text", "image", "line", "other"]);

const REASONS = new Set(["all-found", "time-up", "cancelled"]);

export function plantSeed(roundId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < roundId.length; i++) {
    hash ^= roundId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
/** Cold start uses `room.difficulty`. A pre-plant during a live round uses one step harder. */
export function plantDifficulty(roomDifficulty: number, preplant: boolean): number {
  const next = preplant ? roomDifficulty + 1 : roomDifficulty;
  return Math.min(MAX_DIFFICULTY, Math.max(1, next));
}

export function plantCount(difficulty: number): number {
  return Math.min(8, 2 + difficulty);
}
/** Drops targets on anything that is not live or ended. Throws if `next` is already revealed. */
export function toWire(room: Room): WireRoom {
  let current: WireCurrent | null = null;
  if (room.current?.status === "planting" || room.current?.status === "ready") {
    current = { status: room.current.status, id: room.current.id, frameRect: room.current.frameRect };
  } else if (room.current) current = room.current;
  let next: WireNext | null = null;
  if (room.next) {
    if (room.next.status !== "planting" && room.next.status !== "ready") throw new Error("next round is revealed");
    next = { status: room.next.status, id: room.next.id };
  }
  return { roomId: room.roomId, difficulty: room.difficulty, league: room.league, current, next, roundsPlayed: room.roundsPlayed };
}
export type ClaimInput = { roundId: string; targetId: string; player: PlayerCard; now: number };
export type ClaimDecision =
  | { ok: true; find: Find; end: "all-found" | null }
  | { ok: false; code: "taken" | "ended" | "round_mismatch" | "unknown_target" };
/** Pure. The caller holds the storage transaction, so the earlier commit wins a same-ms pair. */
export function decideClaim(round: Extract<Round, { status: "live" }>, input: ClaimInput): ClaimDecision {
  if (input.roundId !== round.id) return { ok: false, code: "round_mismatch" };
  if (input.now >= round.endsAt) return { ok: false, code: "ended" };
  if (round.finds.some((find) => find.targetId === input.targetId)) return { ok: false, code: "taken" };
  if (!round.targets.some((target) => target.id === input.targetId)) return { ok: false, code: "unknown_target" };
  const find: Find = { targetId: input.targetId, playerId: input.player.playerId, playerName: input.player.playerName, playerColor: input.player.playerColor, at: input.now };
  return { ok: true, find, end: round.finds.length + 1 === round.targets.length ? "all-found" : null };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(message: string): never {
  throw new InvalidMessage(message);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) fail(`${name} length`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} number`);
  return value;
}

function rect(value: unknown): Rect {
  if (!isRecord(value)) fail("rect");
  const box = {
    x: finite(value.x, "x"),
    y: finite(value.y, "y"),
    width: finite(value.width, "width"),
    height: finite(value.height, "height"),
  };
  if (box.width <= 0 || box.height <= 0 || Math.abs(box.x) > 1e7 || Math.abs(box.y) > 1e7) fail("rect bounds");
  return box;
}

function board(value: unknown): BoardSnapshot {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_BOARD_ITEMS) fail("board");
  const items: BoardItem[] = value.items.map((item) => {
    if (!isRecord(item) || typeof item.kind !== "string" || !KINDS.has(item.kind)) fail("board item");
    const points = item.points === undefined ? undefined : pointsOf(item.points);
    return {
      rect: rect(item.rect),
      kind: item.kind as BoardItem["kind"],
      ...(typeof item.strokeColor === "string" ? { strokeColor: text(item.strokeColor, "strokeColor", 32) } : {}),
      ...(item.strokeWidth !== undefined ? { strokeWidth: finite(item.strokeWidth, "strokeWidth") } : {}),
      ...(points === undefined ? {} : { points }),
    };
  });
  return { frameRect: rect(value.frameRect), items };
}

function pointsOf(value: unknown): ReadonlyArray<readonly [number, number]> {
  if (!Array.isArray(value) || value.length > MAX_POINTS) fail("points");
  return value.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) fail("point");
    return [finite(point[0], "px"), finite(point[1], "py")] as const;
  });
}

function stampIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STAMP_IDS) fail("stampIds");
  return value.map((id) => text(id, "stampId", 80));
}

function requestId(value: unknown): string {
  return text(value, "requestId", MAX_REQUEST_ID_CHARACTERS);
}

function version(value: Record<string, unknown>): void {
  if (value.v !== PROTOCOL_VERSION) fail("version");
}

export function parseClientCommand(message: string): ClientCommand {
  if (message.length > MAX_FRAME_CHARACTERS) fail("frame_too_large");
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch (cause) {
    fail(`json ${(cause as Error).message}`);
  }
  if (!isRecord(value) || typeof value.type !== "string") fail("command");
  version(value);
  if (value.type === "hello") {
    return {
      v: 1,
      type: "hello",
      playerId: text(value.playerId, "playerId", 80),
      playerName: text(value.playerName, "playerName", 40),
      playerColor: text(value.playerColor, "playerColor", 32),
      ...(value.rekey === true ? { rekey: true } : {}),
    };
  }
  const id = requestId(value.requestId);
  switch (value.type) {
    case "round.start":
      return {
        v: 1,
        type: "round.start",
        requestId: id,
        ...(value.board === undefined ? {} : { board: board(value.board) }),
        ...(value.stampIds === undefined ? {} : { stampIds: stampIds(value.stampIds) }),
      };
    case "board.upload":
      return {
        v: 1,
        type: "board.upload",
        requestId: id,
        roundId: text(value.roundId, "roundId", 80),
        board: board(value.board),
        stampIds: stampIds(value.stampIds),
      };
    case "find.claim":
      return {
        v: 1,
        type: "find.claim",
        requestId: id,
        roundId: text(value.roundId, "roundId", 80),
        targetId: text(value.targetId, "targetId", 80),
      };
    case "difficulty.set": {
      const difficulty = finite(value.difficulty, "difficulty");
      if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > MAX_DIFFICULTY) fail("difficulty");
      return { v: 1, type: "difficulty.set", requestId: id, difficulty };
    }
    case "round.cancel":
      return { v: 1, type: "round.cancel", requestId: id, roundId: text(value.roundId, "roundId", 80) };
    default:
      fail(`unknown ${value.type}`);
  }
}

function wireRoom(value: unknown): WireRoom {
  if (!isRecord(value) || !Array.isArray(value.league)) fail("room");
  return {
    roomId: text(value.roomId, "roomId", 80),
    difficulty: finite(value.difficulty, "difficulty"),
    league: value.league.map((entry) => {
      if (!isRecord(entry)) fail("league");
      return {
        playerId: text(entry.playerId, "playerId", 80),
        playerName: text(entry.playerName, "playerName", 40),
        finds: finite(entry.finds, "finds"),
        roundsWon: finite(entry.roundsWon, "roundsWon"),
      };
    }),
    current: value.current == null ? null : wireCurrent(value.current),
    next: value.next == null ? null : wireNext(value.next),
    roundsPlayed: finite(value.roundsPlayed, "roundsPlayed"),
  };
}

function wireNext(value: unknown): WireNext {
  if (!isRecord(value) || "targets" in value || "finds" in value) fail("hidden targets");
  if (value.status !== "planting" && value.status !== "ready") fail("next status");
  return { status: value.status, id: text(value.id, "id", 80) };
}

function wireCurrent(value: unknown): WireCurrent {
  if (!isRecord(value)) fail("current");
  if (value.status === "planting" || value.status === "ready") {
    if ("targets" in value || "finds" in value) fail("hidden targets");
    return { status: value.status, id: text(value.id, "id", 80), frameRect: rect(value.frameRect) };
  }
  if (value.status !== "live" && value.status !== "ended") fail("current status");
  if (!Array.isArray(value.targets) || !Array.isArray(value.finds)) fail("revealed round");
  const base = {
    id: text(value.id, "id", 80),
    frameRect: rect(value.frameRect),
    targets: value.targets,
    startedAt: finite(value.startedAt, "startedAt"),
    finds: value.finds,
  };
  if (value.status === "live") return { status: "live", ...base, endsAt: finite(value.endsAt, "endsAt") };
  if (typeof value.reason !== "string" || !REASONS.has(value.reason)) fail("reason");
  return { status: "ended", ...base, endedAt: finite(value.endedAt, "endedAt"), reason: value.reason as "all-found" | "time-up" | "cancelled" };
}

export function parseServerEvent(message: string): ServerEvent {
  if (message.length > MAX_FRAME_CHARACTERS) fail("frame_too_large");
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch (cause) {
    fail(`json ${(cause as Error).message}`);
  }
  if (!isRecord(value)) fail("event");
  version(value);
  if (value.type === "snapshot") {
    return { v: 1, type: "snapshot", you: text(value.you, "you", 80), epoch: finite(value.epoch, "epoch"), room: wireRoom(value.room) };
  }
  if (value.type === "room") return { v: 1, type: "room", room: wireRoom(value.room) };
  if (value.type === "error") return { v: 1, type: "error", error: errorOf(value.error) };
  if (value.type !== "command.result") fail("event type");
  const command = value.command;
  if (command !== "round.start" && command !== "board.upload" && command !== "find.claim" && command !== "difficulty.set" && command !== "round.cancel") fail("result command");
  return {
    v: 1,
    type: "command.result",
    command,
    requestId: requestId(value.requestId),
    ok: value.ok === true,
    ...(value.ok === true ? {} : { error: errorOf(value.error) }),
  };
}

function errorOf(value: unknown): CommandError {
  if (!isRecord(value)) fail("error");
  return { code: text(value.code, "code", 40), message: text(value.message, "message", 200) };
}
```

## Room behaviour

Storage is the template's Durable Object SQLite, one queue shared with pi-durable. Three rows: `room` (`Room` plus `epoch` and `token`), `plantJob` (`PlantRequest` plus `slot: "current" | "next"`), and `receipts` keyed by `requestId`. A receipt is the `command.result` already sent. Commands other than `hello` consult it inside the same transaction as the mutation and return it unchanged. Hello is not a receipt.

The socket must `hello` before any other command. The second hello on a socket updates that player's name and colour and sends a fresh snapshot. Every successful mutation answers the sender with `command.result` and broadcasts `room` (the output of `toWire`) to every open socket. Clients replace local state; they do not patch.

Any player who has completed hello may do every command. There is no host seat.

| Command | When it is legal | What one transaction does |
|---|---|---|
| `round.start` | `current` is null or `ended` | Promote or plant. Otherwise `round_open`. |
| `board.upload` | `current` is `live` and `roundId` matches and `next` is null | Plant the next round. Otherwise `not_live` or `next_exists`. |
| `find.claim` | `current` is `live` | `decideClaim`. The circle stays on the client; the finder already ran `JudgeFn`. |
| `difficulty.set` | `current` is null or `ended`, and `next` is null | Store 1..8. Otherwise `busy`. |
| `round.cancel` | `current` is `live` and `roundId` matches | End `cancelled`. |

`round.start` with `next.status === "ready"` promotes that round, ignores `board`, sets `startedAt` to the transaction's `Date.now()`, `endsAt` to `startedAt + ROUND_MS`, status `live`, `room.difficulty` to the job's `difficulty`, and increments `roundsPlayed`. `next.status === "planting"` answers `planting`. `next === null` requires `board` and `stampIds` or answers `need_board`. A cold start mints `roundId` with `crypto.randomUUID()`, writes `current` as `planting`, and stores `plantJob` at `plantDifficulty(room.difficulty, false)`. The start receipts `ok` once the job is committed. If verify later clears `current`, the driver sends a new `requestId`.

`board.upload` does the same for `slot: "next"` at `plantDifficulty(room.difficulty, true)`. The first upload wins. The starter's driver uploads as soon as it sees `live`; if that socket is gone, any other player may upload.

Planting is one pi-durable child task, `PlantRound`, `replay: "safe"`, created only after `plantJob` is committed. The room waits on it with `allSettled`. Phase `place` runs the shared `PlantFn` on the stored request. Phase `verify` keeps the array only when it has 1..8 targets, unique ids, stamp ids from the request, and every centre inside `frameRect`. Empty or failed verify deletes that slot (a failed current plant sets `current` back to null; it does not invent an `ended` round) and does not bump `roundsPlayed`. Success writes the targets. A current slot then flips to `live` in that same commit and `roundsPlayed` increments. A next slot stops at `ready` and does not increment. The broadcast goes out after the commit. A resume that finds the slot already past `planting` does not mint another id or run `PlantFn` again.

`endsAt` is a storage alarm, not a timer in the isolate. Going live sets the alarm to `endsAt`. While a plant task is pending, the alarm is also pulled forward to `now + RECOVERY_ALARM_MS` if that is sooner. The alarm handler ends a live round whose `endsAt` has passed, resumes a planting slot, and deletes the alarm when neither is true. Ending is idempotent.

On `all-found` or `time-up`, a unique leader of this round's finds gets `roundsWon += 1`. `time-up` with zero finds sets `difficulty = max(1, difficulty - 1)` and deletes `next`. Any other `all-found` or `time-up` keeps a `ready` next. `cancelled` keeps difficulty, deletes `next`, and keeps finds already scored. `roundsPlayed` does not change on end. Hello inserts a league row at zero and refreshes `playerName`.

A claim whose `decideClaim` returns `ended` also runs the time-up end when the row is still live, then stores a failed receipt. A second alarm sees `ended` and does nothing.

Same millisecond, two sockets, one target: each claim is a storage transaction that reads the live finds, calls `decideClaim`, and writes the find plus the receipt. Durable Object transactions on one object are serial. The first commit wins. The second sees the find and stores `taken`. `Find.at` is `Date.now()` inside the transaction; equal timestamps do not share the target.

## Join and auth

`roomId` is the hunt frame's element id. It must match `^[A-Za-z0-9_-]{1,80}$` or the driver refuses the frame. The worker route is `GET /api/rooms/:roomId` with header `Upgrade: websocket`, forwarded to `env.ROOMS.getByName(roomId)`. Do not reject `Origin: null` or a missing Origin. There is no cookie. HTTP errors send `Access-Control-Allow-Origin: *`.

The query token matches `^[A-Za-z0-9_-]{22,64}$`. The first hello on an unsealed object stores it and sets `epoch` to 1. `?rekey=1` may replace the token only while `roundsPlayed === 0` and both slots are null; `epoch` increments and every other socket gets `{ type: "error", error: { code: "superseded" } }` then close `4001`. Any other mismatch is HTTP 401 `{ error: "token_mismatch" }` and the socket is not accepted. A non-empty room never rekeys.

First click, meta missing: mint a token (32 random bytes, base64url, no padding), `connect` with `rekey: true`, and write `meta.iit` only from the snapshot handler while the socket is still open: `{ v: 1, roomId, token, epoch }`. Then read the frame back. A newer epoch means this driver lost; join the meta that is there, with `rekey: false`. An older epoch means this driver's write should be repeated once. A driver that was superseded does not write. Later clicks read meta and connect with that token. The 33rd open socket is refused with HTTP 1013.

Each socket, in memory, allows `RATE_MAX_MESSAGES` frames per `RATE_WINDOW_MS`, `RATE_MAX_CLAIMS` claims in that window, and one `round.start` or `board.upload` per `RATE_UPLOAD_GAP_MS`. Over the limit, send `error` code `rate` and close `1008`. A frame over `MAX_FRAME_CHARACTERS` closes `1009`. Binary frames and `InvalidMessage` close `1002`. Eviction clears these buckets. `hello_required` is a normal `command.result` failure and leaves the socket up.

## Reconnect and recovery

`connect` resolves when `snapshot` arrives and rejects if the socket closes first. The client keeps a `CommandOutbox` with the same rules as the template: retain every `RetryCommand` until `command.result` has the same `requestId` and `command`, then replay those objects unchanged. Replay runs after the snapshot, not on the raw open. Hello is not in the outbox. `close()` does not drop the outbox; leaving the frame does.

The snapshot is the whole public room plus `you` and `epoch`. Hibernated sockets keep a serialized attachment `{ playerId, playerName, playerColor }`. After an eviction the constructor reloads SQLite, resumes a `planting` job, ends a live round whose `endsAt` is already past, resets the alarm, and sends each still-open socket a snapshot. Broadcasts that were only in memory are gone; the snapshot replaces them. Receipts survive, so a replay cannot score a second find or start a second round.

## Offline

If the driver has no backend URL it constructs `LocalHost` instead of the WebSocket host. Both implement `HuntHost`. `LocalHost.connect` ignores the token, seeds an empty `Room` at difficulty 1, and emits a snapshot that has been through `toWire` and `parseServerEvent`. `send` runs the table above. `PlantFn` runs on the microtask queue in place of `PlantRound`. `endsAt` is `setTimeout`, cleared on an early `all-found`. Receipts are a `Map`. Two local claims in one turn call `decideClaim` twice, the second after the first find is appended. The driver still judges with `JudgeFn` before `find.claim`, and it still draws local previews only from a `live` round.

## Three risks

1. **First claim and replay.** Two sockets claiming one target must leave one find, including when `Find.at` matches, and a replay of both `requestId`s after `evictDurableObject` must return the stored results. Unit-test `decideClaim` by appending the first find and calling it again. In a Worker test, fire both claims before either result, assert one `ok` and one `taken`, evict, reconnect, replay, and assert `league[].finds` sums to 1.

2. **Eviction across plant and `endsAt`.** A job committed as `planting` must become a single `live` round after eviction, not two. A live row with `endsAt` in the past must become `time-up` once. Commit a `plantJob`, evict before the task finishes, wake on a socket, and expect one live snapshot whose targets match `PlantFn` of that stored request. Separately, store a live round with `endsAt` behind `Date.now()`, evict, `runDurableObjectAlarm`, and expect one `ended` round; a late claim then receipts `ended`.

3. **Token race, and the next round leaking.** Two virgin `rekey` hellos must leave one token, the loser must see `superseded`, and a third client with the old token must get 401 once `roundsPlayed > 0` even with `rekey=1`. Assert `parseServerEvent` throws on a `next` object that contains `targets`, and that `JSON.stringify(toWire(room))` for a `ready` next has no `"targets"` key. The frame cap and the upload gap are the cheap denial-of-service checks: a 200 KB board is a parse error, and a second upload inside five seconds closes only that socket.
