import type {
  BoardSnapshot,
  Find,
  LeagueEntry,
  PlantRequest,
  PlayerId,
  Rect,
  Room,
  Round,
  RoundStatus,
  Target,
} from "../../src/shared/hunt.ts";
import { plant } from "./placement.ts";

export type Player = { id: PlayerId; name: string; color: string };

export type LiveRound = Extract<Round, { status: "live" }>;
export type EndedRound = Extract<Round, { status: "ended" }>;

export const ROUND_MS = 90_000;
export const MAX_DIFFICULTY = 5;

export const targetCount = (difficulty: number): number => 2 + difficulty;

/** What the driver read from the board when someone pressed Hunt. */
export type RoundSetup = { board: BoardSnapshot; stampIds: string[] };

/** Ids, seeds and the clock: what starting a round needs that a pure function cannot invent. */
export type RoundSeeds = {
  now: number;
  current: { id: string; seed: number };
  next: { id: string; seed: number };
};

export type StartStep =
  | { kind: "started"; room: Room; round: LiveRound; plantNext: PlantRequest }
  | { kind: "round-live" }
  | { kind: "no-targets" };

export type StartResult = { kind: "started"; roundId: string } | { kind: "round-live" } | { kind: "no-targets" };

export type ClaimResult =
  | { kind: "found"; find: Find }
  | { kind: "taken"; find: Find }
  | { kind: "not-live" }
  | { kind: "unknown-target" };

export type ClaimStep = { room: Room; result: ClaimResult; ended: EndedRound | null };

/** What players may see: the next round's targets stay hidden until it starts. */
export type RoomView = Omit<Room, "next"> & {
  next: { id: string; status: Exclude<RoundStatus, "live" | "ended"> } | null;
};

export function newRoom(roomId: string): Room {
  return { roomId, difficulty: 1, league: [], current: null, next: null, roundsPlayed: 0 };
}

const nextDifficulty = (difficulty: number): number => Math.min(MAX_DIFFICULTY, difficulty + 1);

const plantRequest = (
  setup: RoundSetup,
  round: { id: string; seed: number },
  difficulty: number,
): PlantRequest => ({
  roundId: round.id,
  seed: round.seed,
  difficulty,
  count: targetCount(difficulty),
  board: setup.board,
  stampIds: setup.stampIds,
});

const sameRect = (left: Rect, right: Rect): boolean =>
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;

/**
 * Plays the pre-planted next round when it is ready for this frame, else plants one now. Either way the round after
 * it starts planting at once, one step harder, on the assumption that this one gets cleared.
 */
export function startRound(room: Room, setup: RoundSetup, seeds: RoundSeeds): StartStep {
  if (room.current?.status === "live") return { kind: "round-live" };
  const { frameRect } = setup.board;
  const ready =
    room.next?.status === "ready" && sameRect(room.next.frameRect, frameRect) ? room.next : null;
  const id = ready?.id ?? seeds.current.id;
  const targets: Target[] =
    ready?.targets ?? plant(plantRequest(setup, seeds.current, room.difficulty));
  if (targets.length === 0) return { kind: "no-targets" };
  const round: LiveRound = {
    status: "live",
    id,
    frameRect,
    targets,
    startedAt: seeds.now,
    endsAt: seeds.now + ROUND_MS,
    finds: [],
  };
  return {
    kind: "started",
    round,
    room: { ...room, current: round, next: { status: "planting", id: seeds.next.id, frameRect } },
    plantNext: plantRequest(setup, seeds.next, nextDifficulty(room.difficulty)),
  };
}

/** Fills the next slot when its planting finishes. A planting the room has since dropped changes nothing. */
export function readyNext(room: Room, roundId: string, targets: Target[]): Room {
  const next = room.next;
  if (next?.status !== "planting" || next.id !== roundId) return room;
  return { ...room, next: { status: "ready", id: next.id, frameRect: next.frameRect, targets } };
}

