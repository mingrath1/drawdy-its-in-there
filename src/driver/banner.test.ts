import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DomElementSchema, ModuleStyling } from "@drawdy/driver-protocol";
import { bannerSchema, NEXT_BUTTON_ID, STOP_BUTTON_ID } from "./banner.ts";
import type { BannerModel, ScoreRow } from "./banner.ts";
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
const LIVE = models[3] as Extract<BannerModel, { phase: "live" }>;
const ENDED = models[4] as Extract<BannerModel, { phase: "ended" }>;
const FIVE: ScoreRow[] = ["Ana", "Ben", "Cy", "Dee", "Eve"].map((name, i) => ({
    name,
    color: "#e11d48",
    finds: 5 - i,
    roundsWon: 0,
    leader: i === 0,
    self: i === 0,
}));

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
const nodes = (schema: DomElementSchema) => {
    const out: DomElementSchema[] = [];
    walk(schema, (n) => out.push(n));
    return out;
};
/** The nodes from the root down to the text node that reads `label`, both ends included. */
function pathTo(node: DomElementSchema, label: string): DomElementSchema[] | null {
    if (node.type === "text" && node.child === label) return [node];
    const children = "children" in node ? (node.children ?? []) : [];
    for (const child of children) {
        const path = pathTo(child, label);
        if (path) return [node, ...path];
    }
    return null;
}
/** One style of a node. Text-only keys such as color are not typed on every node, so this reads any key. */
const styleOf = (n: DomElementSchema | undefined, key: string) => (n?.styles as Record<string, unknown> | undefined)?.[key];
/** The scoreboard's swatches: the boxes that have a width. */
const swatchColors = (schema: DomElementSchema) =>
    nodes(schema)
        .filter((n) => n.type === "box" && n.styles?.width !== undefined)
        .map((n) => n.styles?.backgroundColor);

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
        for (const line of ["👑 Ana", "3", "🏆 2", "Ben", "1"]) assert.ok(all.includes(line), line);
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

describe("the competitive lines, each one whole text node", () => {
    it("names the winner or the tie with the score, and the rival who got there first", () => {
        const ended = models[4] as Extract<BannerModel, { phase: "ended" }>;
        const win = texts(bannerSchema({ ...ended, verdict: { kind: "win", name: "Ben", color: "#2563eb", self: false, score: [3, 1] } }, STYLING));
        assert.ok(win.includes("🏆 Ben ชนะรอบนี้! · Ben wins the round!") && win.includes("3–1"));
        const tie = texts(bannerSchema({ ...ended, verdict: { kind: "tie", score: [2, 2] } }, STYLING));
        assert.ok(tie.includes("🤝 เสมอ! · It's a tie!") && tie.includes("2–2"));
        const live = texts(bannerSchema({ ...models[3], gotFirst: { name: "Ben", color: "#2563eb" } }, STYLING));
        assert.ok(live.includes("Ben เจอก่อน · Ben got it first"));
    });

    it("leaves the scoreboard out with one player", () => {
        const solo = texts(bannerSchema({ ...models[3], scoreboard: base.scoreboard.slice(0, 1) }, STYLING));
        assert.ok(!solo.includes("👑 Ana"));
    });
});

