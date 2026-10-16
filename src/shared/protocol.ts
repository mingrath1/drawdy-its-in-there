// Wire protocol between the driver (one per player, Drawdy worker, origin null) and the
// Room Durable Object (one per hunt frame). LocalHost speaks the same messages in process.
// Chosen from a four-model design arena: gpt's design as the base, trimmed, with grafts
// from muse (one-step round.start), grok (toWire), and gemini (marker dedupe tag).
//
// Rules both sides rely on:
// - The room sends full snapshots, ordered by `revision`. Clients ignore lower revisions.
// - Every mutating command carries a requestId. The room stores one receipt per
//   (playerId, requestId) for each player's newest 512 requests. A retry returns the stored
//   result. A retry with a different payload returns "request-conflict" and changes nothing.
// - The first committed claim per target wins. Commit order decides same-millisecond claims.
// - Targets of a round stay off the wire until the round is live (toWire).
// - Target rects are canvas coordinates at plant time. If the hunt frame moved since,
//   render at target.rect offset by (frameNow.x - round.frameRect.x, frameNow.y - round.frameRect.y).
// - Only the driver whose claim returned "ok" writes the scene's found marker, tagged
//   meta.iitFound = "<roundId>:<targetId>", after checking no element already has that tag.
// - A second player joins by clicking the action button: their driver finds the hunt frame
//   in view or selection, validates meta.iit with parseFrameMeta, and sends hello.
// - roomId = deriveRoomId(joinToken). The room refuses a hello whose ids disagree, so only
//   a token holder can create or enter a room.

import type { BoardSnapshot, LeagueEntry, Rect, Room, Round } from "./hunt.ts";
import { sha256Hex } from "./sha256.ts";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_CHARS = 262_144;
export const MAX_BOARD_ITEMS = 500;
export const MAX_POINTS_PER_ITEM = 128;
export const MAX_TOTAL_POINTS = 8_192;
export const MAX_TARGETS = 16;
/** Players a room lists. A new player's hello to a full league gets fault "full". */
export const MAX_LEAGUE = 256;
export const MIN_DIFFICULTY = 1;
/** Every level changes the game: these tables and placement.ts's all reach their last row here. */
export const MAX_DIFFICULTY = 4;

const ROUND_SECONDS = [60, 50, 40, 30];
const TARGET_COUNTS = [3, 4, 5, 6];
const levelIndex = (difficulty: number): number =>
    Math.min(Math.max(Math.floor(difficulty), MIN_DIFFICULTY), MAX_DIFFICULTY) - MIN_DIFFICULTY;

export const roundDurationMs = (difficulty: number): number => ROUND_SECONDS[levelIndex(difficulty)]! * 1_000;
export const targetCount = (difficulty: number): number => TARGET_COUNTS[levelIndex(difficulty)]!;

/** The level the next round plays at. rules.ts states the rule. */
export function nextDifficulty(room: Room): number {
    if (room.chosenDifficulty !== null) return room.chosenDifficulty;
    const last = room.current;
    const raise = last?.status === "ended" && last.reason === "all-found";
    return raise ? Math.min(MAX_DIFFICULTY, room.difficulty + 1) : room.difficulty;
}

/** Stored in the hunt frame's meta under the key "iit". */
export type FrameMeta = { v: 1; roomId: string; joinToken: string; backendUrl: string | null };

/** Display data from Drawdy presence (the isSelf entry). Trusted only as far as board collaborators are. */
export type Player = { playerId: string; name: string; color: string };

export type Hello = { v: 1; type: "hello"; roomId: string; joinToken: string; player: Player };

type Envelope = { v: 1; requestId: string };

export type Command = Envelope &
    (
        | { type: "round.start"; board: BoardSnapshot }
        | { type: "board.offer"; afterRoundId: string; board: BoardSnapshot }
        | { type: "find.claim"; roundId: string; targetId: string }
        | { type: "round.cancel"; roundId: string }
        | { type: "difficulty.set"; value: number }
    );

export type CommandType = Command["type"];
export type ClientMessage = Hello | Command;

export type ResultCode =
    | "ok"
    | "busy"
    | "not-live"
    | "expired"
    | "stale"
    | "unknown-target"
    | "taken"
    | "request-conflict";

/** A round as clients see it: no targets until it is live. */
export type WireRound =
    | { status: "planting"; id: string; frameRect: Rect }
    | { status: "ready"; id: string; frameRect: Rect }
    | Extract<Round, { status: "live" | "ended" }>;

export type WireRoom = {
    roomId: string;
    /** The level of the current or most recent round. */
    difficulty: number;
    /** The level the next round plays at. */
    nextDifficulty: number;
    league: LeagueEntry[];
    current: WireRound | null;
    next: { status: "planting" | "ready"; id: string } | null;
    roundsPlayed: number;
};

export type Snapshot = {
    v: 1;
    type: "snapshot";
    revision: number;
    serverNow: number;
    self: string;
    room: WireRoom;
    taunt: string | null;
};

