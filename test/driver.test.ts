// The whole driver against a fake Drawdy: the real hunt orchestration, LocalHost, placement,
// judge, and rendering, with only Drawdy's host replaced.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { DriverCommandIssuer, DriverManifest, ModuleStyling } from "@drawdy/driver-protocol";
import { activate } from "../src/index.ts";
import { createSend } from "../src/driver/command.ts";
import { ACTION_BUTTON_ID as ACTION, createHuntDriver } from "../src/driver/hunt.ts";
import { NEXT_BUTTON_ID, STOP_BUTTON_ID } from "../src/driver/banner.ts";
import { parseFrameMeta, roundDurationMs, targetCount } from "../src/shared/protocol.ts";
import { FakeDrawdy } from "./fake-drawdy.ts";
import { FakeSocket } from "./fake-socket.ts";

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

function setup(drawdy = new FakeDrawdy()) {
    const overrides: { match: (request: any) => boolean; answer: (request: any) => Promise<any> }[] = [];
    const issue = (async (request: any) => {
        const i = overrides.findIndex((o) => o.match(request));
        if (i < 0) return drawdy.issue(request);
        const [{ answer }] = overrides.splice(i, 1);
        return answer(request);
    }) as unknown as DriverCommandIssuer;
    const driver = createHuntDriver({ send: createSend(issue, "mingrath1.its-in-there"), generateId: drawdy.generateId, styling: STYLING });
    const onEvent = driver.handleEvent;
    const flush = async () => {
        for (let i = 0, stable = 0; i < 200 && stable < 3; i++) {
            const before = drawdy.commands.length;
            await driver.settled();
            await new Promise((resolve) => setImmediate(resolve));
            stable = drawdy.commands.length === before ? stable + 1 : 0;
        }
    };
    /** The next command that matches fails, as when Drawdy answers with an error. */
    const failOnce = (match: (request: any) => boolean) =>
        overrides.push({
            match,
            answer: async (request) => {
                drawdy.commands.push(request);
                return { ...request, res: { error: { type: "bad-argument", message: "injected failure" } } };
            },
        });
    /** The next command that matches runs, and its answer is rewritten. */
    const rewriteOnce = (match: (request: any) => boolean, rewrite: (value: any) => unknown) =>
        overrides.push({
            match,
            answer: async (request) => {
                const response = (await drawdy.issue(request)) as any;
                return { ...response, res: { value: rewrite(response.res.value) } };
            },
        });
    return { drawdy, driver, onEvent, flush, failOnce, rewriteOnce };
}

/** Turns the event loop without waiting on the driver's queue, for when the queue itself may be stuck. */
async function pump(until: () => boolean = () => false, turns = 200) {
    for (let i = 0; i < turns && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
}

const sockets: FakeSocket[] = [];
const HUNT_FRAME = { x: 200, y: 100, width: 1000, height: 700 };
const REMOTE_META = { v: 1, roomId: "room-remote", joinToken: "ab".repeat(32), backendUrl: "https://iit.example.workers.dev" };
const remoteTarget = (i: number, stampId = "cat-face") => ({
    id: `t${i}`,
    stampId,
    rect: { x: 300 + i * 250, y: 300, width: 80, height: 80 },
    rotationDeg: 0,
    strokeColor: "#e4e4e7",
    strokeWidth: 2,
});
const circleTarget = (i: number, dx = 0, dy = 0) => loopAround({ cx: 340 + i * 250 + dx, cy: 340 + dy, w: 80, h: 80 });
const MISS: Point[] = loopAround({ cx: 1100, cy: 700, w: 40, h: 40 });
const live = (id = "round-9", targets = [0, 1, 2].map((i) => remoteTarget(i)), finds: unknown[] = []) => ({
    status: "live",
    id,
    frameRect: HUNT_FRAME,
    targets,
    startedAt: Date.now(),
    endsAt: Date.now() + 60_000,
    finds,
});
const ended = (round: ReturnType<typeof live>, reason: string, finds: unknown[] = round.finds) => {
    const { endsAt: _endsAt, ...rest } = round;
    return { ...rest, status: "ended", endedAt: Date.now(), reason, finds };
};
const findBy = (i: number, playerId = "u-ana", playerName = "Ana", playerColor = "#ff4d4d") => ({
    targetId: `t${i}`,
    playerId,
    playerName,
    playerColor,
    at: Date.now(),
});

/** Joins the remote room behind the hunt frame and delivers its first snapshot. */
async function joinRemote(t: ReturnType<typeof setup>, first: unknown, difficulty = 3) {
    if (!t.drawdy.elements.has("hunt-1")) t.drawdy.add({ id: "hunt-1", type: "frame", ...HUNT_FRAME, meta: { iit: REMOTE_META } });
    await t.driver.activate();
    const before = sockets.length;
    t.drawdy.click(t.onEvent, ACTION);
    await pump(() => sockets.length > before);
    const socket = sockets[sockets.length - 1];
    socket.accept();
    let revision = 0;
    const room = {
        socket,
        snapshot(current: unknown, options: { revision?: number; difficulty?: number; nextDifficulty?: number } = {}) {
            socket.deliver({
                v: 1,
                type: "snapshot",
                revision: options.revision ?? ++revision,
                serverNow: Date.now(),
                self: "u-ana",
                room: { roomId: "room-remote", difficulty: options.difficulty ?? difficulty, nextDifficulty: options.nextDifficulty ?? options.difficulty ?? difficulty, league: [], current, next: null, roundsPlayed: 4 },
                taunt: "go",
            });
        },
        sent: (type: string) => socket.sent.filter((m: any) => m.type === type) as any[],
        /** Answers the latest find.claim and returns its target id. */
        answer(code: string) {
            const claim = room.sent("find.claim").at(-1);
            assert.ok(claim, "a find.claim was sent");
            socket.deliver({ v: 1, type: "result", requestId: claim.requestId, command: "find.claim", code, revision });
            return claim.targetId as string;
        },
    };
    room.snapshot(first);
    await t.flush();
    return room;
}

const laser = (t: ReturnType<typeof setup>, lasers: Point[][]) => t.drawdy.emit(t.onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers });

describe("driver", () => {
    let warnings: unknown[][];
    const realWebSocket = globalThis.WebSocket;
    beforeEach(() => {
        sockets.length = 0;
        globalThis.WebSocket = class extends FakeSocket {
            constructor(url: string) {
                super(url);
                sockets.push(this);
            }
        } as unknown as typeof WebSocket;
        mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
        mock.method(console, "log", () => {});
        warnings = [];
        mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
        mock.method(Math, "random", lcg(7));
    });
    afterEach(() => {
        globalThis.WebSocket = realWebSocket;
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
        assert.ok(bannerTexts(drawdy).includes("เจอครบ! · All found!"));
        assert.ok(bannerTexts(drawdy).includes("รอบต่อไป · Next round (Lv 2)"), "all found raises the level");
        assert.equal(drawdy.floating.get("iit:banner").schema.styles.pointerEvents, "auto");

        drawdy.click(onEvent, NEXT_BUTTON_ID);
        await flush();
        targets = drawnTargets(drawdy);
        assert.equal(targets.length, targetCount(2), "old targets removed, the pre-planted level 2 round drawn");
        assert.equal(drawdy.tool, "laser-pointer");

        mock.timers.tick(roundDurationMs(2));
        await flush();
        assert.equal(drawdy.tool, "pencil");
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "missed targets turn red");
        mock.timers.tick(3_000);
        await flush();
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "and stay red after the flash");
        assert.ok(bannerTexts(drawdy).includes("หมดเวลา! · Time's up!"));
        assert.ok(bannerTexts(drawdy).includes("รอบต่อไป · Next round (Lv 2)"), "time-up keeps the level");

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
        assert.equal(drawnTargets(drawdy).length, targetCount(2), "the room resumes at the level its label promised");
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

    it("joins a remote room from its frame and marks only finds the room confirmed, once", async () => {
        const t = setup();
        const { drawdy } = t;
        const room = await joinRemote(t, live());
        assert.equal(frames(drawdy).length, 1, "no new frame: the one in view is joined");
        assert.equal(room.socket.url, "wss://iit.example.workers.dev/rooms/room-remote");
        assert.deepEqual(room.socket.sent[0], {
            v: 1,
            type: "hello",
            roomId: "room-remote",
            joinToken: REMOTE_META.joinToken,
            player: { playerId: "u-ana", name: "Ana", color: "#ff4d4d" },
        });
        assert.equal(drawnTargets(drawdy).length, 3);
        assert.equal(drawdy.tool, "laser-pointer");
        assert.equal(room.socket.sent.length, 1, "a live room gets no round.start");

        const strokes = [circleTarget(0)];
        laser(t, strokes);
        await t.flush();
        assert.equal(room.answer("taken"), "t0");
        room.snapshot(live("round-9", undefined, [findBy(0, "u-ben", "Ben", "#22c55e")]));
        await t.flush();
        assert.equal(markers(drawdy).length, 0, "a lost claim writes no marker");
        assert.ok(drawnTargets(drawdy)[0].batch.every((e: any) => e.strokeColor === "#22c55e"), "Ben's find shows in Ben's colour");

        strokes.push(circleTarget(1));
        laser(t, strokes);
        await t.flush();
        assert.equal(room.answer("ok"), "t1");
        room.snapshot(live("round-9", undefined, [findBy(0, "u-ben", "Ben", "#22c55e"), findBy(1)]));
        await t.flush();
        assert.deepEqual(markers(drawdy).map((m) => m.meta.iitFound), ["round-9:t1"]);
        assert.equal(markers(drawdy)[0].frameId, "hunt-1");

        drawdy.add({ id: "other-tab-marker", type: "path", x: 800, y: 300, width: 100, height: 100, meta: { iitFound: "round-9:t2" } });
        strokes.push(circleTarget(2));
        laser(t, strokes);
        await t.flush();
        assert.equal(room.answer("ok"), "t2");
        room.snapshot(live("round-9", undefined, [findBy(0, "u-ben", "Ben", "#22c55e"), findBy(1), findBy(2)]));
        await t.flush();
        assert.equal(markers(drawdy).filter((m) => m.meta.iitFound === "round-9:t2").length, 1, "an existing tag is not written twice");

        room.snapshot(ended(live(), "all-found", [findBy(0, "u-ben", "Ben", "#22c55e"), findBy(1), findBy(2)]));
        await t.flush();
        assert.equal(drawdy.tool, "pencil");
        assert.ok(bannerTexts(drawdy).includes("เจอครบ! · All found!"));

        room.snapshot(live(), { revision: 1 });
        await t.flush();
        assert.equal(drawdy.tool, "pencil", "a stale snapshot is ignored");
        assert.ok(bannerTexts(drawdy).includes("เจอครบ! · All found!"));
        assert.deepEqual(warnings, []);
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

    it("leaves the hunt when setup fails after it began, so the next click starts over", async () => {
        const t = setup();
        scribbleBoard(t.drawdy);
        await t.driver.activate();
        t.failOnce((r) => r.type === "command:dom:upsert-floating-element");
        t.drawdy.click(t.onEvent, ACTION);
        await t.flush();
        assert.equal(t.drawdy.floating.size, 0);
        assert.ok(![...t.drawdy.subscriptions.values()].some((s) => s.type === "subscription:tool:laser"), "its subscriptions are gone");

        t.drawdy.click(t.onEvent, ACTION);
        await t.flush();
        assert.equal(frames(t.drawdy).length, 1, "the second click joins the frame the first one made");
        assert.equal(drawnTargets(t.drawdy).length, targetCount(1));
        assert.ok(bannerTexts(t.drawdy).includes("หาของที่ซ่อนอยู่ 3 ชิ้น · Find 3 hidden things"));
    });

    it("leaves at once from the connecting banner and closes the room socket", async () => {
        const t = setup();
        t.drawdy.add({ id: "hunt-1", type: "frame", ...HUNT_FRAME, meta: { iit: REMOTE_META } });
        await t.driver.activate();
        t.drawdy.click(t.onEvent, ACTION);
        await pump(() => sockets.length > 0);
        await pump(() => t.drawdy.floating.size > 0);
        assert.ok(bannerTexts(t.drawdy).includes("กำลังเชื่อมต่อ… · Connecting…"));

        t.drawdy.click(t.onEvent, STOP_BUTTON_ID);
        await pump(() => t.drawdy.floating.size === 0);
        assert.equal(t.drawdy.floating.size, 0, "the banner is gone");
        assert.equal(sockets[0].readyState, 3, "the socket is closed");
        mock.timers.tick(60_000);
        assert.equal(sockets.length, 1, "nothing redials");
    });

    it("never judges a stroke from an earlier round again", async () => {
        const t = setup();
        const room = await joinRemote(t, live("round-1", [remoteTarget(0)]));
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.equal(room.answer("ok"), "t0");
        room.snapshot(ended(live("round-1", [remoteTarget(0)]), "all-found", [findBy(0)]));
        room.snapshot(live("round-2", [remoteTarget(0)]));
        await t.flush();
        laser(t, [circleTarget(0), MISS]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 1, "the stroke still fading from round 1 claims nothing in round 2");
    });

    it("never judges a stroke drawn while the round was still hiding", async () => {
        const t = setup();
        const room = await joinRemote(t, { status: "planting", id: "round-1", frameRect: HUNT_FRAME });
        laser(t, [circleTarget(1)]);
        await t.flush();
        room.snapshot(live("round-1"));
        await t.flush();
        laser(t, [circleTarget(1), MISS]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0);
        laser(t, [circleTarget(1), MISS, circleTarget(2)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t2"]);
    });

    it("judges a new stroke when an older one faded out of the same event", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        laser(t, [MISS, circleTarget(0)]);
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(1)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0", "t1"]);
        laser(t, []);
        laser(t, [circleTarget(2)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0", "t1", "t2"], "after the trail fades every stroke is new");
    });

    it("never judges a stroke that was already fading when Hunt was clicked", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        laser(t, [circleTarget(0), MISS]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0, "only the stroke that fired the event is new");
        laser(t, [circleTarget(0), MISS, circleTarget(1)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t1"]);
    });

    it("skips a target whose stamp this driver lacks, and never claims it", async () => {
        const t = setup();
        const room = await joinRemote(t, live("round-9", [remoteTarget(0), remoteTarget(1, "no-such-stamp"), remoteTarget(2)]));
        assert.equal(drawnTargets(t.drawdy).length, 2, "only the stamps it has are drawn");
        assert.ok(warnings.some((w) => w.join(" ").includes("no-such-stamp")), "the skip is logged");
        laser(t, [circleTarget(1)]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0);
    });

    it("moves targets, judging, and markers with the hunt frame during a live round", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const before = drawnTargets(t.drawdy);
        const frame = t.drawdy.elements.get("hunt-1")!;
        frame.x += 150;
        frame.y += 80;
        mock.timers.tick(1_000);
        await t.flush();
        drawnTargets(t.drawdy).forEach((d, i) => {
            assert.ok(Math.abs(d.cx - before[i].cx - 150) < 1e-6 && Math.abs(d.cy - before[i].cy - 80) < 1e-6, "previews follow within a tick");
        });

        frame.x += 50;
        laser(t, [circleTarget(0, 200, 80)]);
        await t.flush();
        assert.equal(room.answer("ok"), "t0", "a stroke around where the target is now finds it");
        room.snapshot(live("round-9", undefined, [findBy(0)]));
        await t.flush();
        const [marker] = markers(t.drawdy);
        assert.ok(marker, "the marker is written");
        assert.deepEqual([marker.x + marker.width / 2, marker.y + marker.height / 2], [340 + 200, 340 + 80], "around the target where it is now");

        t.drawdy.elements.delete("hunt-1");
        laser(t, [circleTarget(1, 200, 80)]);
        await t.flush();
        assert.equal(room.answer("ok"), "t1");
        room.snapshot(live("round-9", undefined, [findBy(0), findBy(1)]));
        await t.flush();
        assert.equal(markers(t.drawdy).length, 1, "no marker once the frame is gone");
    });

    it("never claims a target whose preview failed, and draws it on the next snapshot", async () => {
        const t = setup();
        t.failOnce((r) => r.type === "command:scene:create-drawdy-preview-elements");
        const room = await joinRemote(t, live());
        assert.equal(drawnTargets(t.drawdy).length, 2);
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0, "an undrawn target cannot be claimed");
        room.snapshot(live());
        await t.flush();
        assert.equal(drawnTargets(t.drawdy).length, 3, "the next snapshot draws it");
        laser(t, [circleTarget(0), circleTarget(0, 1)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"]);
    });

    it("deletes a partly drawn target batch and redraws it on the next snapshot", async () => {
        const t = setup();
        t.rewriteOnce((r) => r.type === "command:scene:create-drawdy-preview-elements", (value) => ({ ...value, previewed: 1 }));
        const room = await joinRemote(t, live());
        assert.equal(drawnTargets(t.drawdy).length, 2, "the partial batch is gone");
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0);
        room.snapshot(live());
        await t.flush();
        assert.equal(drawnTargets(t.drawdy).length, 3);
        laser(t, [circleTarget(0), circleTarget(0, 1)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"]);
    });

    it("writes a marker whose write failed on the next snapshot", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        laser(t, [circleTarget(0)]);
        await t.flush();
        t.failOnce((r) => r.type === "command:scene:add-drawdy-elements");
        room.answer("ok");
        room.snapshot(live("round-9", undefined, [findBy(0)]));
        await t.flush();
        assert.equal(markers(t.drawdy).length, 0);
        room.snapshot(live("round-9", undefined, [findBy(0)]));
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-9:t0"]);
    });

    it("writes our missing markers when it joins a round, as after a reload", async () => {
        const t = setup();
        const finds = [findBy(1), findBy(2, "u-ben", "Ben", "#22c55e")];
        const room = await joinRemote(t, live("round-9", undefined, finds));
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-9:t1"], "only our own find is marked");
        room.snapshot(ended(live("round-9", undefined, finds), "time-up"));
        await t.flush();
        assert.equal(markers(t.drawdy).length, 1, "and only once");
    });

    it("still writes a missing marker from the last ended round after the next one starts", async () => {
        const t = setup();
        t.failOnce((r) => r.type === "command:scene:add-drawdy-elements");
        const room = await joinRemote(t, ended(live("round-1"), "time-up", [findBy(0)]));
        assert.equal(markers(t.drawdy).length, 0);
        room.snapshot({ status: "planting", id: "round-2", frameRect: HUNT_FRAME });
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-1:t0"]);
    });

    it("reveals and shows the ended banner when restoring the tool fails, and restores it at the next chance", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        assert.equal(t.drawdy.tool, "laser-pointer");
        t.failOnce((r) => r.type === "command:tools:set-active" && r.req.toolId === "pencil");
        room.snapshot(ended(live(), "time-up"));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("หมดเวลา! · Time's up!"), "the ended banner renders");
        assert.ok(drawnTargets(t.drawdy).every((d) => d.batch.every((e: any) => e.strokeColor === "#ef4444")), "missed targets turn red");
        assert.equal(t.drawdy.tool, "laser-pointer");
        t.drawdy.click(t.onEvent, STOP_BUTTON_ID);
        await t.flush();
        assert.equal(t.drawdy.tool, "pencil", "Stop restores the tool");
    });

    it("restores the tool and stops the countdown when a live round is replaced without ending", async () => {
        const t = setup();
        const room = await joinRemote(t, live("round-1"));
        assert.equal(t.drawdy.tool, "laser-pointer");
        room.snapshot({ status: "planting", id: "round-2", frameRect: HUNT_FRAME });
        await t.flush();
        assert.equal(t.drawdy.tool, "pencil");
        assert.equal(t.drawdy.previews.size, 0);
        const upserts = () => t.drawdy.commands.filter((c) => c.type === "command:dom:upsert-floating-element").length;
        const before = upserts();
        mock.timers.tick(5_000);
        await t.flush();
        assert.equal(upserts(), before, "the countdown stopped");
    });

    it("sends one round.start however often Start is clicked while it is pending", async () => {
        const t = setup();
        const room = await joinRemote(t, null);
        assert.equal(room.sent("round.start").length, 1, "an idle room gets a round.start on joining");
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 1, "extra clicks are ignored while it is pending");
        const [start] = room.sent("round.start");
        room.socket.deliver({ v: 1, type: "result", requestId: start.requestId, command: "round.start", code: "busy", revision: 1 });
        await t.flush();
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 2, "its answer frees Start again");
        room.snapshot({ status: "planting", id: "round-1", frameRect: HUNT_FRAME });
        room.snapshot(ended(live("round-1"), "time-up"));
        await t.flush();
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 3, "so does a snapshot showing the round it started");
    });

    it("plays without ever asking for storage", async () => {
        const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
        assert.deepEqual(manifest.permissions, ["dom", "scene", "collaboration"]);
        const t = setup();
        scribbleBoard(t.drawdy);
        await t.driver.activate();
        t.drawdy.click(t.onEvent, ACTION);
        await t.flush();
        const targets = drawnTargets(t.drawdy);
        assert.equal(targets.length, targetCount(1), "a local room starts at level 1");
        for (let i = 1; i <= targets.length; i++) {
            laser(t, targets.slice(0, i).map(loopAround));
            await t.flush();
        }
        assert.ok(bannerTexts(t.drawdy).includes("เจอครบ! · All found!"));
        assert.deepEqual(t.drawdy.typesIssued().filter((type) => type.includes("storage")), []);
    });

    it("labels the next round with the level the room names for it, not the level just played", async () => {
        const t = setup();
        const room = await joinRemote(t, live("round-1"), 3);
        const all = [findBy(0, "u-ben"), findBy(1, "u-ben"), findBy(2, "u-ben")];
        room.snapshot(ended(live("round-1"), "all-found", all), { difficulty: 3, nextDifficulty: 4 });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("รอบต่อไป · Next round (Lv 4)"));
        room.snapshot(null, { difficulty: 1, nextDifficulty: 3 });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("เริ่ม · Start (Lv 3)"), "a level chosen before the first round");
    });
});