describe("the scoreboard", () => {
    it("shows with two or more rows in the idle, hiding, live and ended phases, and nowhere else", () => {
        const shown: BannerModel[] = [{ ...base, phase: "idle", frameProblem: false }, { ...base, phase: "hiding" }, LIVE, ENDED];
        for (const model of shown) assert.ok(texts(bannerSchema(model, STYLING)).includes("Ben"), model.phase);
        const hidden: BannerModel[] = [{ ...base, phase: "connecting" }, { ...base, phase: "full" }];
        for (const model of hidden) assert.ok(!texts(bannerSchema(model, STYLING)).includes("Ben"), model.phase);
    });

    it("is absent with no rows or one", () => {
        for (const scoreboard of [[], base.scoreboard.slice(0, 1)]) {
            const all = texts(bannerSchema({ ...LIVE, scoreboard }, STYLING));
            assert.ok(!all.includes("👑 Ana") && !all.includes("3"), `${scoreboard.length} rows`);
        }
    });

    it("crowns only the leader row", () => {
        const crowned = (scoreboard: ScoreRow[]) => texts(bannerSchema({ ...LIVE, scoreboard }, STYLING)).filter((t) => t.startsWith("👑"));
        assert.deepEqual(crowned(base.scoreboard), ["👑 Ana"]);
        assert.deepEqual(crowned(base.scoreboard.map((r) => ({ ...r, leader: r.name === "Ben" }))), ["👑 Ben"]);
        assert.deepEqual(crowned(base.scoreboard.map((r) => ({ ...r, leader: false }))), []);
    });

    it("shows rounds won only above zero", () => {
        const won = texts(bannerSchema(ENDED, STYLING)).filter((t) => t.startsWith("🏆"));
        assert.deepEqual(won, ["🏆 2"]);
    });

    it("draws at most four rows, in the order sent, and counts the rest", () => {
        const all = texts(bannerSchema({ ...LIVE, scoreboard: FIVE }, STYLING));
        assert.ok(all.includes("Dee") && !all.includes("Eve"));
        assert.ok(all.indexOf("👑 Ana") < all.indexOf("Ben") && all.indexOf("Ben") < all.indexOf("Cy"));
        assert.ok(all.includes("+1"));
    });

    it("sits directly under the header, before the goal", () => {
        const all = texts(bannerSchema(LIVE, STYLING));
        assert.equal(all[0], "It's In There!");
        assert.ok(all.indexOf("👑 Ana") < all.indexOf("หาของที่ซ่อนอยู่ 2 ชิ้น · Find 2 hidden things"));
    });

    it("fills each swatch with the row's colour, or the surface when the colour is blank", () => {
        assert.deepEqual(swatchColors(bannerSchema(LIVE, STYLING)), ["#e11d48", "#2563eb"]);
        const blank = base.scoreboard.map((r) => ({ ...r, color: "" }));
        assert.deepEqual(swatchColors(bannerSchema({ ...LIVE, scoreboard: blank }, STYLING)), [STYLING.surface2, STYLING.surface2]);
    });

    it("highlights the self row only", () => {
        const self = base.scoreboard.map((r) => ({ ...r, self: r.name === "Ben" }));
        const schema = bannerSchema({ ...LIVE, scoreboard: self }, STYLING);
        assert.ok(pathTo(schema, "Ben")!.some((n) => n.styles?.backgroundColor === STYLING.surface2));
        assert.ok(!pathTo(schema, "👑 Ana")!.some((n) => n.styles?.backgroundColor === STYLING.surface2));
    });

    it("sets each row's finds big and bold", () => {
        const finds = nodes(bannerSchema(LIVE, STYLING)).find((n) => n.type === "text" && n.child === "3");
        assert.deepEqual(styleOf(finds, "fontSize"), [16, "px"]);
        assert.equal(styleOf(finds, "fontWeight"), "bold");
    });
});

describe("the winner card", () => {
    it("puts a self win's headline and score on a card in the winner's colour", () => {
        const schema = bannerSchema({ ...ENDED, verdict: { kind: "win", name: "Ana", color: "#e11d48", self: true, score: [3, 1] } }, STYLING);
        const path = pathTo(schema, "🏆 คุณชนะรอบนี้! · You win the round!")!;
        assert.equal(path.at(-2)?.styles?.backgroundColor, "#e11d48");
        assert.equal(styleOf(path.at(-1), "color"), "#ffffff");
        assert.deepEqual(texts(path.at(-2)!), ["🏆 คุณชนะรอบนี้! · You win the round!", "3–1"]);
    });

    it("puts a tie's headline and score on a neutral card", () => {
        const schema = bannerSchema({ ...ENDED, verdict: { kind: "tie", score: [2, 2] } }, STYLING);
        const card = pathTo(schema, "🤝 เสมอ! · It's a tie!")!.at(-2)!;
        assert.equal(card.styles?.backgroundColor, STYLING.surface2);
        assert.deepEqual(texts(card), ["🤝 เสมอ! · It's a tie!", "2–2"]);
    });

    it("keeps the plain headline with no score line", () => {
        const all = texts(bannerSchema({ ...ENDED, verdict: { kind: "plain" } }, STYLING));
        assert.ok(all.includes("เจอครบ! · All found!"));
        assert.ok(!all.includes("3–1"));
    });

    it("falls back to the surface and foreground text when the winner has no colour", () => {
        const schema = bannerSchema({ ...ENDED, verdict: { kind: "win", name: "Ben", color: "", self: false, score: [3, 1] } }, STYLING);
        const path = pathTo(schema, "🏆 Ben ชนะรอบนี้! · Ben wins the round!")!;
        assert.equal(path.at(-2)?.styles?.backgroundColor, STYLING.surface2);
        assert.equal(styleOf(path.at(-1), "color"), STYLING.foreground);
    });
});

