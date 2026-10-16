# It's In There! — Wire Protocol & Room Architecture (`gemini`)

## 1. `src/shared/protocol.ts`

```ts
// Shared wire protocol and host contract between the Drawdy driver (src/) and Room DO (server/).
// Zero runtime dependencies; imports only domain types from ./hunt.ts.

import type { BoardItem, BoardSnapshot, Find, LeagueEntry, PlayerId, Rect, Room, Round, Target } from "./hunt.ts";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_CHARS = 262_144;
export const MAX_REQUEST_ID_CHARS = 128;
export const MAX_BOARD_ITEMS = 500;
export const MAX_POINTS_PER_ITEM = 128;
export const MIN_DIFFICULTY = 1;
export const MAX_DIFFICULTY = 5;
export const DEFAULT_ROUND_DURATION_MS = 60_000;
export const DEFAULT_TARGETS_PER_ROUND = 5;

export type PlayerIdentity = { id: PlayerId; name: string; color: string };

export type ErrorCode =
    | "invalid_json" | "invalid_command" | "frame_too_large" | "unauthorized"
    | "rate_limited" | "round_active" | "round_not_live" | "target_not_found" | "command_failed";

export type ProtocolError = { code: ErrorCode; message: string };

export type ClientCommand =
    | { v: typeof PROTOCOL_VERSION; type: "round.start"; requestId: string; board: BoardSnapshot; durationMs?: number }
    | { v: typeof PROTOCOL_VERSION; type: "target.claim"; requestId: string; roundId: string; targetId: string; player: PlayerIdentity }
    | { v: typeof PROTOCOL_VERSION; type: "round.cancel"; requestId: string; roundId: string }
    | { v: typeof PROTOCOL_VERSION; type: "difficulty.set"; requestId: string; difficulty: number };

export type ClientCommandType = ClientCommand["type"];

export type CommandResult =
    | {
          v: typeof PROTOCOL_VERSION;
          type: "command.result";
          command: ClientCommandType;
          requestId: string;
          ok: true;
          /** True only for the first accepted claim on a target (and replays of that same winning requestId). */
          claimed?: boolean;
      }
    | {
          v: typeof PROTOCOL_VERSION;
          type: "command.result";
          command: ClientCommandType;
          requestId: string;
          ok: false;
          error: ProtocolError;
      };

export type ServerEvent =
    | {
          v: typeof PROTOCOL_VERSION;
          type: "room.state";
          room: Room;
          serverNow: number;
          taunt?: string;
      }
    | CommandResult
    | { v: typeof PROTOCOL_VERSION; type: "error"; error: ProtocolError };

export interface HuntHost {
    send(command: ClientCommand): void;
    subscribe(listener: (event: ServerEvent) => void): () => void;
    close(): void;
}

export class InvalidProtocolMessage extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

const fail = (code: ErrorCode, msg: string): never => {
    throw new InvalidProtocolMessage(code, msg);
};

const reqObj = (v: unknown, name: string): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : fail("invalid_command", `${name} must be an object`);

const reqArr = (v: unknown, name: string, max = MAX_BOARD_ITEMS): unknown[] =>
    Array.isArray(v) && v.length <= max ? v : fail("invalid_command", `${name} must be an array <= ${max}`);

const reqFinite = (v: unknown, name: string): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fail("invalid_command", `${name} must be finite`);

const reqStr = (v: unknown, name: string, max = 128): string =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max
        ? v
        : fail("invalid_command", `${name} must be 1..${max} chars`);

const parseRect = (raw: unknown, name: string): Rect => {
    const v = reqObj(raw, name);
    const width = reqFinite(v.width, `${name}.width`);
    const height = reqFinite(v.height, `${name}.height`);
    if (width <= 0 || height <= 0) fail("invalid_command", `${name} size must be > 0`);
    return { x: reqFinite(v.x, `${name}.x`), y: reqFinite(v.y, `${name}.y`), width, height };
};

const ITEM_KINDS = new Set<BoardItem["kind"]>(["freedraw", "shape", "text", "image", "line", "other"]);

const parseBoardSnapshot = (raw: unknown): BoardSnapshot => {
    const v = reqObj(raw, "board");
    const frameRect = parseRect(v.frameRect, "board.frameRect");
    const items: BoardItem[] = reqArr(v.items, "board.items", MAX_BOARD_ITEMS).map((entry, i) => {
        const o = reqObj(entry, `items[${i}]`);
        if (typeof o.kind !== "string" || !ITEM_KINDS.has(o.kind as BoardItem["kind"])) {
            fail("invalid_command", `items[${i}].kind is invalid`);
        }
        const item: BoardItem = { rect: parseRect(o.rect, `items[${i}].rect`), kind: o.kind as BoardItem["kind"] };
        if (o.strokeColor !== undefined) item.strokeColor = reqStr(o.strokeColor, "strokeColor", 64);
        if (o.strokeWidth !== undefined) item.strokeWidth = reqFinite(o.strokeWidth, "strokeWidth");
        if (o.points !== undefined) {
            item.points = reqArr(o.points, `items[${i}].points`, MAX_POINTS_PER_ITEM).map((pt) =>
                Array.isArray(pt) && pt.length === 2
                    ? ([reqFinite(pt[0], "pt.x"), reqFinite(pt[1], "pt.y")] as const)
                    : fail("invalid_command", "point must be [x, y]"),
            );
        }
        return item;
    });
    return { frameRect, items };
};

const parseTarget = (raw: unknown): Target => {
    const v = reqObj(raw, "target");
    return {
        id: reqStr(v.id, "target.id"),
        stampId: reqStr(v.stampId, "target.stampId"),
        rect: parseRect(v.rect, "target.rect"),
        rotationDeg: reqFinite(v.rotationDeg, "target.rotationDeg"),
        strokeColor: reqStr(v.strokeColor, "target.strokeColor", 64),
        strokeWidth: reqFinite(v.strokeWidth, "target.strokeWidth"),
    };
};

const parseFind = (raw: unknown): Find => {
    const v = reqObj(raw, "find");
    return {
        targetId: reqStr(v.targetId, "find.targetId"),
        playerId: reqStr(v.playerId, "find.playerId"),
        playerName: reqStr(v.playerName, "find.playerName", 64),
        playerColor: reqStr(v.playerColor, "find.playerColor", 64),
        at: reqFinite(v.at, "find.at"),
    };
};

const parseRound = (raw: unknown): Round | null => {
    if (raw === null) return null;
    const v = reqObj(raw, "round");
    const id = reqStr(v.id, "round.id");
    const frameRect = parseRect(v.frameRect, "round.frameRect");
    if (v.status === "planting") return { status: "planting", id, frameRect };
    const targets = reqArr(v.targets, "round.targets").map(parseTarget);
    if (v.status === "ready") return { status: "ready", id, frameRect, targets };
    const finds = reqArr(v.finds, "round.finds").map(parseFind);
    const startedAt = reqFinite(v.startedAt, "round.startedAt");
    if (v.status === "live") {
        return { status: "live", id, frameRect, targets, startedAt, endsAt: reqFinite(v.endsAt, "round.endsAt"), finds };
    }
    if (v.status === "ended" && (v.reason === "all-found" || v.reason === "time-up" || v.reason === "cancelled")) {
        return { status: "ended", id, frameRect, targets, startedAt, endedAt: reqFinite(v.endedAt, "round.endedAt"), finds, reason: v.reason };
    }
    return fail("invalid_command", "Invalid round status");
};

export function parseClientCommand(raw: string): ClientCommand {
    if (raw.length > MAX_FRAME_CHARS) fail("frame_too_large", "Frame exceeds MAX_FRAME_CHARS");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        fail("invalid_json", "Malformed JSON");
    }
    const v = reqObj(parsed, "command");
    if (v.v !== PROTOCOL_VERSION || typeof v.type !== "string") {
        fail("invalid_command", "Unsupported protocol envelope");
    }
    const requestId = reqStr(v.requestId, "requestId", MAX_REQUEST_ID_CHARS);
    switch (v.type) {
        case "round.start": {
            const durationMs = v.durationMs === undefined ? undefined : reqFinite(v.durationMs, "durationMs");
            if (durationMs !== undefined && (durationMs < 5_000 || durationMs > 300_000)) {
                fail("invalid_command", "durationMs out of range");
            }
            return {
                v: PROTOCOL_VERSION,
                type: "round.start",
                requestId,
                board: parseBoardSnapshot(v.board),
                ...(durationMs === undefined ? {} : { durationMs }),
            };
        }
        case "target.claim": {
            const p = reqObj(v.player, "player");
            return {
                v: PROTOCOL_VERSION,
                type: "target.claim",
                requestId,
                roundId: reqStr(v.roundId, "roundId"),
                targetId: reqStr(v.targetId, "targetId"),
                player: {
                    id: reqStr(p.id, "player.id"),
                    name: reqStr(p.name, "player.name", 64),
                    color: reqStr(p.color, "player.color", 64),
                },
            };
        }
        case "round.cancel":
            return { v: PROTOCOL_VERSION, type: "round.cancel", requestId, roundId: reqStr(v.roundId, "roundId") };
        case "difficulty.set": {
            const d = reqFinite(v.difficulty, "difficulty");
            if (!Number.isInteger(d) || d < MIN_DIFFICULTY || d > MAX_DIFFICULTY) {
                fail("invalid_command", "difficulty must be integer 1..5");
            }
            return { v: PROTOCOL_VERSION, type: "difficulty.set", requestId, difficulty: d };
        }
        default:
            return fail("invalid_command", `Unknown command: ${v.type}`);
    }
}

export function parseServerEvent(raw: string): ServerEvent {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        fail("invalid_json", "Malformed server JSON");
    }
    const v = reqObj(parsed, "event");
    if (v.v !== PROTOCOL_VERSION || typeof v.type !== "string") {
        fail("invalid_command", "Invalid server envelope");
    }
    if (v.type === "room.state") {
        const rm = reqObj(v.room, "room");
        const league: LeagueEntry[] = reqArr(rm.league, "room.league").map((entry) => {
            const e = reqObj(entry, "leagueEntry");
            return {
                playerId: reqStr(e.playerId, "playerId"),
                playerName: reqStr(e.playerName, "playerName", 64),
                finds: reqFinite(e.finds, "finds"),
                roundsWon: reqFinite(e.roundsWon, "roundsWon"),
            };
        });
        return {
            v: PROTOCOL_VERSION,
            type: "room.state",
            room: {
                roomId: reqStr(rm.roomId, "roomId"),
                difficulty: reqFinite(rm.difficulty, "difficulty"),
                league,
                current: parseRound(rm.current),
                next: parseRound(rm.next),
                roundsPlayed: reqFinite(rm.roundsPlayed, "roundsPlayed"),
            },
            serverNow: reqFinite(v.serverNow, "serverNow"),
            ...(typeof v.taunt === "string" ? { taunt: v.taunt } : {}),
        };
    }
    if (v.type === "command.result") {
        const requestId = reqStr(v.requestId, "requestId", MAX_REQUEST_ID_CHARS);
        const command = reqStr(v.command, "command") as ClientCommandType;
        if (v.ok === true) {
            return {
                v: PROTOCOL_VERSION,
                type: "command.result",
                command,
                requestId,
                ok: true,
                ...(typeof v.claimed === "boolean" ? { claimed: v.claimed } : {}),
            };
        }
        if (v.ok === false) {
            const err = reqObj(v.error, "error");
            return {
                v: PROTOCOL_VERSION,
                type: "command.result",
                command,
                requestId,
                ok: false,
                error: { code: reqStr(err.code, "code") as ErrorCode, message: reqStr(err.message, "message", 512) },
            };
        }
    }
    if (v.type === "error") {
        const err = reqObj(v.error, "error");
        return {
            v: PROTOCOL_VERSION,
            type: "error",
            error: { code: reqStr(err.code, "code") as ErrorCode, message: reqStr(err.message, "message", 512) },
        };
    }
    return fail("invalid_command", `Invalid server event: ${v.type}`);
}
```

