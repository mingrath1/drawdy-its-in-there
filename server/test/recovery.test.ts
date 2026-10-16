import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, Harness, type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DIFFICULTY, targetCount } from "../../src/shared/protocol.ts";
import { HuntDoc, huntHarnessOptions, PlantNextRound, plain } from "../src/durable.ts";
import { alice, board, bob, claim, joined, type LiveRound, roomKeys, snapshotWhere, startLive } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

const openHarness = async (state: DurableObjectState): Promise<Harness> =>
  Harness.open(await openDurableObjectSqliteStorage(state.storage), huntHarnessOptions(() => {}), context);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("room recovery", () => {
  it("keeps a live round across eviction and still ends it at its deadline", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const { client: a } = await joined(keys, alice);
    const round = await startLive(a);
    await claim(a, round, round.targets[0]!.id);
    a.close();

    await evictDurableObject(stub);
    const { client: b, first } = await joined(keys, bob);
    expect(first.room.current).toEqual({ ...round, finds: [expect.objectContaining({ playerId: "alice" })] });
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(round.endsAt);

    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const ended = await b.waitFor(snapshotWhere((room) => room.current?.status === "ended"));
    expect(ended.room.current).toMatchObject({ id: round.id, reason: "time-up", endedAt: round.endsAt });
    expect(ended.room.roundsPlayed).toBe(1);
    b.close();
  });

  it("ends an overdue round as soon as an evicted room wakes", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const { client: a } = await joined(keys, alice);
    const round = await startLive(a);
    a.close();

    await evictDurableObject(stub);
    vi.spyOn(Date, "now").mockReturnValue(round.endsAt + 60_000);
    const { client: b, first } = await joined(keys, bob);

    expect(first.room.current).toMatchObject({ id: round.id, reason: "time-up", endedAt: round.endsAt });
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
    b.close();
  });

  it("opens a room stored under the old level rules, keeping its next level within MAX_DIFFICULTY", async () => {
    // Version 1 kept the next round's level, up to 10, in difficulty, and a hash of the join token.
    const HuntDocV1 = defineDoc<{ open: JsonObject | null }>({
      kind: "app.hunt",
      version: 1,
      scope: "session",
      initial: () => ({ open: null }),
    });
    for (const [stored, next] of [
      [3, 3],
      [7, MAX_DIFFICULTY],
    ] as const) {
      const keys = roomKeys();
      const stub = env.ROOMS.getByName(keys.roomId);
      await runInDurableObject(stub, async (_instance, state) => {
        const harness = await openHarness(state);
        try {
          await harness.commit(async (tx) => {
            const doc = await tx.doc(HuntDocV1);
            doc.open = {
              tokenHash: "0".repeat(64),
              revision: 9,
              taunt: null,
              room: {
                roomId: keys.roomId,
                difficulty: stored,
                league: [{ playerId: "alice", playerName: "Alice", finds: 3, roundsWon: 1 }],
                current: {
                  status: "ended",
                  id: "old-round",
                  frameRect: board.frameRect,
                  targets: [
                    {
                      id: "old-round:0",
                      stampId: "fish",
                      rect: { x: 10, y: 10, width: 40, height: 40 },
                      rotationDeg: 0,
                      strokeColor: "#fff",
                      strokeWidth: 2,
                    },
                  ],
                  startedAt: 1,
                  endedAt: 2,
                  finds: [],
                  reason: "all-found",
                },
                next: { status: "planting", id: "old-next", frameRect: board.frameRect },
                roundsPlayed: 6,
              },
            };
          }, context);
        } finally {
          await harness.close(context);
        }
      });
      await evictDurableObject(stub);

      const { client, first } = await joined(keys, bob);
      expect(first.revision).toBeGreaterThan(9);
      expect(first.room).toMatchObject({ nextDifficulty: next, next: null, roundsPlayed: 6 });
      expect(first.room.league.map(({ playerId }) => playerId)).toEqual(["alice", "bob"]);
      const round = await startLive(client);
      expect(round.targets).toHaveLength(targetCount(next));
      client.close();
    }
  });

  it("finishes a pre-plant that eviction interrupted", async () => {
    const keys = roomKeys();
    const stub = env.ROOMS.getByName(keys.roomId);
    const { client: a } = await joined(keys, alice);
    const round = await startLive(a);
    a.close();

    // Write the pending task as an earlier process would have, beside the live Room's own harness.
    await runInDurableObject(stub, async (_instance, state) => {
      const harness = await openHarness(state);
      try {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(HuntDoc);
          const room = plain(doc.open!.room);
          doc.open!.room = { ...room, next: { status: "planting", id: "seeded-next", frameRect: board.frameRect, level: 2 } };
          doc.open!.revision += 1;
          await tx.createTask(
            PlantNextRound,
            {
              roundId: "seeded-next",
              seed: 7,
              difficulty: room.difficulty,
              count: targetCount(room.difficulty),
              board,
              stampIds: ["sitting-cat", "fish"],
            },
            { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true },
          );
        }, context);
      } finally {
        await harness.close(context);
      }
      const check = await openHarness(state);
      try {
        const { tasks } = await check.inspect(context);
        expect(tasks.map(({ record }) => record.kind)).toEqual([PlantNextRound.definition.name]);
      } finally {
        await check.close(context);
      }
    });
    await evictDurableObject(stub);

    const { client: b } = await joined(keys, bob);
    const ready = await b.waitFor(snapshotWhere((room) => room.next?.status === "ready"));
    expect(ready.room.next).toEqual({ status: "ready", id: "seeded-next" });
    expect((ready.room.current as LiveRound).id).toBe(round.id);
    b.close();
  });
});
