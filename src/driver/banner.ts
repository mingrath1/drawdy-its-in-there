// The floating banner: goal, countdown, finds, and the host's taunt, in Thai and English.

import type { DomElementSchema, ModuleStyling } from "@drawdy/driver-protocol";
import type { EndReason } from "../shared/round.ts";

export const BANNER_ID = "iit:banner";
export const NEXT_BUTTON_ID = "iit:next";
export const STOP_BUTTON_ID = "iit:stop";
export const BANNER_WIDTH = 360;
/** Below Drawdy's top-centre toolbar. */
export const BANNER_TOP = 72;

type BannerTarget = { label: string; labelTh?: string; foundColor: string | null };

/** `nextLevel` is the room's nextDifficulty: the level the next round plays at. */
export type BannerModel = { nextLevel: number; league: { name: string; finds: number }[] } & (
    | { phase: "connecting" }
    | { phase: "idle" }
    | { phase: "hiding" }
    | { phase: "live"; secondsLeft: number; targets: BannerTarget[]; taunt: string | null }
    | { phase: "ended"; reason: EndReason; targets: BannerTarget[]; taunt: string | null }
    | { phase: "full" }
);

const px = (n: number): [number, "px"] => [n, "px"];

export function bannerSchema(model: BannerModel, styling: ModuleStyling): DomElementSchema {
    const text = (child: string, size: number, color: string, fontWeight: "normal" | "medium" | "semibold" | "bold" = "normal"): DomElementSchema => ({
        type: "text",
        child,
        styles: { fontSize: px(size), color, fontWeight },
    });
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
            body.push(targetGrid(model.targets, styling, text));
            body.push(text(`เจอแล้ว ${found}/${total} · Found ${found}/${total}`, 12, styling.foreground, "medium"));
            if (model.taunt) body.push(text(model.taunt, 12, styling.mutedForeground));
            break;
        }
        case "ended": {
            interactive = true;
            const total = model.targets.length;
            const found = model.targets.filter((t) => t.foundColor).length;
            const title =
                model.reason === "all-found" ? "เจอครบ! · All found!" : model.reason === "time-up" ? "หมดเวลา! · Time's up!" : "จบรอบ · Round over";
            body.push(text(title, 15, styling.foreground, "bold"));
            body.push(targetGrid(model.targets, styling, text));
            body.push(text(`เจอ ${found}/${total} · Found ${found}/${total}`, 12, styling.foreground, "medium"));
            if (model.taunt) body.push(text(model.taunt, 12, styling.mutedForeground));
            const next = `รอบต่อไป · Next round (Lv ${model.nextLevel})`;
            body.push(row([button(NEXT_BUTTON_ID, next, true), button(STOP_BUTTON_ID, "พอแล้ว · Stop", false)], 8));
            break;
        }
    }
    if (model.league.length > 1) {
        body.push(text(model.league.map((e) => `${e.name} ${e.finds}`).join(" · "), 11, styling.mutedForeground));
    }

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
            ...body,
        ],
    };
}

function targetGrid(
    targets: BannerTarget[],
    styling: ModuleStyling,
    text: (child: string, size: number, color: string, weight?: "normal" | "medium" | "semibold" | "bold") => DomElementSchema
): DomElementSchema {
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

function row(children: DomElementSchema[], gap: number): DomElementSchema {
    return { type: "row", styles: { gap, crossAxisAlignment: "center" }, children };
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