## 2. Room Behaviour per Message

The Room Durable Object wraps a `pi-durable` `Harness` on DO SQLite (`openDurableObjectSqliteStorage`). Room state lives in a session-scoped document `RoomDoc` (`{ room: Room, tokenHash: string, lastBoard: BoardSnapshot | null, taunt?: string }`), and command idempotency receipts live in `CommandReceipts` (`defineDocFamily<{ receipt?: CommandResult }, null>`). Every mutation executes inside a single `harness.commit(tx => ...)` transaction.

- **Permissions**: Any connected player with the room's join token may issue any command.
- **`round.start`**:
  - Allowed only when `room.current === null || room.current.status === "ended"`; otherwise returns `ok: false, error: { code: "round_active" }` (unless `requestId` matches an existing receipt).
  - **Warm path (`room.next?.status === "ready"`)**: Atomically promotes `room.next` to `room.current` with `status: "live"`, `startedAt = now`, `endsAt = now + durationMs`, `finds: []`. Sets `room.next = { status: "planting", id: nextId, frameRect: cmd.board.frameRect }`, saves `lastBoard = cmd.board`, schedules the DO alarm for `endsAt`, and spawns a background `PlantRoundTask` (`autoStart: false`) for `room.next` at `min(5, room.difficulty + 1)`.
  - **Cold path (`room.next === null || room.next.status === "planting"`)**: Sets `room.current = { status: "planting", id: roundId, frameRect: cmd.board.frameRect }` and spawns `PlantRoundTask` (`autoStart: true`).
