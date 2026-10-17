import type { Find, Room, Round } from "./hunt.ts";
import { displayName, leadChange, type LeadChange, roundOutcome, type RoundOutcome } from "./standings.ts";

export type TauntMoment =
  | { kind: "round-start"; roundId: string }
  | { kind: "find"; roundId: string; find: Find; lead: LeadChange }
  | {
      kind: "round-end";
      roundId: string;
      reason: Extract<Round, { status: "ended" }>["reason"];
      found: number;
      total: number;
      outcome: RoundOutcome;
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
      outcome: roundOutcome(round.finds),
    };
  }
  if (round.status !== "live") return null;
  if (same?.status !== "live") return { kind: "round-start", roundId: round.id };
  const find = round.finds.at(-1);
  if (round.finds.length > same.finds.length && find !== undefined) {
    return { kind: "find", roundId: round.id, find, lead: leadChange(same.finds, round.finds) };
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
  "dead-heat": [
    "เสมอกัน! ตัดสินกันรอบหน้า · Dead heat. Settle it next round.",
    "เท่ากันเป๊ะ! มาเคลียร์รอบหน้า · Dead level. Rematch decides.",
  ],
  "all-found": ["เจอครบทุกตัว! รอบหน้ายากขึ้นนะ", "Clean sweep. The next one is meaner."],
  missed: ["หมดเวลา! ยังซ่อนอยู่อีกหลายตัวเลย", "Time's up. They were right there."],
  cancelled: ["ยกเลิกรอบนี้แล้ว", "Round called off."],
} as const satisfies Record<string, readonly string[]>;

/** Lines that name one player, in Thai and English. Each takes the name after displayName has shortened it. */
const NAMED = {
  "takes-lead": [
    (name: string) => `${name} แซงแล้ว! · ${name} takes the lead!`,
    (name: string) => `${name} ขึ้นนำแล้ว! · ${name} is out front!`,
  ],
  ties: [
    (name: string) => `${name} ตามทันแล้ว! · ${name} ties it up!`,
    (name: string) => `${name} เท่ากันแล้ว! · ${name} is level now!`,
  ],
  rematch: [
    (name: string) => `${name} ขอแก้มือไหม? · Rematch, ${name}?`,
    (name: string) => `${name} ไปต่อไหม? · Go again, ${name}?`,
  ],
} as const satisfies Record<string, readonly ((name: string) => string)[]>;

const named = (lines: readonly ((name: string) => string)[], name: string): readonly string[] =>
  lines.map((line) => line(displayName(name)));

const findLines = (find: Find, lead: LeadChange): readonly string[] => {
  switch (lead) {
    case "takes-lead":
      return named(NAMED["takes-lead"], find.playerName);
    case "ties":
      return named(NAMED.ties, find.playerName);
    case null:
      return LINES.find;
  }
};

const roundEndLines = (moment: Extract<TauntMoment, { kind: "round-end" }>): readonly string[] => {
  const { reason, outcome } = moment;
  const last = outcome.rows.at(-1);
  // A decided round with rivals names the last-place player. Solo, unscored, and cancelled rounds keep the plain lines.
  if (reason !== "cancelled" && last !== undefined && outcome.rows.length >= 2) {
    if (outcome.kind === "win") return named(NAMED.rematch, last.name);
    if (outcome.kind === "tie") return LINES["dead-heat"];
  }
  switch (reason) {
    case "all-found":
      return LINES["all-found"];
    case "time-up":
      return LINES.missed;
    case "cancelled":
      return LINES.cancelled;
  }
};

const linesFor = (moment: TauntMoment): readonly string[] => {
  switch (moment.kind) {
    case "round-start":
      return LINES["round-start"];
    case "find":
      return findLines(moment.find, moment.lead);
    case "round-end":
      return roundEndLines(moment);
  }
};

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
};

export const bundledTaunts: TauntHost = (moment) => {
  const lines = linesFor(moment);
  const salt = moment.kind === "find" ? moment.find.targetId : "";
  return lines[fnv1a(`${moment.kind}:${moment.roundId}:${salt}`) % lines.length]!;
};
