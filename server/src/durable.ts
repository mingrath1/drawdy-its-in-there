import type { Draft } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import type { PlantRequest, Room } from "../../src/shared/hunt.ts";
import { plant } from "../../src/shared/placement.ts";
import type { CommandType, ResultCode } from "../../src/shared/protocol.ts";
import { plantFinished } from "../../src/shared/rules.ts";

/** `revision` orders snapshots; `taunt` is the line for the change that produced this revision. */
export type OpenRoom = { tokenHash: string; revision: number; taunt: string | null; room: Room };

/** `open` is null until the first hello creates the room. */
export const HuntDoc = defineDoc<{ open: OpenRoom | null }>({
  kind: "app.hunt",
  version: 1,
  scope: "session",
  initial: () => ({ open: null }),
});

export type Receipt = {
  fingerprint: string;
  command: CommandType;
  code: ResultCode;
  revision: number;
};

export const HuntReceipts = defineDocFamily<{ receipt?: Receipt }, null>({
  family: true,
  kind: "app.hunt-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

/** A receipt belongs to one player, so two players can use the same requestId. */
export const receiptKey = (playerId: string, requestId: string): string =>
  JSON.stringify([playerId, requestId]);

/** A plain copy of a draft or snapshot, safe to keep after its commit settles. */
export const plain = <T>(value: Draft<T> | Readonly<T>): T => JSON.parse(JSON.stringify(value));

/** Commits a new room state: one revision per public change, carrying that change's taunt. */
export function publish(open: Draft<OpenRoom>, before: Room, after: Room, taunt: string | null): void {
  if (after === before) return;
  open.room = after;
  open.revision += 1;
  open.taunt = taunt;
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