- **Pre-planting (`PlantRoundTask`)**:
  - Phase `spawn`: Creates two child tasks (`ownership: { kind: "task", taskId: task.id }`)—`PlaceTargetsTask` (runs shared `PlantFn` on `PlantRequest` and self-checks targets via `JudgeFn`) and `TauntTask` (selects a bundled Thai/English taunt, or optional LLM line)—and returns `{ status: "waiting", on: [placeId, tauntId], policy: "allSettled" }`.
  - Phase `finalize`: If `autoStart` and `room.current?.id === roundId`, transitions `room.current` `"planting" → "ready" → "live"`, arms the `endsAt` alarm, and spawns `PlantRoundTask` (`autoStart: false`) for `room.next`. If `!autoStart` and `room.next?.id === roundId`, transitions `room.next` `"planting" → "ready"`.
- **`target.claim`**:
  - On laser pointer-up (`subscription:tool:laser`), the finder's driver hashes each stroke's points to skip already-judged strokes, runs `JudgeFn(circle, target)` against un-found targets in `room.current`, and sends `target.claim`.
  - The Room checks `CommandReceipts[requestId]` first. If new, requires `room.current?.status === "live"`, `room.current.id === cmd.roundId`, and `now < room.current.endsAt` (else `round_not_live`).
  - If `targetId` is already in `room.current.finds`, commits receipt `{ ok: true, claimed: false }`.
  - If unclaimed, appends `Find`, upserts the player's `LeagueEntry` (`finds += 1`), and commits receipt `{ ok: true, claimed: true }`.
  - If `finds.length === targets.length`, transitions `room.current` to `status: "ended", reason: "all-found", endedAt: now`, increments `roundsPlayed`, bumps `difficulty = min(5, difficulty + 1)`, and increments `roundsWon` for the round's top finder (tie-breaker: earliest final find `at`).