export type Result = { v: 1; type: "result"; requestId: string; command: CommandType; code: ResultCode; revision: number };

export type FaultCode = "invalid" | "version" | "auth" | "rate-limit" | "full" | "unavailable";
export type Fault = { v: 1; type: "fault"; code: FaultCode; retryAfterMs: number };

export type ServerMessage = Snapshot | Result | Fault;

/**
 * RemoteHost (WebSocket, reconnect, FIFO outbox replaying original requestIds) and
 * LocalHost (in process, no backend) both implement this. `open` resolves after the first
 * snapshot. `send` validates and queues. `close` stops transport only; a live round keeps going.
 */
export interface HuntHost {
    open(hello: Hello, receive: (message: ServerMessage) => void): Promise<void>;
    send(command: Command): void;
    close(): void;
}

/** Hide planted targets until their round is live, so nobody can peek. */
export function toWire(room: Room): WireRoom {
    const round = (r: Round): WireRound =>
        r.status === "planting" || r.status === "ready" ? { status: r.status, id: r.id, frameRect: r.frameRect } : r;
    const next = room.next;
    return {
        roomId: room.roomId,
        difficulty: room.difficulty,
        nextDifficulty: nextDifficulty(room),
        league: room.league,
        current: room.current ? round(room.current) : null,
        next: next && (next.status === "planting" || next.status === "ready") ? { status: next.status, id: next.id } : null,
        roundsPlayed: room.roundsPlayed,
    };
}

export const foundTag = (roundId: string, targetId: string): string => `${roundId}:${targetId}`;

export const deriveRoomId = (joinToken: string): string => sha256Hex(`iit-room-v1:${joinToken}`);

// ---------- validation, dependency-free ----------

type Check = (value: unknown) => boolean;
type Fields = Record<string, Check>;

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const own = (x: object, k: string) => Object.prototype.hasOwnProperty.call(x, k);
const one = (...values: unknown[]): Check => (x) => values.includes(x);
const text = (max: number): Check => (x) =>
    typeof x === "string" && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
const number = (min: number, max: number): Check => (x) =>
    typeof x === "number" && Number.isFinite(x) && x >= min && x <= max;
const integer = (min: number, max: number): Check => (x) => number(min, max)(x) && Number.isSafeInteger(x);
const uint = integer(0, Number.MAX_SAFE_INTEGER);
const time = integer(0, 8_640_000_000_000_000);
const difficulty = integer(MIN_DIFFICULTY, MAX_DIFFICULTY);
const BOUND = 1e7;
const coordinate = number(-BOUND, BOUND);
const positive: Check = (x) => number(0, 2 * BOUND)(x) && (x as number) > 0;
const id: Check = (x) => typeof x === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(x);
const token: Check = (x) => typeof x === "string" && /^[0-9a-f]{32,128}$/.test(x);
const color = text(64);
const url: Check = (x) => typeof x === "string" && x.length <= 512 && /^https:\/\/[^\s]+$/.test(x);
const nullable = (check: Check): Check => (x) => x === null || check(x);
const array = (check: Check, max: number, min = 0): Check => (x) =>
    Array.isArray(x) && x.length >= min && x.length <= max && x.every(check);
const shape = (required: Fields, optional: Fields = {}): Check => (x) =>
    record(x) &&
    Object.keys(required).every((k) => own(x, k) && required[k]!(x[k])) &&
    Object.keys(x).every((k) => own(required, k) || (own(optional, k) && optional[k]!(x[k])));

/** Every target lies inside its round's frame, so a frame inside the coordinate bound keeps its targets on the wire. */
const frameRect: Check = (x) =>
    shape({ x: coordinate, y: coordinate, width: number(1, 2 * BOUND), height: number(1, 2 * BOUND) })(x) &&
    record(x) &&
    (x.x as number) + (x.width as number) <= BOUND &&
    (x.y as number) + (x.height as number) <= BOUND;
const targetRect = shape({ x: coordinate, y: coordinate, width: positive, height: positive });
const itemRect = shape({ x: coordinate, y: coordinate, width: number(0, 1e7), height: number(0, 1e7) });
const point: Check = (x) => Array.isArray(x) && x.length === 2 && x.every(coordinate);
const item = shape(
    { rect: itemRect, kind: one("freedraw", "shape", "text", "image", "line", "other") },
    { strokeColor: color, strokeWidth: number(0, 1000), points: array(point, MAX_POINTS_PER_ITEM) },
);
const board: Check = (x) => {
    if (!shape({ frameRect, items: array(item, MAX_BOARD_ITEMS) })(x) || !record(x)) return false;
    const items = x.items as Record<string, unknown>[];
    return items.reduce((n, i) => n + (Array.isArray(i.points) ? i.points.length : 0), 0) <= MAX_TOTAL_POINTS;
};
const player = shape({ playerId: text(128), name: text(64), color });
const target = shape({ id, stampId: id, rect: targetRect, rotationDeg: number(-360, 360), strokeColor: color, strokeWidth: number(0, 1000) });
const find = shape({ targetId: id, playerId: text(128), playerName: text(64), playerColor: color, at: time });
const leagueEntry = shape({ playerId: text(128), playerName: text(64), finds: uint, roundsWon: uint });

