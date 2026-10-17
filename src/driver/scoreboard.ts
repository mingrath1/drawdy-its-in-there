// The banner's scoreboard and its verdict on a round that ended, from the room's league, the board's
// presence, and the round's finds.

import type { Find, LeagueEntry, PlayerId } from "../shared/hunt.ts";
import type { Player } from "../shared/protocol.ts";
import type { EndReason } from "../shared/round.ts";
import { roundOutcome, roundStandings } from "../shared/standings.ts";
import type { RoundVerdict, ScoreRow } from "./banner.ts";

/**
 * Us, every league player on the board now, and everyone who found something this round. Scorers come
 * first in round order, then the rest by rounds won and name. Without presence, only us and the scorers.
 */
export function scoreRows(self: PlayerId, league: readonly LeagueEntry[], presence: readonly Player[] | null, finds: readonly Find[]): ScoreRow[] {
    const { rows: standings, leader } = roundStandings(finds);
    const entries = new Map(league.map((e) => [e.playerId, e]));
    const onBoard = new Map((presence ?? []).map((p) => [p.playerId, p]));
    const scored = new Map(standings.map((s) => [s.playerId, s]));
    const row = (playerId: PlayerId): ScoreRow => {
        const entry = entries.get(playerId);
        const here = onBoard.get(playerId);
        const standing = scored.get(playerId);
        return {
            name: entry?.playerName || here?.name || standing?.name || "",
            color: here?.color || standing?.color || "",
            finds: standing?.finds ?? 0,
            roundsWon: entry?.roundsWon ?? 0,
            leader: playerId === leader,
            self: playerId === self,
        };
    };
    const unscored = new Set([self, ...league.filter((e) => onBoard.has(e.playerId)).map((e) => e.playerId)].filter((id) => !scored.has(id)));
    const others = [...unscored].map(row).sort((a, b) => b.roundsWon - a.roundsWon || a.name.localeCompare(b.name));
    return [...standings.map((s) => row(s.playerId)), ...others];
}

/**
 * Judged as the room judges who won the round, and named as the scoreboard names them. `rows` are this
 * round's, so their finds already run best first. Alone on the board, the plain headline stays.
 */
export function roundVerdict(reason: EndReason, finds: readonly Find[], rows: readonly ScoreRow[]): RoundVerdict {
    if (reason === "cancelled" || rows.length < 2) return { kind: "plain" };
    const outcome = roundOutcome(finds);
    const score = rows.map((r) => r.finds);
    // A sole winner is strictly ahead, so it is the row with the crown.
    const winner = rows.find((r) => r.leader);
    if (outcome.kind === "win" && winner) return { kind: "win", name: winner.name, color: winner.color, self: winner.self, score };
    if (outcome.kind === "tie") return { kind: "tie", score };
    return { kind: "plain" };
}
