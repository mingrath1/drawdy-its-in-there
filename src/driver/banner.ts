// The floating banner: goal, countdown, finds, and the host's taunt, in Thai and English.

import type { DomElementSchema, ModuleStyling } from "@drawdy/driver-protocol";
import type { EndReason } from "../shared/round.ts";
import { gotFirstLine, roundsWonLine, rowName, scoreLine, TIE_LINE, winLine } from "./banner-copy.ts";

export const BANNER_ID = "iit:banner";
export const NEXT_BUTTON_ID = "iit:next";
export const STOP_BUTTON_ID = "iit:stop";
export const BANNER_WIDTH = 360;
/** Below Drawdy's top-centre toolbar. */
export const BANNER_TOP = 72;

type BannerTarget = { label: string; labelTh?: string; foundColor: string | null };

/**
 * One player on the scoreboard, best first. `finds` counts this round only; `roundsWon` counts every round in the room.
 * `leader` is true on at most one row, and only when that player is strictly ahead. Names arrive full length.
 */
export type ScoreRow = { name: string; color: string; finds: number; roundsWon: number; leader: boolean; self: boolean };

/** A rival found the target you just circled. The driver clears it after a couple of seconds. */
export type GotFirst = { name: string; color: string };

/** Who won the round that ended. `score` is every scoreboard row's finds, best first. "plain" keeps the old headline. */
export type RoundVerdict =
    | { kind: "win"; name: string; color: string; self: boolean; score: number[] }
    | { kind: "tie"; score: number[] }
    | { kind: "plain" };

/**
 * `nextLevel` is the room's nextDifficulty: the level the next round plays at. `scoreboard` holds every row the
 * driver knows; the banner draws it only with 2 or more rows.
 */
export type BannerModel = { nextLevel: number; scoreboard: ScoreRow[]; gotFirst: GotFirst | null } & (
    | { phase: "connecting" }
    | { phase: "idle"; frameProblem: boolean }
    | { phase: "hiding" }
    | { phase: "live"; secondsLeft: number; targets: BannerTarget[]; taunt: string | null }
    | { phase: "ended"; reason: EndReason; targets: BannerTarget[]; taunt: string | null; frameProblem: boolean; verdict: RoundVerdict }
    | { phase: "full" }
);

const px = (n: number): [number, "px"] => [n, "px"];
const text = (child: string, size: number, color: string, fontWeight: "normal" | "medium" | "semibold" | "bold" = "normal"): DomElementSchema => ({
    type: "text",
    child,
    styles: { fontSize: px(size), color, fontWeight },
});

export function bannerSchema(model: BannerModel, styling: ModuleStyling): DomElementSchema {
    const button = (domId: string, label: string, primary: boolean): DomElementSchema => ({
        type: "button",
        domId,
        styles: {
            backgroundColor: primary ? styling.accent : styling.surface2,
            borderRadius: px(8),
            padding: px(8),
            pointerEvents: "auto",
            cursor: "pointer",
            hover: { backgroundColor: primary ? styling.primary : styling.border },
        },
        children: [text(label, 12, primary ? styling.accentForeground : styling.foreground, "semibold")],
    });
    /** Start sent nothing: the room refuses a frame under 1 unit wide or reaching past 1e7. */
    const frameProblem = (on: boolean) =>
        on ? [text("กรอบเล็กหรือไกลเกินไป · This frame is too small or too far away", 12, styling.destructive, "medium")] : [];
    const smallStop: DomElementSchema = {
        type: "button",
        domId: STOP_BUTTON_ID,
        styles: { borderRadius: px(6), padding: px(4), pointerEvents: "auto", cursor: "pointer", hover: { backgroundColor: styling.surface2 } },
        children: [text("ออก · Leave", 11, styling.mutedForeground, "medium")],
    };

    const header: DomElementSchema[] = [text("It's In There!", 12, styling.mutedForeground, "semibold")];
    const body: DomElementSchema[] = [];
    let interactive = false;

    switch (model.phase) {
        case "connecting":
            header.push(smallStop);
            body.push(text("กำลังเชื่อมต่อ… · Connecting…", 13, styling.foreground, "semibold"));
            break;
        case "full":
            body.push(text("ห้องเต็ม · This room is full", 13, styling.foreground, "semibold"));
            break;
        case "hiding":
            header.push(smallStop);
            body.push(text("กำลังซ่อนของ… · Hiding things…", 13, styling.foreground, "semibold"));
            break;
        case "idle":
            interactive = true;
            body.push(text("ยังไม่มีรอบที่เล่นอยู่ · No round running", 13, styling.foreground, "semibold"));
            body.push(...frameProblem(model.frameProblem));
            body.push(row([button(NEXT_BUTTON_ID, `เริ่ม · Start (Lv ${model.nextLevel})`, true), button(STOP_BUTTON_ID, "พอแล้ว · Stop", false)], 8));
            break;
        case "live": {
            const total = model.targets.length;
            const found = model.targets.filter((t) => t.foundColor).length;
            const urgent = model.secondsLeft <= 10;
            header.push(
                row([text(clock(model.secondsLeft), 16, urgent ? styling.destructive : styling.foreground, "bold"), smallStop], 8)
            );
            body.push(text(`หาของที่ซ่อนอยู่ ${total} ชิ้น · Find ${total} hidden things`, 13, styling.foreground, "semibold"));
            body.push(targetGrid(model.targets, styling));
            body.push(text(`เจอแล้ว ${found}/${total} · Found ${found}/${total}`, 12, styling.foreground, "medium"));
            if (model.gotFirst) body.push(gotFirstBox(model.gotFirst, styling));
            if (model.taunt) body.push(text(model.taunt, 12, styling.mutedForeground));
            break;
        }
        case "ended": {
            interactive = true;
            const total = model.targets.length;
            const found = model.targets.filter((t) => t.foundColor).length;
            const v = model.verdict;
            const title =
                model.reason === "all-found" ? "เจอครบ! · All found!"
                : model.reason === "time-up" ? "หมดเวลา! · Time's up!"
                : "จบรอบ · Round over";
            body.push(v.kind === "plain" ? text(title, 15, styling.foreground, "bold") : verdictCard(v, styling));
            body.push(targetGrid(model.targets, styling));
            body.push(text(`เจอ ${found}/${total} · Found ${found}/${total}`, 12, styling.foreground, "medium"));
            if (model.gotFirst) body.push(gotFirstBox(model.gotFirst, styling));
            if (model.taunt) body.push(text(model.taunt, 12, styling.mutedForeground));
            const next = `รอบต่อไป · Next round (Lv ${model.nextLevel})`;
            body.push(...frameProblem(model.frameProblem));
            body.push(row([button(NEXT_BUTTON_ID, next, true), button(STOP_BUTTON_ID, "พอแล้ว · Stop", false)], 8));
            break;
        }
    }
    // The board is for a round or a hunt in progress, not for a connection or a full room.
    const board = model.phase !== "connecting" && model.phase !== "full" && model.scoreboard.length > 1 ? scoreboard(model.scoreboard, styling) : null;

    return {
        type: "column",
        styles: {
            width: px(BANNER_WIDTH),
            padding: px(12),
            gap: 8,
            backgroundColor: styling.surface,
            borderColor: styling.border,
            borderType: "solid",
            borderWidth: px(1),
            borderRadius: px(12),
            // Click-through while hunting, so the banner never eats a laser stroke.
            pointerEvents: interactive ? "auto" : "none",
        },
        children: [
            { type: "row", styles: { mainAxisAlignment: "between", crossAxisAlignment: "center" }, children: header },
            ...(board ? [board] : []),
            ...body,
        ],
    };
}

