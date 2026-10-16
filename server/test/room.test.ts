import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../src/shared/hunt.ts";
import { HuntDoc, huntHarnessOptions, plain } from "../src/durable.ts";
import { HELLO_TIMEOUT_MS, MAX_PENDING_HELLOS, MAX_PLAYERS_ONLINE } from "../src/room.ts";
import {
  MAX_FRAME_CHARS,
  MAX_LEAGUE,
  roundDurationMs,
  type ServerMessage,
  targetCount,
} from "../../src/shared/protocol.ts";
import {
  alice,
  board,
  bob,
  claim,
  command,
  connect,
  faultCoded,
  joined,
  type LiveRound,
  requestId,
  resultFor,
  roomKeys,
  snapshotWhere,
  startLive,
} from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const isEnded = snapshotWhere((room) => room.current?.status === "ended");

/** Every row the room keeps in its own tables, so a test can look at what is stored. */
const storedRows = (roomId: string): Promise<Record<string, unknown>[]> =>
  runInDurableObject(env.ROOMS.getByName(roomId), (_instance, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'")
      .toArray()
      .flatMap(({ name }) => state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()),
  );

describe("room access", () => {
  it("creates the room on the first hello over a null-origin socket", async () => {
    const keys = roomKeys();
    const { client, first } = await joined(keys, alice);

    expect(first).toMatchObject({
      self: "alice",
      taunt: null,
      room: {
        roomId: keys.roomId,
        difficulty: 1,
        league: [{ playerId: "alice", playerName: "Alice", finds: 0, roundsWon: 0 }],
        current: null,
        next: null,
        roundsPlayed: 0,
      },
    });
    client.close();
  });

  it("admits a second player with the same token and refuses a different one", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const { client: b, first } = await joined(keys, bob);
    expect(first.room.league.map(({ playerId }) => playerId)).toEqual(["alice", "bob"]);

    const intruder = await connect(keys.roomId);
    intruder.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: roomKeys().joinToken, player: bob });
    await intruder.waitFor(faultCoded("auth"));
    expect((await intruder.closed).code).toBe(1008);
    a.close();
    b.close();
  });

  it("refuses a hello whose room id differs from the socket's path", async () => {
    const keys = roomKeys();
    const client = await connect(keys.roomId);
    client.send({ v: 1, type: "hello", roomId: roomKeys().roomId, joinToken: keys.joinToken, player: alice });

    await client.waitFor(faultCoded("auth"));
    expect((await client.closed).code).toBe(1008);
  });

  it("refuses a hello whose room id is not derived from its token, and creates nothing", async () => {
    const keys = roomKeys();
    const squatter = await connect(keys.roomId);
    squatter.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: roomKeys().joinToken, player: bob });
    await squatter.waitFor(faultCoded("auth"));
    expect((await squatter.closed).code).toBe(1008);

    const { client, first } = await joined(keys, alice);
    expect(first.room.league.map(({ playerId }) => playerId)).toEqual(["alice"]);
    client.close();
  });

  it("refuses a new player once the league is full, changing nothing, and still admits a listed one", async () => {
    const keys = roomKeys();
    const player = (i: number) => ({ playerId: `p${i}`, name: `Player ${i}`, color: "#698cf9" });
    let revision = 0;
    for (let i = 0; i < MAX_LEAGUE; i++) {
      const { client, first } = await joined(keys, player(i));
      revision = first.revision;
      client.close();
      await client.closed;
    }

    const late = await connect(keys.roomId);
    late.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: player(MAX_LEAGUE) });
    await late.waitFor(faultCoded("full"));
    expect((await late.closed).code).toBe(1008);

    const { client: back, first } = await joined(keys, player(0));
    expect(first.revision).toBe(revision);
    expect(first.room.league).toHaveLength(MAX_LEAGUE);
    expect(first.room.league.some(({ playerId }) => playerId === `p${MAX_LEAGUE}`)).toBe(false);
    back.close();
  }, 30_000);

  it("admits at most MAX_PLAYERS_ONLINE distinct players when hellos race", async () => {
    const keys = roomKeys();
    const player = (i: number) => ({ playerId: `p${i}`, name: `Player ${i}`, color: "#698cf9" });
    const online = [];
    for (let i = 0; i < MAX_PLAYERS_ONLINE - 1; i++) online.push((await joined(keys, player(i))).client);

    const racers = await Promise.all([connect(keys.roomId), connect(keys.roomId), connect(keys.roomId)]);
    racers.forEach((racer, i) =>
      racer.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: player(100 + i) }),
    );
    const outcomes = await Promise.all(
      racers.map((racer) =>
        racer.waitFor((m): m is ServerMessage => m.type === "snapshot" || (m.type === "fault" && m.code === "unavailable")),
      ),
    );
    expect(outcomes.map(({ type }) => type).toSorted()).toEqual(["fault", "fault", "snapshot"]);
    expect(racers.some((racer) => racer.received.some(faultCoded("full")))).toBe(false);
    for (const client of [...online, ...racers.filter((_, i) => outcomes[i]!.type === "snapshot")]) client.close();
  }, 20_000);

  it("counts a player with two connections once against MAX_PLAYERS_ONLINE", async () => {
    const keys = roomKeys();
    const player = (i: number) => ({ playerId: `p${i}`, name: `Player ${i}`, color: "#698cf9" });
    const online = [];
    for (let i = 0; i < MAX_PLAYERS_ONLINE; i++) online.push((await joined(keys, player(i))).client);

    const { client: second } = await joined(keys, player(0));
    const late = await connect(keys.roomId);
    late.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: player(MAX_PLAYERS_ONLINE) });
    const fault = await late.waitFor(faultCoded("unavailable"));
    expect(fault.retryAfterMs, "a place frees when someone leaves, so the player is told to try again").toBeGreaterThan(0);
    for (const client of [...online, second]) client.close();
  }, 20_000);

  it("refuses commands before hello", async () => {
    const client = await connect(roomKeys().roomId);
    client.send({ v: 1, type: "find.claim", requestId: "r1", roundId: "x", targetId: "y" });

    await client.waitFor(faultCoded("auth"));
    expect((await client.closed).code).toBe(1008);
  });

  it("answers a close without a status code with a normal close", async () => {
    const { client } = await joined(roomKeys(), alice);
    client.closeWithoutCode();
    expect((await client.closed).code).toBe(1000);
  });

  it("answers a CORS preflight from the driver's null origin", async () => {
    const response = await exports.default.fetch(`https://example.com/rooms/${roomKeys().roomId}`, {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("never stores the join token", async () => {
    const keys = roomKeys();
    const { client } = await joined(keys, alice);
    const stored = JSON.stringify(await storedRows(keys.roomId));
    expect(stored).toContain(keys.roomId);
    expect(stored).not.toContain(keys.joinToken);
    client.close();
  });
});

describe("rounds", () => {
  it("plays a full round from start to all-found", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const { client: b } = await joined(keys, bob);

    const round = await startLive(a);
    expect(round.targets).toHaveLength(targetCount(1));
    expect(round.endsAt - round.startedAt).toBe(roundDurationMs(1));
    await b.waitFor(snapshotWhere((room) => room.current?.id === round.id));

    const claimers = [a, b, a];
    for (const [index, target] of round.targets.entries()) {
      expect((await claim(claimers[index]!, round, target.id)).code).toBe("ok");
    }

    const ended = await b.waitFor(isEnded);
    expect(ended.room).toMatchObject({
      current: { id: round.id, status: "ended", reason: "all-found" },
      difficulty: 1,
      nextDifficulty: 2,
      roundsPlayed: 1,
      league: [
        { playerId: "alice", finds: 2, roundsWon: 1 },
        { playerId: "bob", finds: 1, roundsWon: 0 },
      ],
    });
    expect(ended.taunt).toEqual(expect.any(String));
    a.close();
    b.close();
  });

  it("answers busy to a second start while a round is live", async () => {
    const { client } = await joined(roomKeys(), alice);
    await startLive(client);
    expect((await command(client, { type: "round.start", board })).code).toBe("busy");
    client.close();
  });

  it("ends the round at its deadline when the alarm fires", async () => {
    const keys = roomKeys();
    const { client } = await joined(keys, alice);
    const round = await startLive(client);
    await claim(client, round, round.targets[0]!.id);
    const stub = env.ROOMS.getByName(keys.roomId);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(round.endsAt);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(client.received.some(isEnded)).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 1);
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(round.endsAt));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const ended = await client.waitFor(isEnded);
    expect(ended.room.current).toMatchObject({
      id: round.id,
      reason: "time-up",
      endedAt: round.endsAt,
      finds: [{ targetId: round.targets[0]!.id, playerId: "alice" }],
    });
    expect(ended.room.league).toEqual([{ playerId: "alice", playerName: "Alice", finds: 1, roundsWon: 1 }]);
    client.close();
  });

  it("commits nothing when the alarm fires before the round's deadline", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const { client } = await joined(keys, alice);
    await startLive(client);
    // Harness is a factory, so find the prototype every harness commits through on a throwaway one.
    const committer = await runInDurableObject(stub, async (_instance, state) => {
      const harness = await Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        huntHarnessOptions(() => {}),
        BACKGROUND_CONTEXT,
      );
      await harness.close(BACKGROUND_CONTEXT);
      let owner: object = harness;
      while (!Object.hasOwn(owner, "commit")) owner = Object.getPrototypeOf(owner) as object;
      return owner as Pick<typeof harness, "commit">;
    });
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 10_000));
    const commits = vi.spyOn(committer, "commit");

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(commits).not.toHaveBeenCalled();
    client.close();
  });

  it("scores a target once when two players claim it in the same tick", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const { client: b } = await joined(keys, bob);
    const round = await startLive(a);
    const targetId = round.targets[0]!.id;

    a.send({ v: 1, type: "find.claim", requestId: "alice-claim", roundId: round.id, targetId });
    b.send({ v: 1, type: "find.claim", requestId: "bob-claim", roundId: round.id, targetId });
    const codes = [
      (await a.waitFor(resultFor("alice-claim"))).code,
      (await b.waitFor(resultFor("bob-claim"))).code,
    ];

    expect(codes.toSorted()).toEqual(["ok", "taken"]);
    const winner = codes[0] === "ok" ? "alice" : "bob";
    const after = await a.waitFor(
      snapshotWhere((room) => room.current?.status === "live" && room.current.finds.length > 0),
    );
    expect((after.room.current as LiveRound).finds).toEqual([expect.objectContaining({ targetId, playerId: winner })]);
    expect(after.room.league.map(({ finds }) => finds).toSorted()).toEqual([0, 1]);
    a.close();
    b.close();
  });

  it("replays a claim by requestId without scoring twice, and still answers ok after the round ended", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const { client: b } = await joined(keys, bob);
    const round = await startLive(a);
    const [first, ...rest] = round.targets;

    const original = await claim(a, round, first!.id, "claim-first");
    const replay = await claim(a, round, first!.id, "claim-first");
    expect(original.code).toBe("ok");
    expect(replay).toEqual(original);
    expect((await claim(b, round, first!.id, "claim-first")).code).toBe("taken");

    for (const target of rest) await claim(b, round, target.id);
    const ended = await a.waitFor(isEnded);
    expect(ended.room.league).toEqual([
      { playerId: "alice", playerName: "Alice", finds: 1, roundsWon: 0 },
      { playerId: "bob", playerName: "Bob", finds: rest.length, roundsWon: 1 },
    ]);

    const afterEnd = await claim(a, round, first!.id, "claim-first");
    expect(afterEnd).toEqual(original);
    expect((await claim(a, round, first!.id)).code).toBe("not-live");
    a.close();
    b.close();
  });

  it("stores a receipt whose size does not grow with the board it answered", async () => {
    const storedAfterStart = async (startBoard: BoardSnapshot): Promise<number> => {
      const keys = roomKeys();
      const { client } = await joined(keys, alice);
      expect((await command(client, { type: "round.start", board: startBoard })).code).toBe("ok");
      client.close();
      return JSON.stringify(await storedRows(keys.roomId)).length;
    };
    const items = Array.from({ length: 500 }, (_, i) => ({
      rect: { x: 10 + (i % 25) * 30, y: 10 + Math.floor(i / 25) * 28, width: 25, height: 25 },
      kind: "freedraw" as const,
      points: Array.from({ length: 14 }, (_, j): [number, number] => [
        10.123456789 + (i % 25) * 30 + j,
        10.987654321 + Math.floor(i / 25) * 28 + j,
      ]),
    }));
    const bigBoard: BoardSnapshot = { frameRect: board.frameRect, items };
    const extra = JSON.stringify(bigBoard).length - JSON.stringify(board).length;
    expect(extra).toBeGreaterThan(150_000);

    const growth = (await storedAfterStart(bigBoard)) - (await storedAfterStart(board));
    expect(growth).toBeLessThan(2_000);
  });

  it("keeps a player's newest 512 receipts, so only an older retry runs again, and stops growing", async () => {
    const keys = roomKeys();
    const { client } = await joined(keys, alice);
    let clock = Date.now();
    // Each read moves the clock, so the rate limit refills between messages.
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 100));
    const sendSets = async (from: number, to: number): Promise<number> => {
      for (let i = from; i < to; i++) {
        client.send({ v: 1, type: "difficulty.set", requestId: `set-${i}`, value: 1 + (i % 2) });
      }
      await client.waitFor(resultFor(`set-${to - 1}`));
      return JSON.stringify(await storedRows(keys.roomId)).length;
    };

    const afterFirst = await sendSets(0, 600);
    expect((await command(client, { type: "difficulty.set", value: 3 }, "set-88")).code).toBe("request-conflict");
    expect((await command(client, { type: "difficulty.set", value: 3 }, "set-87")).code).toBe("ok");

    const afterSecond = await sendSets(600, 1_200);
    expect(afterSecond).toBeLessThan(afterFirst * 1.25);
    client.close();
  }, 20_000);

  it("answers request-conflict when a requestId returns with a changed payload", async () => {
    const { client } = await joined(roomKeys(), alice);
    const round = await startLive(client);
    const [first, second] = round.targets;

    expect((await claim(client, round, first!.id, "reused")).code).toBe("ok");
    const conflict = await claim(client, round, second!.id, "reused");
    expect(conflict.code).toBe("request-conflict");

    const latest = client.received.filter(snapshotWhere(() => true)).at(-1)!;
    expect((latest.room.current as LiveRound).finds.map(({ targetId }) => targetId)).toEqual([first!.id]);
    expect((await claim(client, round, second!.id)).code).toBe("ok");
    client.close();
  });

  it("pre-plants the next round from the first board offer and promotes it on start", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const { client: b } = await joined(keys, bob);
    const round = await startLive(a);

    const offers = await Promise.all([
      command(a, { type: "board.offer", afterRoundId: round.id, board }),
      command(b, { type: "board.offer", afterRoundId: round.id, board }),
    ]);
    expect(offers.map(({ code }) => code)).toEqual(["ok", "ok"]);
    const ready = await a.waitFor(snapshotWhere((room) => room.next?.status === "ready"));
    expect(ready.room.current).toMatchObject({ id: round.id, status: "live" });
    const nextId = ready.room.next!.id;

    for (const target of round.targets) await claim(a, round, target.id);
    await a.waitFor(isEnded);
    const second = await startLive(a);
    expect(second.id).toBe(nextId);
    expect(second.targets).toHaveLength(targetCount(2));
    a.close();
    b.close();
  });

  it("never puts a round's targets on the wire before it is live", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const round = await startLive(a);
    await command(a, { type: "board.offer", afterRoundId: round.id, board });
    const ready = await a.waitFor(snapshotWhere((room) => room.next?.status === "ready"));
    const { client: late } = await joined(keys, bob);
    for (const target of round.targets) await claim(a, round, target.id);
    await a.waitFor(isEnded);
    const beforePromotion = [...a.received, ...late.received];

    const second = await startLive(a);
    expect(second.id).toBe(ready.room.next!.id);

    for (const message of beforePromotion) {
      const text = JSON.stringify(message);
      for (const target of second.targets) expect(text).not.toContain(JSON.stringify(target.id));
    }
    for (const message of [...a.received, ...late.received]) {
      if (message.type !== "snapshot") continue;
      expect(message.room.next === null || !("targets" in message.room.next)).toBe(true);
      const current = message.room.current;
      if (current?.status === "planting" || current?.status === "ready") {
        expect("targets" in current).toBe(false);
      }
    }
    a.close();
    late.close();
  });

  it("cancels a live round and changes the level only between rounds", async () => {
    const { client } = await joined(roomKeys(), alice);
    const round = await startLive(client);
    expect((await command(client, { type: "difficulty.set", value: 4 })).code).toBe("busy");

    expect((await command(client, { type: "round.cancel", roundId: round.id })).code).toBe("ok");
    const ended = await client.waitFor(isEnded);
    expect(ended.room.current).toMatchObject({ id: round.id, reason: "cancelled" });

    expect(ended.room.roundsPlayed).toBe(0);
    expect((await command(client, { type: "difficulty.set", value: 4 })).code).toBe("ok");
    const harder = await startLive(client);
    expect(harder.targets).toHaveLength(targetCount(4));
    expect(harder.endsAt - harder.startedAt).toBe(roundDurationMs(4));
    client.close();
  });
});

