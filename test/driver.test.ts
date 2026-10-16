// The whole driver against a fake Drawdy: the real hunt orchestration, LocalHost, placement,
// judge, and rendering, with only Drawdy's host replaced.

import assert from "node:assert/strict";
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
    const failures: ((request: any) => boolean)[] = [];
    const issue = (async (request: any) => {
        const i = failures.findIndex((match) => match(request));
        if (i < 0) return drawdy.issue(request);
        failures.splice(i, 1);
        drawdy.commands.push(request);
        return { ...request, res: { error: { type: "bad-argument", message: "injected failure" } } };
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
    const failOnce = (match: (request: any) => boolean) => failures.push(match);
    return { drawdy, driver, onEvent, flush, failOnce };
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
        snapshot(current: unknown, options: { revision?: number; difficulty?: number } = {}) {
            socket.deliver({
                v: 1,
                type: "snapshot",
                revision: options.revision ?? ++revision,
                serverNow: Date.now(),
                self: "u-ana",
                room: { roomId: "room-remote", difficulty: options.difficulty ?? difficulty, nextDifficulty: options.difficulty ?? difficulty, league: [], current, next: null, roundsPlayed: 4 },
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
        assert.equal(
            drawdy.kv.get("local-difficulty"),
            undefined,
            "the driver saves room.difficulty, which stays at the last round's level 1; it should save room.nextDifficulty (2)"
        );
        assert.ok(bannerTexts(drawdy).includes("เจอครบ! · All found!"));
        assert.ok(
            bannerTexts(drawdy).includes("รอบต่อไป · Next round (Lv 1)"),
            "the driver labels the next round with room.difficulty; it should show room.nextDifficulty (Lv 2)"
        );
        assert.equal(drawdy.floating.get("iit:banner").schema.styles.pointerEvents, "auto");

        drawdy.click(onEvent, NEXT_BUTTON_ID);
        await flush();
        targets = drawnTargets(drawdy);
        assert.equal(targets.length, targetCount(2), "old targets removed, the pre-planted level 2 round drawn");
        assert.equal(drawdy.tool, "laser-pointer");
        assert.deepEqual(drawdy.kv.get("local-difficulty"), { difficulty: 2 });

        mock.timers.tick(roundDurationMs(2));
        await flush();
        assert.equal(drawdy.tool, "pencil");
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "missed targets turn red");
        mock.timers.tick(3_000);
        await flush();
        assert.ok(drawnTargets(drawdy).every((t) => t.batch.every((e: any) => e.strokeColor === "#ef4444")), "and stay red after the flash");
        assert.deepEqual(drawdy.kv.get("local-difficulty"), { difficulty: 2 });
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
        assert.equal(drawnTargets(drawdy).length, targetCount(2), "the room resumes at its level");
        assert.deepEqual(drawdy.kv.get("local-difficulty"), { difficulty: 2 });
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
        await t.flush();
        assert.deepEqual(markers(drawdy).map((m) => m.meta.iitFound), ["round-9:t1"]);
        assert.equal(markers(drawdy)[0].frameId, "hunt-1");

        drawdy.add({ id: "other-tab-marker", type: "path", x: 800, y: 300, width: 100, height: 100, meta: { iitFound: "round-9:t2" } });
        strokes.push(circleTarget(2));
        laser(t, strokes);
        await t.flush();
        assert.equal(room.answer("ok"), "t2");
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
});
