// Who is ahead in a round, worked out from its finds alone. The room uses it to award rounds and to
// pick taunts, and the driver uses it to draw the scoreboard, so both sides agree on the leader.

import type { Find, PlayerId } from "./hunt.ts";

export type Standing = { playerId: PlayerId; name: string; color: string; finds: number };

/** Best first. `leader` is set only when one player is strictly ahead. */
export type Standings = { rows: Standing[]; leader: PlayerId | null };

export type RoundOutcome =
    | { kind: "win"; winners: Standing[]; rows: Standing[] }
    | { kind: "tie"; winners: Standing[]; rows: Standing[] }
    | { kind: "none"; winners: []; rows: Standing[] };

/** The lead after a find, compared with before it: taken from someone, levelled into a tie, or unchanged. */
export type LeadChange = "takes-lead" | "ties" | null;

/** A name short enough for the 360 px banner and a taunt line. Presence names can run to 128 characters. */
export function displayName(name: string, max = 16): string {
    const chars = [...name.trim()];
    if (chars.length === 0) return "?";
    return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** Sorted by finds, then by who reached that count first. A player's latest name and colour win. */
export function roundStandings(finds: readonly Find[]): Standings {
    const byPlayer = new Map<PlayerId, Standing & { reachedAt: number }>();
    for (const find of [...finds].sort((a, b) => a.at - b.at)) {
        const row = byPlayer.get(find.playerId);
        if (row) Object.assign(row, { name: find.playerName, color: find.playerColor, finds: row.finds + 1, reachedAt: find.at });
        else byPlayer.set(find.playerId, { playerId: find.playerId, name: find.playerName, color: find.playerColor, finds: 1, reachedAt: find.at });
    }
    const sorted = [...byPlayer.values()].sort((a, b) => b.finds - a.finds || a.reachedAt - b.reachedAt);
    const rows = sorted.map(({ reachedAt: _reachedAt, ...row }) => row);
    const [first, second] = rows;
    return { rows, leader: first && (second === undefined || first.finds > second.finds) ? first.playerId : null };
}

/** Everyone tied for the most finds wins. A round nobody scored in has no winner. */
export function roundOutcome(finds: readonly Find[]): RoundOutcome {
    const { rows } = roundStandings(finds);
    const best = rows[0]?.finds ?? 0;
    if (best === 0) return { kind: "none", winners: [], rows };
    const winners = rows.filter((r) => r.finds === best);
    return { kind: winners.length === 1 ? "win" : "tie", winners, rows };
}

/** What the newest find did to the lead. Only a change involving the finder counts. */
export function leadChange(before: readonly Find[], after: readonly Find[]): LeadChange {
    const finder = [...after].sort((a, b) => a.at - b.at).at(-1)?.playerId;
    if (finder === undefined || after.length <= before.length) return null;
    const was = roundStandings(before), now = roundStandings(after);
    if (now.leader === finder && was.leader !== finder && now.rows.length > 1) return "takes-lead";
    if (now.leader === null && was.leader !== null && was.leader !== finder) return "ties";
    return null;
}