describe("snapshots", () => {
  const snapshotsIn = (messages: ServerMessage[]) => messages.filter(snapshotWhere(() => true));

  it("gives a joining player one snapshot, carrying the taunt of the change its hello published", async () => {
    const keys = roomKeys();
    const { client: a } = await joined(keys, alice);
    const round = await startLive(a);
    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 1);

    const { client: b, first } = await joined(keys, bob);
    expect((await command(b, { type: "round.cancel", roundId: "none" })).code).toBe("stale");
    expect(first.room.current).toMatchObject({ id: round.id, reason: "time-up" });
    expect(first.taunt).toEqual(expect.any(String));
    expect(snapshotsIn(b.received)).toHaveLength(1);
    a.close();
    b.close();
  });

  it("answers a replayed command with one snapshot when its commit published one", async () => {
    const { client } = await joined(roomKeys(), alice);
    const round = await startLive(client);
    expect((await claim(client, round, round.targets[0]!.id, "first-claim")).code).toBe("ok");
    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 1);

    const from = client.received.length;
    expect((await claim(client, round, round.targets[0]!.id, "first-claim")).code).toBe("ok");
    const sent = snapshotsIn(client.received.slice(from));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.room.current).toMatchObject({ id: round.id, reason: "time-up" });
    expect(sent[0]!.taunt).toEqual(expect.any(String));
    client.close();
  });
});

