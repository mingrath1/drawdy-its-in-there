// Pure round transitions. Every helper returns a new round or says why it refused.

import type { Find, PlayerId, Rect, Round, RoundStatus, Target } from "./hunt.ts";

type RoundOf<S extends RoundStatus> = Extract<Round, { status: S }>;
export type EndReason = RoundOf<"ended">["reason"];

export type RoundRejection =
    | { kind: "illegal-transition"; from: RoundStatus; to: RoundStatus }
    | { kind: "unknown-target"; targetId: string }
    | { kind: "already-found"; targetId: string; by: PlayerId }
    | { kind: "too-late"; endsAt: number; at: number };

export type RoundResult = { ok: true; round: Round } | { ok: false; rejection: RoundRejection };

export function plantingRound(id: string, frameRect: Rect, level: number): Round {
    return { status: "planting", id, frameRect, level };
}

export function markReady(round: Round, targets: Target[]): RoundResult {
    if (round.status !== "planting") return illegal(round.status, "ready");
    return ok({ status: "ready", id: round.id, frameRect: round.frameRect, level: round.level, targets });
}

export function startRound(round: Round, now: number, durationMs: number): RoundResult {
    if (round.status !== "ready") return illegal(round.status, "live");
    return ok({
        status: "live",
        id: round.id,
        frameRect: round.frameRect,
        targets: round.targets,
        startedAt: now,
        endsAt: now + durationMs,
        finds: [],
    });
}

/** Records a find. Only a live round accepts one, before its deadline, and the first find of a target wins. */
export function claimFind(round: Round, find: Find): RoundResult {
    if (round.status !== "live") return illegal(round.status, "live");
    if (!round.targets.some((t) => t.id === find.targetId)) {
        return { ok: false, rejection: { kind: "unknown-target", targetId: find.targetId } };
    }
    const earlier = round.finds.find((f) => f.targetId === find.targetId);
    if (earlier) {
        return { ok: false, rejection: { kind: "already-found", targetId: find.targetId, by: earlier.playerId } };
    }
    if (find.at >= round.endsAt) {
        return { ok: false, rejection: { kind: "too-late", endsAt: round.endsAt, at: find.at } };
    }
    return ok({ ...round, finds: [...round.finds, find] });
}

export function endRound(round: Round, now: number, reason: EndReason): RoundResult {
    if (round.status === "ended") return illegal(round.status, "ended");
    const base = { status: "ended", id: round.id, frameRect: round.frameRect, endedAt: now, reason } as const;
    switch (round.status) {
        case "planting":
            return ok({ ...base, targets: [], startedAt: now, finds: [] });
        case "ready":
            return ok({ ...base, targets: round.targets, startedAt: now, finds: [] });
        case "live":
            return ok({ ...base, targets: round.targets, startedAt: round.startedAt, finds: round.finds });
    }
}

export function allFound(round: Round): boolean {
    return round.status === "live" && round.finds.length === round.targets.length;
}

function ok(round: Round): RoundResult {
    return { ok: true, round };
}

function illegal(from: RoundStatus, to: RoundStatus): RoundResult {
    return { ok: false, rejection: { kind: "illegal-transition", from, to } };
}
