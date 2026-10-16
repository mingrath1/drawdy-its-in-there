// The whole driver against a fake Drawdy: the real hunt orchestration, LocalHost, placement,
// judge, and rendering, with only Drawdy's host replaced.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { DriverManifest, ModuleStyling } from "@drawdy/driver-protocol";
import { activate } from "../src/index.ts";
import { createSend } from "../src/driver/command.ts";
import { createHuntDriver } from "../src/driver/hunt.ts";
import { NEXT_BUTTON_ID, STOP_BUTTON_ID } from "../src/driver/banner.ts";
import { parseFrameMeta, roundDurationMs, targetCount } from "../src/shared/protocol.ts";
import { FakeDrawdy } from "./fake-drawdy.ts";

const ACTION = "iit:action";
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

type Point = [number, number];

function scribbleBoard(drawdy: FakeDrawdy) {
    for (let i = 0; i < 40; i++) {
        const x = 150 + (i % 8) * 160;
        const y = 150 + Math.floor(i / 8) * 150;
        const points: Point[] = Array.from({ length: 30 }, (_, k) => [x + k * 4, y + (k % 2 === 0 ? 0 : 90)]);
        drawdy.add({ id: `ink-${i}`, type: "freedraw", x, y, width: 120, height: 90, points, strokeColor: "#e4e4e7", strokeWidth: 2 });
    }
}

/** Each preview batch is one target. Its centre and size come from the drawn line points. */
function drawnTargets(drawdy: FakeDrawdy) {
    return [...drawdy.previews.values()].map((batch) => {
        const points: Point[] = batch.flatMap((e) => [e.from, e.to, ...(e.bend ?? [])]);
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const w = Math.max(...xs) - minX;
        const h = Math.max(...ys) - minY;
        return { cx: minX + w / 2, cy: minY + h / 2, w, h, batch, points };
    });
}

function loopAround(t: { cx: number; cy: number; w: number; h: number }): Point[] {
    const r = 0.55 * Math.hypot(t.w, t.h);
    return Array.from({ length: 33 }, (_, i): Point => [t.cx + r * Math.cos((i / 32) * 2 * Math.PI), t.cy + r * Math.sin((i / 32) * 2 * Math.PI)]);
}

const markers = (drawdy: FakeDrawdy) => [...drawdy.elements.values()].filter((e) => e.meta?.iitFound);
const frames = (drawdy: FakeDrawdy) => [...drawdy.elements.values()].filter((e) => e.type === "frame");
const bannerTexts = (drawdy: FakeDrawdy): string[] => {
    const out: string[] = [];
    const walk = (n: any) => {
        if (n.type === "text") out.push(n.child);
        for (const c of n.children ?? []) walk(c);
    };
    const banner = drawdy.floating.get("iit:banner");
    if (banner) walk(banner.schema);
    return out;
};

function lcg(seed: number) {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };
}

function setup() {
    const drawdy = new FakeDrawdy();
    const driver = createHuntDriver({ send: createSend(drawdy.issue, "mingrath1.its-in-there"), generateId: drawdy.generateId, styling: STYLING });
    const onEvent = driver.handleEvent;
    const flush = async () => {
        for (let i = 0, stable = 0; i < 200 && stable < 3; i++) {
            const before = drawdy.commands.length;
            await driver.settled();
            await new Promise((resolve) => setImmediate(resolve));
            stable = drawdy.commands.length === before ? stable + 1 : 0;
        }
    };
    return { drawdy, driver, onEvent, flush };
}