- **Timers (`endsAt` via alarm)**:
  - `#refreshAlarm()` sets the single DO alarm to `Math.min(liveRoundEndsAt, scheduledDailyHuntAt, harnessTaskRecoveryAt)`. When `alarm()` fires and `now >= room.current.endsAt`, the Room commits `status: "ended", reason: "time-up", endedAt: now`, updates `roundsWon` (if `finds.length > 0`) and `roundsPlayed`, and broadcasts `room.state`.
- **`round.cancel` & `difficulty.set`**:
  - `round.cancel` transitions an active `room.current` to `ended` (`reason: "cancelled"`) and aborts its plant task.
  - `difficulty.set` updates `room.difficulty`. If `room.next` is `"planting"` or `"ready"`, it aborts/discards `room.next` and, if `lastBoard` exists, spawns a fresh `PlantRoundTask` for `room.next` at the new difficulty.

## 3. Join, Auth, and Rate Limits

- **First-time Room Creation**: Before the user clicks the driver's action button, zero gated commands (`dom`, `scene`, `collaboration`, `storage`) run. On click, the driver reads the selected frame's `meta.iit`. If absent, it calls `POST <backendUrl>/api/rooms` (`Access-Control-Allow-Origin: *` for `Origin: null`). The Worker mints `roomId = crypto.randomUUID()` and a 32-byte base64url `joinToken`, initializes the Room DO with `SHA-256(joinToken)`, and returns `{ roomId, joinToken }`. The driver writes `meta: { iit: { v: 1, roomId, joinToken, backendUrl } }` onto the hunt frame via `command:scene:update-drawdy-elements` so collaborators read it from the scene.
- **WebSocket Auth**: Drivers connect to `wss://<host>/api/rooms/<roomId>/ws?token=<joinToken>`. The DO compares `SHA-256(token)` with `RoomDoc.tokenHash` via `crypto.subtle.timingSafeEqual` before `acceptWebSocket()`, returning HTTP `403` on mismatch.
- **Per-Connection Rate Limits**: Each socket's `KeyedSerialQueue` enforces `MAX_FRAME_CHARS` (256 KB; closes `1009`) and a token bucket stored in the socket attachment (capacity 15 tokens, refill 5/sec; `round.start` and `difficulty.set` cost 5 tokens, `target.claim` costs 1 token). Empty bucket emits `{ v: 1, type: "error", error: { code: "rate_limited", ... } }`; 10 consecutive violations close the socket with `1008`.

