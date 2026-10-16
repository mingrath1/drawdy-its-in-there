import type { Draft } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type CheckpointInfo,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import type { PlantRequest, Room } from "../../src/shared/hunt.ts";
import { plant } from "../../src/shared/placement.ts";
import { MAX_DIFFICULTY, type ResultCode } from "../../src/shared/protocol.ts";
import { plantFinished } from "../../src/shared/rules.ts";

/** Storage keeps every change as a delta until a base replaces them, so store a base now and then. */
const rebase = (_value: unknown, _ops: unknown, { deltasSinceBase }: CheckpointInfo): boolean =>
  deltasSinceBase >= 64;

/** `revision` orders snapshots; `taunt` is the line for the change that produced this revision. */
export type OpenRoom = { revision: number; taunt: string | null; room: Room };

/** Version 1 kept the next round's level in `difficulty`, up to 10, and a hash of the join token. */
type OpenRoomV1 = { revision: number; taunt: string | null; room: Omit<Room, "chosenDifficulty"> };

/** `open` is null until the first hello creates the room. */
export const HuntDoc = defineDoc<{ open: OpenRoom | null }>({
  kind: "app.hunt",
  version: 2,
  scope: "session",
  initial: () => ({ open: null }),
  // Keeps the level the next round plays at, and drops a pre-planted round, which had no level.
  migrate: (value) => {
    const open = value.open as OpenRoomV1 | null;
    if (open === null) return { open: null };
    const level = Math.min(MAX_DIFFICULTY, open.room.difficulty);
    const room: Room = { ...open.room, difficulty: level, chosenDifficulty: level, next: null };
    return { open: { revision: open.revision + 1, taunt: open.taunt, room } };
  },
  checkpointWhen: rebase,
});

export type Receipt = { requestId: string; fingerprint: string; code: ResultCode; revision: number };

/** A retry of a request older than the player's newest MAX_RECEIPTS runs again. */
export const MAX_RECEIPTS = 512;

/** One player's newest receipts, oldest first, keyed by playerId, so two players can use the same requestId. */
export const HuntReceipts = defineDocFamily<{ receipts: Receipt[] }, null>({
  family: true,
  kind: "app.hunt-receipts",
  version: 1,
  scope: "session",
  initial: () => ({ receipts: [] }),
  checkpointWhen: rebase,
});

/** A plain copy of a draft or snapshot, safe to keep after its commit settles. */
export const plain = <T>(value: Draft<T> | Readonly<T>): T => JSON.parse(JSON.stringify(value));

/**
 * Commits a new room state: one revision per public change, carrying that change's taunt. Returns whether it
 * changed anything, since only then does the commit broadcast a snapshot.
 */
export function publish(open: Draft<OpenRoom>, before: Room, after: Room, taunt: string | null): boolean {
  if (after === before) return false;
  open.room = after;
  open.revision += 1;
  open.taunt = taunt;
  return true;
}

/** `plant` is pure, so a rerun after eviction lands the same targets. */
export const PlantNextRound = defineTask<PlantRequest, { phase: "plant" }, null>({
  name: "app.plant-next-round",
  version: 1,
  initial: () => ({ phase: "plant" }),
  phases: {
    plant: async (task, runtime, context) => {
      const targets = plant(task.input);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(HuntDoc);
        if (doc.open !== null) {
          const before = plain<Room>(doc.open.room);
          publish(doc.open, before, plantFinished(before, task.input.roundId, targets), null);
        }
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

export function huntHarnessOptions(onReport: (error: unknown) => void): HarnessOptions {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "hunt", tasks: [PlantNextRound] }));
  return {
    // The host is deterministic and makes no model calls; pi-durable still requires a model table.
    models: createModels(),
    registry,
    // Retention timers are active Durable Object references and prevent hibernation.
    settings: { documentRetentionMs: 0 },
    onReport,
  };
}
