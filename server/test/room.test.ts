import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_CHARACTERS } from "../src/messages.ts";
import { MAX_DIFFICULTY, targetCount } from "../src/rules.ts";
import {
  alice,
  bob,
  claim,
  connect,
  createRoom,
  errorCoded,
  joinedClient,
  resultFor,
  roomWhere,
  startRound,
} from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("room access", () => {
  it("creates a room and admits a player with its token over a null-origin socket", async () => {
    const room = await createRoom();
    expect(room.token.length).toBeGreaterThanOrEqual(32);

    const { client, view } = await joinedClient(room, alice);

    expect(view).toMatchObject({
      roomId: room.roomId,
      difficulty: 1,
      league: [],
      current: null,
      next: null,
      roundsPlayed: 0,
    });
    client.close();
  });

  it("refuses a wrong token and closes the socket", async () => {
    const room = await createRoom();
    const client = await connect(room.roomId);
    client.send({ type: "join", token: `${room.token}x`, player: alice });

    await client.waitFor(errorCoded("bad-token"));
    expect((await client.closed).code).toBe(1008);
  });

  it("refuses a token for a room that was never created", async () => {
    const client = await connect(crypto.randomUUID());
    client.send({ type: "join", token: "anything", player: alice });

    await client.waitFor(errorCoded("room-not-found"));
    expect((await client.closed).code).toBe(1008);
  });

  it("refuses commands before join", async () => {
    const room = await createRoom();
    const client = await connect(room.roomId);
    client.send({ type: "find.claim", requestId: "r1", roundId: "x", targetId: "y" });

    await client.waitFor(errorCoded("not-joined"));
    expect((await client.closed).code).toBe(1008);
  });

  it("answers the driver's CORS preflight", async () => {
    const response = await exports.default.fetch("https://example.com/api/rooms", {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("stores only a hash of the join token", async () => {
    const room = await createRoom();
    const stored = await runInDurableObject(env.ROOMS.getByName(room.roomId), (_instance, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM sqlite_master").toArray()) +
      JSON.stringify(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
          .toArray()
          .flatMap(({ name }) =>
            String(name).startsWith("_cf") || String(name) === "sqlite_sequence"
              ? []
              : state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray(),
          ),
      ),
    );
    expect(stored).not.toContain(room.token);
  });
});

describe("rounds", () => {
  it("plays a full round from start to all-found", async () => {
    const room = await createRoom();
    const { client: a } = await joinedClient(room, alice);
    const { client: b } = await joinedClient(room, bob);

    const round = await startRound(a);
    expect(round.targets).toHaveLength(targetCount(1));
    await b.waitFor(roomWhere((view) => view.current?.id === round.id));

    const claimers = [a, b, a];
    for (const [index, target] of round.targets.entries()) {
      expect(await claim(claimers[index]!, `claim-${index}`, round.id, target.id)).toMatchObject({
        kind: "found",
      });
    }

    const ended = await b.waitFor(roomWhere((view) => view.current?.status === "ended"));
    expect(ended.room).toMatchObject({
      current: { id: round.id, status: "ended", reason: "all-found" },
      difficulty: 2,
      roundsPlayed: 1,
      league: [
        { playerId: "alice", playerName: "Alice", finds: 2, roundsWon: 1 },
        { playerId: "bob", playerName: "Bob", finds: 1, roundsWon: 0 },
      ],
    });
    await b.waitFor(
      (message): message is Extract<typeof message, { type: "taunt" }> =>
        message.type === "taunt" && message.moment === "round-end",
    );
    a.close();
    b.close();
  });

  it("refuses a second start while a round is live", async () => {
    const room = await createRoom();
    const { client } = await joinedClient(room, alice);
    await startRound(client);

    client.send({ type: "round.start", requestId: "start-2", board: { frameRect: { x: 0, y: 0, width: 10, height: 10 }, items: [] }, stampIds: ["cat"] });
    expect((await client.waitFor(resultFor("start-2"))).result).toEqual({ kind: "round-live" });
    client.close();
  });

  it("ends the round at its deadline when the alarm fires", async () => {
    const room = await createRoom();
    const { client } = await joinedClient(room, alice);
    const round = await startRound(client);
    await claim(client, "claim-0", round.id, round.targets[0]!.id);
    const stub = env.ROOMS.getByName(room.roomId);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(client.received.some(roomWhere((view) => view.current?.status === "ended"))).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 1);
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(round.endsAt));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const ended = await client.waitFor(roomWhere((view) => view.current?.status === "ended"));
    expect(ended.room.current).toMatchObject({
      id: round.id,
      reason: "time-up",
      endedAt: round.endsAt,
      finds: [{ targetId: round.targets[0]!.id, playerId: "alice" }],
    });
    expect(ended.room.league).toEqual([
      { playerId: "alice", playerName: "Alice", finds: 1, roundsWon: 1 },
    ]);
    client.close();
  });

  it("scores a target once when two players claim it in the same tick", async () => {
    const room = await createRoom();
    const { client: a } = await joinedClient(room, alice);
    const { client: b } = await joinedClient(room, bob);
    const round = await startRound(a);
    const targetId = round.targets[0]!.id;

    a.send({ type: "find.claim", requestId: "alice-claim", roundId: round.id, targetId });
    b.send({ type: "find.claim", requestId: "bob-claim", roundId: round.id, targetId });
    const results = [
      (await a.waitFor(resultFor("alice-claim"))).result,
      (await b.waitFor(resultFor("bob-claim"))).result,
    ];

    expect(results.map(({ kind }) => kind).sort()).toEqual(["found", "taken"]);
    const winner = results.find((result) => result.kind === "found");
    const loser = results.find((result) => result.kind === "taken");
    expect(loser).toMatchObject({ find: { playerId: (winner as { find: { playerId: string } }).find.playerId } });
    const view = await a.waitFor(roomWhere((room) => room.current?.status === "live" && room.current.finds.length === 1));
    expect(view.room.current?.status === "live" && view.room.current.finds).toHaveLength(1);
    a.close();
    b.close();
  });

  it("replays a claim by requestId without scoring it twice", async () => {
    const room = await createRoom();
    const { client: a } = await joinedClient(room, alice);
    const { client: b } = await joinedClient(room, bob);
    const round = await startRound(a);
    const [first, ...rest] = round.targets;

    const original = await claim(a, "claim-first", round.id, first!.id);
    const replay = await claim(a, "claim-first", round.id, first!.id);
    expect(original).toMatchObject({ kind: "found", find: { playerId: "alice" } });
    expect(replay).toEqual(original);

    b.send({ type: "find.claim", requestId: "claim-first", roundId: round.id, targetId: first!.id });
    await b.waitFor(errorCoded("request-reused"));

    for (const [index, target] of rest.entries()) await claim(b, `bob-${index}`, round.id, target.id);
    const ended = await a.waitFor(roomWhere((view) => view.current?.status === "ended"));
    expect(ended.room.league).toEqual([
      { playerId: "alice", playerName: "Alice", finds: 1, roundsWon: 0 },
      { playerId: "bob", playerName: "Bob", finds: rest.length, roundsWon: 1 },
    ]);
    expect(await claim(a, "claim-first", round.id, first!.id)).toEqual(original);
    a.close();
    b.close();
  });

  it("pre-plants the next round while the current one is live", async () => {
    const room = await createRoom();
    const { client } = await joinedClient(room, alice);
    const round = await startRound(client);

    const ready = await client.waitFor(roomWhere((view) => view.next?.status === "ready"));
    expect(ready.room.current).toMatchObject({ id: round.id, status: "live" });
    expect(ready.room.next).toEqual({ id: expect.any(String), status: "ready" });
    const nextId = ready.room.next!.id;

    for (const [index, target] of round.targets.entries()) {
      await claim(client, `claim-${index}`, round.id, target.id);
    }
    const second = await startRound(client, "start-2");
    expect(second.id).toBe(nextId);
    expect(second.targets).toHaveLength(targetCount(Math.min(MAX_DIFFICULTY, 2)));
    client.close();
  });
});

describe("abuse limits", () => {
  it("rejects an oversized message and closes the socket", async () => {
    const room = await createRoom();
    const { client } = await joinedClient(room, alice);
    client.send("x".repeat(MAX_MESSAGE_CHARACTERS + 1));

    await client.waitFor(errorCoded("too-large"));
    expect((await client.closed).code).toBe(1009);
  });

  it("closes a connection that sends more than 20 messages in a second", async () => {
    const room = await createRoom();
    const { client } = await joinedClient(room, alice);
    for (let index = 0; index < 25; index++) {
      client.send({ type: "find.claim", requestId: `flood-${index}`, roundId: "none", targetId: "none" });
    }

    await client.waitFor(errorCoded("rate-limited"));
    expect((await client.closed).code).toBe(1008);
  });
});