## 4. Reconnect, Eviction, and Race Recovery

- **Snapshot-on-Connect**: On WebSocket open, the DO sends `room.state` (`{ room, serverNow: Date.now(), taunt }`). The driver computes `clockOffsetMs = serverNow - Date.now()` and reconciles local preview strokes (`create-drawdy-preview-elements` / `delete-drawdy-preview-elements`) against `room.current.targets` minus `room.current.finds`.
- **Outbox Replay**: The driver queues outgoing `ClientCommand`s in `CommandOutbox` keyed by `requestId`. After receiving `room.state` on reconnect, `outbox.replay(send)` resends unacknowledged commands in FIFO order with their original `requestId`s. `CommandReceipts` returns the cached `CommandResult` without re-mutating state.
- **Mid-Round DO Eviction**: WebSockets use Cloudflare Hibernation (`ctx.acceptWebSocket`) and state + tasks live in DO SQLite. When woken by a client frame or the `endsAt` alarm, `ctx.blockConcurrencyWhile(() => this.#initialize())` reopens `Harness`, resumes any in-flight `PlantRoundTask` from its committed checkpoint, ends an expired live round if `Date.now() >= endsAt`, and re-arms the platform alarm.
- **Same-Millisecond Target Claims**: Per-socket operations funnel into `this.#harness.commit(tx => ...)`, which serializes SQLite transactions on the DO's single thread. The first commit appends the `Find`, records `claimed: true` in `CommandReceipts`, and broadcasts `room.state`. The second commit sees `targetId` already in `room.current.finds`, records `claimed: false`, and returns `ok: true, claimed: false`. Only the driver receiving `claimed: true` writes the canvas found-marker element (tagged with `meta: { iitFound: `${roundId}:${targetId}` }` after checking scene state to prevent duplicate markers on replay).

## 5. Offline Single-Player (`LocalHost`)

When no `backendUrl` is configured, the driver instantiates `LocalHost implements HuntHost` (defined in `src/shared/protocol.ts` above) inside the worker using the same `ClientCommand` / `ServerEvent` types and `PlantFn` / `JudgeFn`:

- `LocalHost` holds `room: Room`, `receipts: Map<string, CommandResult>`, and `endTimer: ReturnType<typeof setTimeout> | null` in memory.
- `send(cmd)` validates via `parseClientCommand(JSON.stringify(cmd))`, runs the identical state transitions, schedules `endTimer` for `endsAt`, pre-plants `room.next` in a microtask with `PlantFn`, persists `room` via Drawdy's `command:storage:set` (after the user's initial click), and emits `command.result` + `room.state` to `subscribe` listeners.

## 6. Top 3 Risks and Verification Plan

1. **DO Alarm Multiplexing & Eviction Mid-Round**:
   - *Risk*: `pi-durable`'s 60s task-recovery alarm could overwrite an earlier `room.current.endsAt` alarm (or vice-versa), leaving a live round stuck after eviction.
   - *Test*: In `server/test/recovery.test.ts` (`@cloudflare/vitest-pool-workers`), start a 200ms round while a slow `PlantRoundTask` for `next` runs, call `evictDurableObject(stub)`, advance time, call `runDurableObjectAlarm(stub)`, and assert `room.current.status === "ended"` (`reason: "time-up"`) AND `room.next.status === "ready"`.
2. **Simultaneous Target Claims & Duplicate Scene Markers on Replay**:
   - *Risk*: Two players circling the same stamp within 1ms—or a winning client reconnecting and replaying `target.claim`—could cause duplicate `add-drawdy-elements` marker writes.
   - *Test*: Fire two concurrent `target.claim` frames with distinct `requestId`s at the Room DO and assert one receives `claimed: true` and the other `claimed: false`, then replay the winning `requestId` and verify the driver skips marker creation when `meta.iitFound === `${roundId}:${targetId}`` already exists in the frame.
3. **Drawdy Permission-Gate Lockout & Silent DOM Hang**:
   - *Risk*: Issuing any gated command during `activate` before the action-button click risks permanent permission denial; passing a bare number to `DomElementSchema` hangs `issueCommand` forever.
   - *Test*: Unit-test `activate()` with a strict mock `DriverCommandIssuer` that throws if any command other than `command:dom:create-action-button` and `subscription:dom:element-clicked` runs before the click event, and wrap all driver `issueCommand` calls in a 5s timeout with compile-time `[number, CSSUnit]` dimension helpers.
