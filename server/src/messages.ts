import type { BoardItem, BoardSnapshot, Rect } from "../../src/shared/hunt.ts";
import type { ClaimResult, Player, RoomView, StartResult } from "./rules.ts";
import type { TauntMoment } from "./taunts.ts";

// Internal wire messages. The shared protocol in src/shared/protocol.ts will replace these through an adapter.

export const MAX_MESSAGE_CHARACTERS = 512 * 1024;
const MAX_ID_CHARACTERS = 128;
const MAX_TOKEN_CHARACTERS = 256;
const MAX_NAME_CHARACTERS = 40;
const MAX_COLOR_CHARACTERS = 32;
const MAX_STAMPS = 64;
const MAX_BOARD_ITEMS = 5_000;
const MAX_ITEM_POINTS = 2_000;
const BOARD_ITEM_KINDS = ["freedraw", "shape", "text", "image", "line", "other"] as const;

export type ClientMessage =
  | { type: "join"; token: string; player: Player }
  | { type: "round.start"; requestId: string; board: BoardSnapshot; stampIds: string[] }
  | { type: "find.claim"; requestId: string; roundId: string; targetId: string };

export type ErrorCode =
  | "invalid-message"
  | "too-large"
  | "rate-limited"
  | "not-joined"
  | "room-not-found"
  | "bad-token"
  | "request-reused"
  | "command-failed";

export type ServerMessage =
  | { type: "joined"; player: Player; room: RoomView }
  | { type: "room"; room: RoomView }
  | { type: "result"; requestId: string; result: StartResult | ClaimResult }
  | { type: "taunt"; moment: TauntMoment["kind"]; text: string }
  | { type: "error"; code: ErrorCode; message: string; requestId?: string };

export class InvalidMessage extends Error {}

type Fields = Readonly<Record<string, unknown>>;

const fields = (value: unknown, name: string): Fields => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidMessage(`${name} must be an object`);
  }
  return value as Fields;
};

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new InvalidMessage(`${name} must be a string of 1 to ${max} characters`);
  }
  return value;
};

const id = (value: unknown, name: string): string => text(value, name, MAX_ID_CHARACTERS);

const finite = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidMessage(`${name} must be a finite number`);
  }
  return value;
};

const list = <T>(value: unknown, name: string, max: number, item: (value: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > max) {
    throw new InvalidMessage(`${name} must be an array of at most ${max} items`);
  }
  return value.map(item);
};

const rect = (value: unknown, name: string): Rect => {
  const raw = fields(value, name);
  return {
    x: finite(raw.x, `${name}.x`),
    y: finite(raw.y, `${name}.y`),
    width: finite(raw.width, `${name}.width`),
    height: finite(raw.height, `${name}.height`),
  };
};

const point = (value: unknown): readonly [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) throw new InvalidMessage("A point must be [x, y]");
  return [finite(value[0], "point x"), finite(value[1], "point y")];
};

const boardItem = (value: unknown): BoardItem => {
  const raw = fields(value, "board item");
  const kind = BOARD_ITEM_KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) throw new InvalidMessage("board item kind is unknown");
  return {
    rect: rect(raw.rect, "board item rect"),
    kind,
    ...(raw.strokeColor === undefined
      ? {}
      : { strokeColor: text(raw.strokeColor, "strokeColor", MAX_COLOR_CHARACTERS) }),
    ...(raw.strokeWidth === undefined ? {} : { strokeWidth: finite(raw.strokeWidth, "strokeWidth") }),
    ...(raw.points === undefined
      ? {}
      : { points: list(raw.points, "points", MAX_ITEM_POINTS, point) }),
  };
};

const board = (value: unknown): BoardSnapshot => {
  const raw = fields(value, "board");
  const frameRect = rect(raw.frameRect, "frameRect");
  if (frameRect.width <= 0 || frameRect.height <= 0) {
    throw new InvalidMessage("frameRect must have a positive size");
  }
  return { frameRect, items: list(raw.items, "items", MAX_BOARD_ITEMS, boardItem) };
};

const playerName = (value: unknown): string => {
  const normalized = text(value, "player.name", MAX_TOKEN_CHARACTERS)
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const name = Array.from(normalized).slice(0, MAX_NAME_CHARACTERS).join("");
  if (name.length === 0) throw new InvalidMessage("player.name must not be blank");
  return name;
};

const player = (value: unknown): Player => {
  const raw = fields(value, "player");
  return {
    id: id(raw.id, "player.id"),
    name: playerName(raw.name),
    color: text(raw.color, "player.color", MAX_COLOR_CHARACTERS),
  };
};

export function parseClientMessage(message: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new InvalidMessage("Message is not JSON");
  }
  const raw = fields(value, "message");
  switch (raw.type) {
    case "join":
      return {
        type: "join",
        token: text(raw.token, "token", MAX_TOKEN_CHARACTERS),
        player: player(raw.player),
      };
    case "round.start":
      return {
        type: "round.start",
        requestId: id(raw.requestId, "requestId"),
        board: board(raw.board),
        stampIds: list(raw.stampIds, "stampIds", MAX_STAMPS, (stampId) => id(stampId, "stampId")),
      };
    case "find.claim":
      return {
        type: "find.claim",
        requestId: id(raw.requestId, "requestId"),
        roundId: id(raw.roundId, "roundId"),
        targetId: id(raw.targetId, "targetId"),
      };
    default:
      throw new InvalidMessage("Unknown message type");
  }
}