const wireRound: Check = (x) => {
    if (!record(x)) return false;
    const base = { id, frameRect };
    if (x.status === "planting" || x.status === "ready") return shape({ ...base, status: one(x.status) })(x);
    const played = { ...base, targets: array(target, MAX_TARGETS, 1), startedAt: time, finds: array(find, MAX_TARGETS) };
    if (x.status === "live") return shape({ ...played, status: one("live"), endsAt: time })(x);
    return shape({ ...played, status: one("ended"), endedAt: time, reason: one("all-found", "time-up", "cancelled") })(x);
};
const wireRoom = shape({
    roomId: id,
    difficulty,
    nextDifficulty: difficulty,
    league: array(leagueEntry, MAX_LEAGUE),
    current: nullable(wireRound),
    next: nullable(shape({ status: one("planting", "ready"), id })),
    roundsPlayed: uint,
});

const base = { v: one(PROTOCOL_VERSION), requestId: id };
const clientChecks: Record<ClientMessage["type"], Check> = {
    hello: shape({ v: one(PROTOCOL_VERSION), type: one("hello"), roomId: id, joinToken: token, player }),
    "round.start": shape({ ...base, type: one("round.start"), board }),
    "board.offer": shape({ ...base, type: one("board.offer"), afterRoundId: id, board }),
    "find.claim": shape({ ...base, type: one("find.claim"), roundId: id, targetId: id }),
    "round.cancel": shape({ ...base, type: one("round.cancel"), roundId: id }),
    "difficulty.set": shape({ ...base, type: one("difficulty.set"), value: difficulty }),
};
const commandTypes = ["round.start", "board.offer", "find.claim", "round.cancel", "difficulty.set"] as const;
const serverChecks: Record<ServerMessage["type"], Check> = {
    snapshot: shape({
        v: one(PROTOCOL_VERSION),
        type: one("snapshot"),
        revision: uint,
        serverNow: time,
        self: text(128),
        room: wireRoom,
        taunt: nullable(text(280)),
    }),
    result: shape({
        v: one(PROTOCOL_VERSION),
        type: one("result"),
        requestId: id,
        command: one(...commandTypes),
        revision: uint,
        code: one("ok", "busy", "not-live", "expired", "stale", "unknown-target", "taken", "request-conflict"),
    }),
    fault: shape({
        v: one(PROTOCOL_VERSION),
        type: one("fault"),
        code: one("invalid", "version", "auth", "rate-limit", "full", "unavailable"),
        retryAfterMs: integer(0, 3_600_000),
    }),
};

const matches = (value: unknown, checks: Record<string, Check>): boolean =>
    record(value) && typeof value.type === "string" && own(checks, value.type) && checks[value.type]!(value);

export const isClientMessage = (value: unknown): value is ClientMessage => matches(value, clientChecks);
export const isServerMessage = (value: unknown): value is ServerMessage => matches(value, serverChecks);
export const isCommand = (value: unknown): value is Command => isClientMessage(value) && value.type !== "hello";

export class ProtocolError extends Error {
    readonly code: "invalid" | "version";
    constructor(code: "invalid" | "version") {
        super(code);
        this.code = code;
    }
}

function decode(raw: unknown): unknown {
    if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) throw new ProtocolError("invalid");
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new ProtocolError("invalid");
    }
    if (record(value) && value.v !== PROTOCOL_VERSION) throw new ProtocolError("version");
    return value;
}

export function parseClient(raw: unknown): ClientMessage {
    const value = decode(raw);
    if (!isClientMessage(value)) throw new ProtocolError("invalid");
    return value;
}

export function parseServer(raw: unknown): ServerMessage {
    const value = decode(raw);
    if (!isServerMessage(value)) throw new ProtocolError("invalid");
    return value;
}

export const encode = (message: ClientMessage | ServerMessage): string => JSON.stringify(message);

/** Validates the hunt frame's meta.iit before any connection. Returns null when absent or malformed. */
export function parseFrameMeta(meta: unknown): FrameMeta | null {
    if (!record(meta)) return null;
    const iit = meta.iit;
    return shape({ v: one(1), roomId: id, joinToken: token, backendUrl: nullable(url) })(iit) ? (iit as FrameMeta) : null;
}

/**
 * SHA-256 of a command's canonical JSON minus its requestId, for detecting a changed payload
 * under a reused id. A hash keeps a receipt small however large the board it answered.
 */
export function commandFingerprint(command: Command): string {
    const { requestId: _ignored, ...rest } = command;
    const sort = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(sort)
            : record(v)
              ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
              : v;
    return sha256Hex(JSON.stringify(sort(rest)));
}


