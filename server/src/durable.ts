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
import { plant } from "./placement.ts";
import { type ClaimResult, readyNext, type StartResult } from "./rules.ts";

export type OpenRoom = { tokenHash: string; room: Room };

/** The room's whole durable state. `open` is null until the room is created. */
export const HuntDoc = defineDoc<{ open: OpenRoom | null }>({
  kind: "app.hunt",
  version: 1,
  scope: "session",
  initial: () => ({ open: null }),
});

/** `key` fingerprints what the requestId was first used for, so a reuse for anything else is refused. */
export type Receipt = { key: string; result: StartResult | ClaimResult };

export const HuntReceipts = defineDocFamily<{ receipt?: Receipt }, null>({
  family: true,
  kind: "app.hunt-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

/** Plants the next round while the current one plays. `plant` is pure, so a rerun after eviction lands the same targets. */
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
          doc.open.room = readyNext(doc.open.room, task.input.roundId, targets);
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