function targetGrid(targets: BannerTarget[], styling: ModuleStyling): DomElementSchema {
    return {
        type: "grid",
        styles: { columns: 2, gap: 6 },
        children: targets.map((t) => ({
            type: "box",
            styles: { backgroundColor: t.foundColor ?? styling.surface2, borderRadius: px(6), padding: px(4) },
            children: [
                text(
                    `${t.foundColor ? "✓ " : ""}${t.labelTh ? `${t.labelTh} · ` : ""}${t.label}`,
                    11,
                    t.foundColor ? "#ffffff" : styling.mutedForeground,
                    "medium"
                ),
            ],
        })),
    };
}

/** The most scoreboard rows drawn; the rest are counted in a "+N" line. */
const BOARD_ROWS = 4;

/** A block in a player's colour with white text, or the surface with normal text when the colour is blank. */
function fill(color: string, styling: ModuleStyling): { backgroundColor: string; color: string } {
    return color ? { backgroundColor: color, color: "#ffffff" } : { backgroundColor: styling.surface2, color: styling.foreground };
}

/** The round's winner, or the tie, with the score under the headline. */
function verdictCard(v: Exclude<RoundVerdict, { kind: "plain" }>, styling: ModuleStyling): DomElementSchema {
    const { backgroundColor, color } = v.kind === "win" ? fill(v.color, styling) : fill("", styling);
    const headline = v.kind === "win" ? winLine(v.name, v.self) : TIE_LINE;
    return {
        type: "column",
        styles: { backgroundColor, borderRadius: px(8), padding: px(8), gap: 2 },
        children: [text(headline, 15, color, "bold"), text(scoreLine(v.score), 13, color, "semibold")],
    };
}

function gotFirstBox(rival: GotFirst, styling: ModuleStyling): DomElementSchema {
    const { backgroundColor, color } = fill(rival.color, styling);
    return { type: "box", styles: { backgroundColor, borderRadius: px(6), padding: px(4) }, children: [text(gotFirstLine(rival.name), 12, color, "semibold")] };
}

function scoreboard(rows: ScoreRow[], styling: ModuleStyling): DomElementSchema {
    const shown = rows.slice(0, BOARD_ROWS);
    const more = rows.length - shown.length;
    return {
        type: "column",
        styles: { gap: 4 },
        children: [...shown.map((e) => scoreRow(e, styling)), ...(more > 0 ? [text(`+${more}`, 11, styling.mutedForeground, "medium")] : [])],
    };
}

function scoreRow(e: ScoreRow, styling: ModuleStyling): DomElementSchema {
    const swatch: DomElementSchema = {
        type: "box",
        styles: { width: px(12), height: px(12), borderRadius: px(6), backgroundColor: e.color || styling.surface2 },
    };
    const name = text(rowName(e.name, e.leader), 13, styling.foreground, e.self ? "bold" : "medium");
    const won = e.roundsWon > 0 ? [text(roundsWonLine(e.roundsWon), 11, styling.mutedForeground, "medium")] : [];
    return {
        type: "row",
        styles: {
            mainAxisAlignment: "between",
            crossAxisAlignment: "center",
            backgroundColor: e.self ? styling.surface2 : styling.surface,
            borderRadius: px(6),
            padding: px(4),
        },
        children: [row([swatch, name], 8), row([...won, text(String(e.finds), 16, styling.foreground, "bold")], 8)],
    };
}

function row(children: DomElementSchema[], gap: number): DomElementSchema {
    return { type: "row", styles: { gap, crossAxisAlignment: "center" }, children };
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