describe("driver", () => {
    let warnings: unknown[][];
    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
        mock.method(console, "log", () => {});
        warnings = [];
        mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
        mock.method(Math, "random", lcg(7));
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it("issues only the ungated action button and its click subscription on activation", async () => {
        const drawdy = new FakeDrawdy();
        const manifest = { driverId: "mingrath1.its-in-there" } as DriverManifest;
        await activate({ issueCommand: drawdy.issue, manifest, styling: STYLING, generateId: drawdy.generateId });
        assert.deepEqual(drawdy.typesIssued(), ["command:dom:create-action-button", "subscription:dom:element-clicked"]);
        assert.equal(drawdy.commands[1].req.domElementId, ACTION);
    });

    it("plays a full round, a harder round that times out, and leaves a trophy", async () => {
        const { drawdy, driver, onEvent, flush } = setup();
        scribbleBoard(drawdy);
        await driver.activate();

        onEvent({ type: "subscription:dom:element-clicked", subscriptionId: "x", body: { domElementId: ACTION, clientX: 0, clientY: 0 } });
        await flush();

        const [frame] = frames(drawdy);
        assert.equal(frames(drawdy).length, 1);
        assert.equal(frame.name, "It's In There!");
        assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [100, 100, 1400, 800]);
        const meta = parseFrameMeta(frame.meta);
        assert.ok(meta, "frame meta validates");
        assert.equal(meta.backendUrl, null);
        assert.match(meta.joinToken, /^[0-9a-f]{64}$/);

        let targets = drawnTargets(drawdy);
        assert.equal(targets.length, targetCount(1));
        assert.ok(targets.every((t) => t.batch.every((e: any) => e.type === "line")));
        for (const t of targets) {
            assert.ok(t.cx > frame.x && t.cx < frame.x + frame.width && t.cy > frame.y && t.cy < frame.y + frame.height);
        }
        assert.equal(drawdy.tool, "laser-pointer");
        assert.equal(drawdy.floating.get("iit:banner").asPopover, false);
        assert.ok(bannerTexts(drawdy).includes("หาของที่ซ่อนอยู่ 3 ชิ้น · Find 3 hidden things"));

        const strokes: Point[][] = [loopAround(targets[0])];
        drawdy.emit(onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers: strokes });
        await flush();
        assert.equal(markers(drawdy).length, 1);
        const [marker] = markers(drawdy);
        assert.match(marker.meta.iitFound, /^(.+):\1:0$/, "tag is <roundId>:<targetId>");
        assert.equal(marker.frameId, frame.id);
        assert.equal(marker.strokeColor, "#ff4d4d");
        assert.ok(marker.localAnimation, "marker pops");
        assert.ok(drawnTargets(drawdy)[0].batch.every((e: any) => e.strokeColor === "#ff4d4d"), "found target takes the finder's colour");
        mock.timers.tick(1_200);
        await flush();
        assert.equal(marker.localAnimation, null, "pop is cleared after it plays");

        strokes.push(loopAround({ cx: 800, cy: 500, w: 1400, h: 800 }));
        drawdy.emit(onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers: strokes });
        drawdy.emit(onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers: [] });
        await flush();
        assert.equal(markers(drawdy).length, 1, "a re-sent stroke and a whole-board circle find nothing");

        drawdy.emit(onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers: [loopAround(targets[1]), loopAround(targets[2])] });
        await flush();
        assert.equal(markers(drawdy).length, 3);
        assert.equal(drawdy.tool, "pencil", "the previous tool is back");
        assert.deepEqual(drawdy.kv.get("local-difficulty"), { difficulty: 2 });
        assert.ok(bannerTexts(drawdy).includes("รอบต่อไป (ยากขึ้น) · Next round (harder)"));
        assert.equal(drawdy.floating.get("iit:banner").schema.styles.pointerEvents, "auto");

        drawdy.click(onEvent, NEXT_BUTTON_ID);
        await flush();
        targets = drawnTargets(drawdy);
        assert.equal(targets.length, targetCount(2), "old targets removed, new round drawn");
        assert.equal(drawdy.tool, "laser-pointer");

        mock.timers.tick(roundDurationMs(2));
        await flush();
        assert.equal(drawdy.tool, "pencil");
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "missed targets turn red");
        mock.timers.tick(3_000);
        await flush();
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "and stay red after the flash");
        assert.deepEqual(drawdy.kv.get("local-difficulty"), { difficulty: 2 }, "time-up keeps the difficulty");
        assert.ok(bannerTexts(drawdy).includes("รอบต่อไป · Next round"));

        drawdy.click(onEvent, STOP_BUTTON_ID);
        await flush();
        assert.equal(drawdy.previews.size, 0);
        assert.equal(drawdy.floating.size, 0);
        assert.ok(![...drawdy.subscriptions.values()].some((s) => s.type === "subscription:tool:laser"));
        assert.equal(frames(drawdy).length, 1, "the frame stays as a trophy");
        assert.equal(markers(drawdy).length, 3, "and so do the markers");
        assert.deepEqual(warnings, []);

        drawdy.selection = [frame.id];
        drawdy.click(onEvent, ACTION);
        await flush();
        assert.equal(frames(drawdy).length, 1, "clicking with the hunt frame selected rejoins its room");
        assert.equal(drawnTargets(drawdy).length, targetCount(2));
        assert.ok(bannerTexts(drawdy).some((t) => t.includes("Lv 2")));
    });

    it("draws and judges targets where the frame is now when it moved after planting", async () => {
        const run = async (move: boolean) => {
            mock.method(Math, "random", lcg(11));
            const { drawdy, driver, onEvent, flush } = setup();
            scribbleBoard(drawdy);
            drawdy.afterCommand = (request) => {
                if (move && request.type === "command:scene:query-rect" && request.req.properties.includes("points")) {
                    const frame = frames(drawdy)[0];
                    frame.x += 120;
                    frame.y += 60;
                    drawdy.afterCommand = () => {};
                }
            };
            await driver.activate();
            drawdy.click(onEvent, ACTION);
            await flush();
            return { drawdy, onEvent, flush, targets: drawnTargets(drawdy) };
        };
        const still = await run(false);
        const moved = await run(true);
        assert.equal(moved.targets.length, still.targets.length);
        moved.targets.forEach((t, i) => {
            t.points.forEach((p, j) => {
                assert.ok(Math.abs(p[0] - (still.targets[i].points[j][0] + 120)) < 1e-6);
                assert.ok(Math.abs(p[1] - (still.targets[i].points[j][1] + 60)) < 1e-6);
            });
        });
        moved.drawdy.emit(moved.onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers: [loopAround(moved.targets[0])] });
        await moved.flush();
        assert.equal(markers(moved.drawdy).length, 1);
    });

    it("does nothing more when the scene permission is denied", async () => {
        const { drawdy, driver, onEvent, flush } = setup();
        drawdy.denied.add("command:scene:get-current-selected-drawdy-elements");
        await driver.activate();
        drawdy.click(onEvent, ACTION);
        await flush();
        assert.deepEqual(drawdy.typesIssued().slice(2), ["command:scene:get-current-selected-drawdy-elements"]);
        assert.equal(warnings.length, 1);
    });
});