describe("wire safety", () => {
  it("logs an alarm refresh that fails after the reply instead of faulting the connection", async () => {
    const keys = roomKeys();
    const { client } = await joined(keys, alice);
    await runInDurableObject(env.ROOMS.getByName(keys.roomId), (_instance, state) => {
      const transaction = state.storage.transaction.bind(state.storage);
      vi.spyOn(state.storage, "transaction").mockImplementation((closure) =>
        transaction((txn) =>
          closure(Object.assign(Object.create(txn), { getAlarm: () => Promise.reject(new Error("alarm storage down")) })),
        ),
      );
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await command(client, { type: "difficulty.set", value: 2 })).code).toBe("ok");
    expect((await command(client, { type: "difficulty.set", value: 3 })).code).toBe("ok");
    expect(client.received.some(faultCoded("unavailable"))).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("alarm storage down"));
    client.close();
  });

  it("withholds and logs a snapshot its clients would reject", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const { client: a } = await joined(keys, alice);
    a.close();
    await runInDurableObject(stub, async (_instance, state) => {
      const harness = await Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        huntHarnessOptions(() => {}),
        BACKGROUND_CONTEXT,
      );
      try {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(HuntDoc);
          const room = plain(doc.open!.room);
          doc.open!.room = { ...room, league: [{ ...room.league[0]!, playerName: "bell\u0007" }] };
          doc.open!.revision += 1;
        }, BACKGROUND_CONTEXT);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    });
    await evictDurableObject(stub);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const b = await connect(keys.roomId);
    b.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: bob });
    expect((await command(b, { type: "difficulty.set", value: 2 })).code).toBe("ok");

    expect(b.invalid).toEqual([]);
    expect(b.received.filter(snapshotWhere(() => true))).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("snapshot"));
    b.close();
  });
});