export function claimFind(
  room: Room,
  claim: { roundId: string; targetId: string; player: Player },
  now: number,
): ClaimStep {
  const round = room.current;
  if (round?.status !== "live" || round.id !== claim.roundId) {
    return { room, result: { kind: "not-live" }, ended: null };
  }
  if (now >= round.endsAt) {
    const { room: settled, ended } = endRound(room, round, "time-up", round.endsAt);
    return { room: settled, result: { kind: "not-live" }, ended };
  }
  if (!round.targets.some((target) => target.id === claim.targetId)) {
    return { room, result: { kind: "unknown-target" }, ended: null };
  }
  const taken = round.finds.find((find) => find.targetId === claim.targetId);
  if (taken !== undefined) return { room, result: { kind: "taken", find: taken }, ended: null };

  const find: Find = {
    targetId: claim.targetId,
    playerId: claim.player.id,
    playerName: claim.player.name,
    playerColor: claim.player.color,
    at: now,
  };
  const updated: LiveRound = { ...round, finds: [...round.finds, find] };
  if (updated.finds.length < updated.targets.length) {
    return { room: { ...room, current: updated }, result: { kind: "found", find }, ended: null };
  }
  const { room: settled, ended } = endRound(room, updated, "all-found", now);
  return { room: settled, result: { kind: "found", find }, ended };
}

/** Ends the live round once its clock has run out. Null when there is nothing to end yet. */
export function endDueRound(room: Room, now: number): { room: Room; ended: EndedRound } | null {
  const round = room.current;
  if (round?.status !== "live" || now < round.endsAt) return null;
  return endRound(room, round, "time-up", round.endsAt);
}

/** When the room next needs waking: the live round's deadline. */
export function roundDeadline(room: Room): number | undefined {
  return room.current?.status === "live" ? room.current.endsAt : undefined;
}

function endRound(
  room: Room,
  round: LiveRound,
  reason: "all-found" | "time-up",
  endedAt: number,
): { room: Room; ended: EndedRound } {
  const ended: EndedRound = {
    status: "ended",
    id: round.id,
    frameRect: round.frameRect,
    targets: round.targets,
    startedAt: round.startedAt,
    endedAt,
    finds: round.finds,
    reason,
  };
  const difficulty = Math.max(
    1,
    Math.min(MAX_DIFFICULTY, room.difficulty + difficultyStep(ended)),
  );
  // The next round was planted for nextDifficulty(room.difficulty); keep it only if that is still the plan.
  const next = difficulty === nextDifficulty(room.difficulty) ? room.next : null;
  return {
    ended,
    room: {
      ...room,
      current: ended,
      next,
      difficulty,
      league: tallyLeague(room.league, ended.finds),
      roundsPlayed: room.roundsPlayed + 1,
    },
  };
}

function difficultyStep(round: EndedRound): number {
  if (round.reason === "all-found") return 1;
  return round.finds.length * 2 < round.targets.length ? -1 : 0;
}

/** Adds a round's finds to the league. Everyone tied for the most finds wins the round. */
function tallyLeague(league: LeagueEntry[], finds: Find[]): LeagueEntry[] {
  const perPlayer = new Map<PlayerId, { name: string; count: number }>();
  for (const find of finds) {
    const count = (perPlayer.get(find.playerId)?.count ?? 0) + 1;
    perPlayer.set(find.playerId, { name: find.playerName, count });
  }
  const best = Math.max(0, ...[...perPlayer.values()].map(({ count }) => count));
  const entries = new Map(league.map((entry) => [entry.playerId, entry]));
  for (const [playerId, { name, count }] of perPlayer) {
    const previous = entries.get(playerId);
    entries.set(playerId, {
      playerId,
      playerName: name,
      finds: (previous?.finds ?? 0) + count,
      roundsWon: (previous?.roundsWon ?? 0) + (count === best ? 1 : 0),
    });
  }
  return [...entries.values()];
}

export function roomView(room: Room): RoomView {
  return { ...room, next: room.next === null ? null : viewNext(room.next) };
}

function viewNext(next: Round): RoomView["next"] {
  switch (next.status) {
    case "planting":
    case "ready":
      return { id: next.id, status: next.status };
    case "live":
    case "ended":
      return null;
  }
}
