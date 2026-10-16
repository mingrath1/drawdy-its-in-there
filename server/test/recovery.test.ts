import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { targetCount } from "../../src/shared/protocol.ts";
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
          doc.open!.room = { ...room, next: { status: "planting", id: "seeded-next", frameRect: board.frameRect } };
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