describe("connections waiting for hello", () => {
  it("closes a connection that sends no hello within HELLO_TIMEOUT_MS, by alarm", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const openedAt = Date.now();
    const idle = await connect(keys.roomId);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + HELLO_TIMEOUT_MS);

    vi.spyOn(Date, "now").mockReturnValue(openedAt + HELLO_TIMEOUT_MS + 1_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await idle.closed).code).toBe(1008);
  });

  it("refuses a hello that comes after HELLO_TIMEOUT_MS", async () => {
    const keys = roomKeys();
    const openedAt = Date.now();
    const late = await connect(keys.roomId);
    vi.spyOn(Date, "now").mockReturnValue(openedAt + HELLO_TIMEOUT_MS + 1_000);
    late.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: alice });
    expect((await late.closed).code).toBe(1008);
    expect(late.received.some(snapshotWhere(() => true))).toBe(false);
  });

  it("refuses a connection while MAX_PENDING_HELLOS others wait for hello", async () => {
    const keys = roomKeys();
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_HELLOS }, () => connect(keys.roomId)));
    const extra = await connect(keys.roomId);
    const fault = await extra.waitFor(faultCoded("unavailable"));
    expect(fault.retryAfterMs).toBe(HELLO_TIMEOUT_MS);
    expect((await extra.closed).code).toBe(1008);

    waiting[0]!.send({ v: 1, type: "hello", roomId: keys.roomId, joinToken: keys.joinToken, player: alice });
    await waiting[0]!.waitFor(snapshotWhere(() => true));
    const { client } = await joined(keys, bob);
    for (const socket of [...waiting, client]) socket.close();
  });
});

describe("abuse limits", () => {
  it("rejects an oversized frame and closes the socket", async () => {
    const { client } = await joined(roomKeys(), alice);
    client.send("x".repeat(MAX_FRAME_CHARS + 1));

    await client.waitFor(faultCoded("invalid"));
    expect((await client.closed).code).toBe(1009);
  });

  it("rejects a malformed frame and closes the socket", async () => {
    const { client } = await joined(roomKeys(), alice);
    client.send({ v: 1, type: "find.claim", requestId: requestId("bad"), roundId: "x" });

    await client.waitFor(faultCoded("invalid"));
    expect((await client.closed).code).toBe(1002);
  });

  it("closes a connection that floods the room", async () => {
    const { client } = await joined(roomKeys(), alice);
    for (let index = 0; index < 30; index++) {
      client.send({ v: 1, type: "find.claim", requestId: `flood-${index}`, roundId: "none", targetId: "none" });
    }

    const fault = await client.waitFor(faultCoded("rate-limit"));
    expect(fault.retryAfterMs).toBeGreaterThan(0);
    expect((await client.closed).code).toBe(1008);
  });
});
