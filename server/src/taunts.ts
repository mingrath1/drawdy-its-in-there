import type { Find, Room, Round } from "../../src/shared/hunt.ts";

export type TauntMoment =
  | { kind: "round-start"; roundId: string }
  | { kind: "find"; roundId: string; find: Find }
  | {
      kind: "round-end";
      roundId: string;
      reason: Extract<Round, { status: "ended" }>["reason"];
      found: number;
      total: number;
    };

export type TauntHost = (moment: TauntMoment) => string;

/** The moment a commit produced, read from the room before and after it. A round ending outranks its last find. */
export function momentOf(before: Room, after: Room): TauntMoment | null {
  const was = before.current;
  const round = after.current;
  if (round === null) return null;
  const same = was?.id === round.id ? was : null;
  if (round.status === "ended" && same?.status !== "ended") {
    return {
      kind: "round-end",
      roundId: round.id,
      reason: round.reason,
      found: round.finds.length,
      total: round.targets.length,
    };
  }
  if (round.status !== "live") return null;
  if (same?.status !== "live") return { kind: "round-start", roundId: round.id };
  const find = round.finds.at(-1);
  if (round.finds.length > same.finds.length && find !== undefined) {
    return { kind: "find", roundId: round.id, find };
  }
  return null;
}

const LINES = {
  "round-start": [
    "ซ่อนไว้แล้ว หาให้เจอนะ!",
    "It's in there. Somewhere.",
    "ดูดีๆ มันอยู่ในรูปนั่นแหละ",
    "Ready, set, squint.",
  ],
  find: ["ตาไวมาก!", "Spotted!", "เจอแล้ว!", "Nothing gets past you."],
  "all-found": ["เจอครบทุกตัว! รอบหน้ายากขึ้นนะ", "Clean sweep. The next one is meaner."],
  missed: ["หมดเวลา! ยังซ่อนอยู่อีกหลายตัวเลย", "Time's up. They were right there."],
  cancelled: ["ยกเลิกรอบนี้แล้ว", "Round called off."],
} as const satisfies Record<string, readonly string[]>;

const linesFor = (moment: TauntMoment): readonly string[] => {
  switch (moment.kind) {
    case "round-start":
      return LINES["round-start"];
    case "find":
      return LINES.find;
    case "round-end":
      switch (moment.reason) {
        case "all-found":
          return LINES["all-found"];
        case "time-up":
          return LINES.missed;
        case "cancelled":
          return LINES.cancelled;
      }
  }
};

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
};

/** Bundled Thai and English lines, picked deterministically from the moment. */
export const bundledTaunts: TauntHost = (moment) => {
  const lines = linesFor(moment);
  const salt = moment.kind === "find" ? moment.find.targetId : "";
  return lines[fnv1a(`${moment.kind}:${moment.roundId}:${salt}`) % lines.length]!;
};

/**
 * Extension point for an LLM taunt host, chosen by the TAUNT_HOST Worker variable, which is unset by default.
 * A model call cannot run inside a commit, so an LLM host would run as a durable pi-durable task that writes its
 * line into the hunt document, and the next snapshot would carry it. It chooses words only. It never draws and
 * never places targets.
 */
export function selectTauntHost(env: { readonly TAUNT_HOST?: string }): TauntHost {
  if (env.TAUNT_HOST === undefined || env.TAUNT_HOST === "") return bundledTaunts;
  throw new Error(`TAUNT_HOST=${env.TAUNT_HOST} names an LLM taunt host, and none is implemented yet`);
}
