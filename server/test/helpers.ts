import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { BoardSnapshot, Round } from "../../src/shared/hunt.ts";
import {
  type Command,
  type Fault,
  type FaultCode,
  parseServer,
  type Player,
  type Result,
  type ServerMessage,
  type Snapshot,
  type WireRoom,
} from "../../src/shared/protocol.ts";

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
export const alice: Player = { playerId: "alice", name: "Alice", color: "#e03131" };
export const bob: Player = { playerId: "bob", name: "Bob", color: "#1971c2" };

export type LiveRound = Extract<Round, { status: "live" }>;
type CommandBody = Command extends infer C ? (C extends Command ? Omit<C, "v" | "requestId"> : never) : never;
export type RoomKeys = { roomId: string; joinToken: string };

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const roomKeys = (): RoomKeys => ({ roomId: crypto.randomUUID(), joinToken: hex(32) });

export type Client = {
  send: (message: unknown) => void;
  /** Every message received so far, in order, each one parsed with the protocol's parseServer. */
  received: ServerMessage[];
  /** Frames that failed parseServer. Must stay empty. */
  invalid: string[];
  /** First message at or after `from` that matches, waiting for it if needed. */
  waitFor: <T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    from?: number,
  ) => Promise<T>;
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
};

export async function connect(roomId: string): Promise<Client> {
  const response = await exports.default.fetch(`https://example.com/rooms/${roomId}`, {
    headers: { Upgrade: "websocket", Origin: "null" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const received: ServerMessage[] = [];
  const invalid: string[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    try {
      received.push(parseServer(String(event.data)));
    } catch {
      invalid.push(String(event.data));
    }
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
    received,
    invalid,
    waitFor,
    closed,
    close: () => {
      expect(invalid).toEqual([]);
      socket.close(1000, "test done");
    },
  };
}

export const snapshotWhere =
  (predicate: (room: WireRoom, snapshot: Snapshot) => boolean) =>
  (message: ServerMessage): message is Snapshot =>
    message.type === "snapshot" && predicate(message.room, message);

export const resultFor =
  (requestId: string) =>
  (message: ServerMessage): message is Result =>
    message.type === "result" && message.requestId === requestId;

export const faultCoded =
  (code: FaultCode) =>
  (message: ServerMessage): message is Fault =>
    message.type === "fault" && message.code === code;

export async function joined(keys: RoomKeys, player: Player): Promise<{ client: Client; first: Snapshot }> {
  const client = await connect(keys.roomId);
  client.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player });
  const first = await client.waitFor(snapshotWhere(() => true));
  return { client, first };
}

let requests = 0;
export const requestId = (label: string): string => `${label.replaceAll(".", "-")}-${++requests}`;

export async function command(client: Client, body: CommandBody, id = requestId(body.type)): Promise<Result> {
  const from = client.received.length;
  client.send({ v: 1, requestId: id, ...body });
  return client.waitFor(resultFor(id), from);
}

export async function startLive(client: Client): Promise<LiveRound> {
  const result = await command(client, { type: "round.start", board });
  expect(result.code).toBe("ok");
  const live = await client.waitFor(
    snapshotWhere((room, snapshot) => room.current?.status === "live" && snapshot.revision >= result.revision),
  );
  return live.room.current as LiveRound;
}

export const claim = (client: Client, round: LiveRound, targetId: string, id?: string): Promise<Result> =>
  command(client, { type: "find.claim", roundId: round.id, targetId }, id);
