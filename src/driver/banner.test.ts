import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DomElementSchema, ModuleStyling } from "@drawdy/driver-protocol";
import { bannerSchema, NEXT_BUTTON_ID, STOP_BUTTON_ID } from "./banner.ts";
import type { BannerModel } from "./banner.ts";
import { domSchemaProblems } from "./dom-schema.ts";

const STYLING = {
    theme: "dark",
    background: "#09090b",
    foreground: "#fafafa",
    surface: "#18181b",
    surface2: "#27272a",
    mutedForeground: "#a1a1aa",
    primary: "#c5f601",
    primaryForeground: "#000",
    accent: "#c5f601",
    accentForeground: "#000",
    border: "#3f3f46",
    input: "#27272a",
    ring: "#c5f601",
    destructive: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
    radiusSm: "4px",
    radiusMd: "6px",
    radiusLg: "8px",
} satisfies ModuleStyling;

const targets = [
    { label: "cat face", labelTh: "หน้าแมว", foundColor: "#ff4d4d" },
    { label: "229", foundColor: null },
];
const base = {
    nextLevel: 3,
    scoreboard: [
        { name: "Ana", color: "#e11d48", finds: 3, roundsWon: 2, leader: true, self: true },
        { name: "Ben", color: "#2563eb", finds: 1, roundsWon: 0, leader: false, self: false },
    ],
    gotFirst: null,
};
const models: BannerModel[] = [
    { ...base, phase: "connecting" },
    { ...base, phase: "idle", frameProblem: false },
    { ...base, phase: "hiding" },
    { ...base, phase: "live", secondsLeft: 42.2, targets, taunt: "It's in there. Somewhere." },
    { ...base, phase: "ended", reason: "all-found", targets, taunt: null, frameProblem: false, verdict: { kind: "plain" } },
    { ...base, phase: "ended", reason: "time-up", targets, taunt: "หมดเวลา!", frameProblem: true, verdict: { kind: "plain" } },
    { nextLevel: 1, scoreboard: [], gotFirst: null, phase: "full" },
    { ...base, phase: "idle", frameProblem: true },
];

function walk(schema: DomElementSchema, visit: (node: DomElementSchema) => void) {
    visit(schema);
    if ("children" in schema) for (const child of schema.children ?? []) walk(child, visit);
}
const texts = (schema: DomElementSchema) => {
    const out: string[] = [];
    walk(schema, (n) => n.type === "text" && out.push(n.child));
    return out;
};
const buttons = (schema: DomElementSchema) => {
    const out: DomElementSchema[] = [];
    walk(schema, (n) => n.type === "button" && out.push(n));
    return out;
};

describe("bannerSchema", () => {
    it("renders a schema Drawdy accepts in every phase", () => {
        for (const model of models) assert.deepEqual(domSchemaProblems(bannerSchema(model, STYLING)), [], model.phase);
    });

    it("lets laser strokes through while hunting, except on the leave button", () => {
        const live = bannerSchema(models[3], STYLING);
        assert.equal(live.styles?.pointerEvents, "none");
        assert.deepEqual(buttons(live).map((b) => [b.domId, b.styles?.pointerEvents]), [[STOP_BUTTON_ID, "auto"]]);
    });

    it("shows the countdown, the goal in both languages, and the finds", () => {
        const all = texts(bannerSchema(models[3], STYLING));
        assert.ok(all.includes("0:43"));
        assert.ok(all.includes("หาของที่ซ่อนอยู่ 2 ชิ้น · Find 2 hidden things"));
        assert.ok(all.includes("เจอแล้ว 1/2 · Found 1/2"));
        assert.ok(all.includes("✓ หน้าแมว · cat face"));
        assert.ok(all.includes("Ana 3 · Ben 1"));
    });

    it("ends with the outcome and offers the next round at the room's next level", () => {
        const allFound = texts(bannerSchema(models[4], STYLING));
        const timeUp = texts(bannerSchema(models[5], STYLING));
        assert.ok(allFound.includes("เจอครบ! · All found!"));
        assert.ok(timeUp.includes("หมดเวลา! · Time's up!"));
        assert.ok(timeUp.includes("รอบต่อไป · Next round (Lv 3)"));
        assert.deepEqual(buttons(bannerSchema(models[5], STYLING)).map((b) => b.domId), [NEXT_BUTTON_ID, STOP_BUTTON_ID]);
    });
});
