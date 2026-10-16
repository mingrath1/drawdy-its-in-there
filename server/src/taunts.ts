import type { Find } from "../../src/shared/hunt.ts";
import type { EndedRound } from "./rules.ts";

export type TauntMoment =
  | { kind: "round-start"; roundId: string; difficulty: number }
  | { kind: "find"; roundId: string; find: Find }
  | { kind: "round-end"; roundId: string; reason: EndedRound["reason"]; found: number; total: number };

export type TauntHost = (moment: TauntMoment) => Promise<string>;

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
} as const satisfies Record<string, readonly string[]>;

const linesFor = (moment: TauntMoment): readonly string[] => {
  switch (moment.kind) {
    case "round-start":
      return LINES["round-start"];
    case "find":
      return LINES.find;
    case "round-end":
      return moment.reason === "all-found" ? LINES["all-found"] : LINES.missed;
  }
};

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
};

export const bundledTaunts: TauntHost = async (moment) => {
  const lines = linesFor(moment);
  const salt = moment.kind === "find" ? moment.find.targetId : "";
  return lines[fnv1a(`${moment.kind}:${moment.roundId}:${salt}`) % lines.length]!;
};

/**
 * Extension point for an LLM taunt host, chosen by the TAUNT_HOST Worker variable, unset by default. An LLM host
 * would write taunts as a durable pi-durable task so they survive eviction, and it chooses words only: it never draws
 * and never places targets.
 */
export function selectTauntHost(env: { readonly TAUNT_HOST?: string }): TauntHost {
  if (env.TAUNT_HOST === undefined || env.TAUNT_HOST === "") return bundledTaunts;
  throw new Error(`TAUNT_HOST=${env.TAUNT_HOST} names an LLM taunt host, and none is implemented yet`);
}
