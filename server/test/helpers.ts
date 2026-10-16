import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { BoardSnapshot } from "../../src/shared/hunt.ts";
import type { ClientMessage, ServerMessage } from "../src/messages.ts";
import type { LiveRound, Player, RoomView } from "../src/rules.ts";

export const board: BoardSnapshot = {
  frameRect: { x: 0, y: 0, width: 800, height: 600 },
  items: [
    {
      rect: { x: 10, y: 10, width: 100, height: 80 },
      kind: "freedraw",
      points: [
        [10, 10],
        [110, 90],
      ],
    },
  ],
};
export const stampIds = ["cat", "229"];
export const alice: Player = { id: "alice", name: "Alice", color: "#e03131" };
export const bob: Player = { id: "bob", name: "Bob", color: "#1971c2" };

type RoomMessage = Extract<ServerMessage, { type: "room" }>;
type ResultMessage = Extract<ServerMessage, { type: "result" }>;

export async function createRoom(): Promise<{ roomId: string; token: string }> {
  const response = await exports.default.fetch("https://example.com/api/rooms", {
    method: "POST",
    headers: { Origin: "null" },
  });
  expect(response.status).toBe(201);
  return response.json();
}

export type Client = {
  send: (message: ClientMessage | string) => void;
  close: () => void;
  /** Every message received so far, in order. */
  received: ServerMessage[];
  /** First message at or after `from` that matches, waiting for it if needed. */
  waitFor: <T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    from?: number,
  ) => Promise<T>;
  closed: Promise<{ code: number; reason: string }>;
};

export async function connect(roomId: string): Promise<Client> {
  const response = await exports.default.fetch(`https://example.com/api/rooms/${roomId}`, {
    headers: { Upgrade: "websocket", Origin: "null" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const received: ServerMessage[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    received.push(JSON.parse(String(event.data)) as ServerMessage);
    for (const listener of listeners) listener();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
  );
  const waitFor = <T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    from = 0,
  ): Promise<T> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const match = received.slice(from).find(predicate);
        if (match === undefined) return false;
        listeners.delete(listener);
        resolve(match);
        return true;
      };
      const listener = (): void => void check();
      if (!check()) listeners.add(listener);
    });
  return {
    send: (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
    close: () => socket.close(1000, "test done"),
    received,
    waitFor,
    closed,
  };
}

export const roomWhere =
  (predicate: (room: RoomView) => boolean) =>
  (message: ServerMessage): message is RoomMessage =>
    message.type === "room" && predicate(message.room);

export const resultFor =
  (requestId: string) =>
  (message: ServerMessage): message is ResultMessage =>
    message.type === "result" && message.requestId === requestId;

export const errorCoded =
  (code: string) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: "error" }> =>
    message.type === "error" && message.code === code;

export async function joinedClient(
  room: { roomId: string; token: string },
  player: Player,
): Promise<{ client: Client; view: RoomView }> {
  const client = await connect(room.roomId);
  client.send({ type: "join", token: room.token, player });
  const joined = await client.waitFor(
    (message): message is Extract<ServerMessage, { type: "joined" }> => message.type === "joined",
  );
  return { client, view: joined.room };
}

export async function startRound(client: Client, requestId = "start-1"): Promise<LiveRound> {
  client.send({ type: "round.start", requestId, board, stampIds });
  const { result } = await client.waitFor(resultFor(requestId));
  if (result.kind !== "started") throw new Error(`start failed: ${result.kind}`);
  const live = await client.waitFor(
    roomWhere((room) => room.current?.status === "live" && room.current.id === result.roundId),
  );
  if (live.room.current?.status !== "live") throw new Error("round is not live");
  return live.room.current;
}

export async function claim(
  client: Client,
  requestId: string,
  roundId: string,
  targetId: string,
): Promise<ResultMessage["result"]> {
  client.send({ type: "find.claim", requestId, roundId, targetId });
  return (await client.waitFor(resultFor(requestId))).result;
}
