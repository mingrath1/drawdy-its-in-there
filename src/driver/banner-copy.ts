// The competitive lines on the banner, in Thai and English. The banner renders these and the driver's
// tests look for them, so the wording lives in one place.

import { displayName } from "../shared/standings.ts";

/** A rival found the target you just circled. */
export const gotFirstLine = (name: string) => `${displayName(name)} เจอก่อน · ${displayName(name)} got it first`;

/** The headline when one player found the most. */
export const winLine = (name: string, self: boolean) =>
    self ? "🏆 คุณชนะรอบนี้! · You win the round!" : `🏆 ${displayName(name)} ชนะรอบนี้! · ${displayName(name)} wins the round!`;

/** The headline when two or more players share the most finds. */
export const TIE_LINE = "🤝 เสมอ! · It's a tie!";

/** Every scoreboard row's finds, best first: "3–1". */
export const scoreLine = (score: number[]) => score.join("–");

/** A scoreboard row's name: short, with a crown on the sole leader. */
export const rowName = (name: string, leader: boolean) => `${leader ? "👑 " : ""}${displayName(name)}`;

/** Rounds a player has won in this room, shown only when above zero. */
export const roundsWonLine = (roundsWon: number) => `🏆 ${roundsWon}`;