describe("the got-first line", () => {
    const GOT = "Ben เจอก่อน · Ben got it first";

    it("sits under the found count in a box in the rival's colour, in live and ended", () => {
        const live = bannerSchema({ ...LIVE, gotFirst: { name: "Ben", color: "#2563eb" } }, STYLING);
        const ended = bannerSchema({ ...ENDED, gotFirst: { name: "Ben", color: "#2563eb" } }, STYLING);
        const after = (all: string[], label: string) => all[all.indexOf(label) + 1];
        assert.equal(after(texts(live), "เจอแล้ว 1/2 · Found 1/2"), GOT);
        assert.equal(after(texts(ended), "เจอ 1/2 · Found 1/2"), GOT);
        for (const schema of [live, ended]) {
            const path = pathTo(schema, GOT)!;
            assert.equal(path.at(-2)?.styles?.backgroundColor, "#2563eb");
            assert.equal(styleOf(path.at(-1), "color"), "#ffffff");
            assert.equal(styleOf(path.at(-1), "fontWeight"), "semibold");
        }
    });

    it("is absent when nobody got there first", () => {
        for (const model of [LIVE, ENDED]) assert.ok(!texts(bannerSchema(model, STYLING)).some((t) => t.includes("got it first")), model.phase);
    });

    it("falls back to the surface and foreground text when the rival has no colour", () => {
        const path = pathTo(bannerSchema({ ...LIVE, gotFirst: { name: "Ben", color: "" } }, STYLING), GOT)!;
        assert.equal(path.at(-2)?.styles?.backgroundColor, STYLING.surface2);
        assert.equal(styleOf(path.at(-1), "color"), STYLING.foreground);
    });
});

describe("the competitive additions", () => {
    it("renders a schema Drawdy accepts for every competitive variant", () => {
        const variants: BannerModel[] = [
            { ...LIVE, scoreboard: FIVE, gotFirst: { name: "Ben", color: "#2563eb" } },
            { ...LIVE, scoreboard: base.scoreboard.map((r) => ({ ...r, color: "" })), gotFirst: { name: "Ben", color: "" } },
            { ...ENDED, verdict: { kind: "win", name: "Ana", color: "#e11d48", self: true, score: [3, 1] } },
            { ...ENDED, verdict: { kind: "win", name: "Ben", color: "", self: false, score: [3, 1] }, scoreboard: FIVE },
            { ...ENDED, verdict: { kind: "tie", score: [2, 2] }, gotFirst: { name: "Ben", color: "#2563eb" } },
            { ...base, phase: "idle", frameProblem: true },
            { ...base, phase: "hiding" },
        ];
        for (const model of variants) assert.deepEqual(domSchemaProblems(bannerSchema(model, STYLING)), [], model.phase);
    });

    it("adds no pointer events while live beyond the leave button", () => {
        const schema = bannerSchema({ ...LIVE, scoreboard: FIVE, gotFirst: { name: "Ben", color: "#2563eb" } }, STYLING);
        assert.equal(schema.styles?.pointerEvents, "none");
        assert.deepEqual(nodes(schema).filter((n) => n.styles?.pointerEvents === "auto").map((n) => n.domId), [STOP_BUTTON_ID]);
    });
});
