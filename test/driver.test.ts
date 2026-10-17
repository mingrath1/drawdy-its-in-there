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
import { TIE_LINE, gotFirstLine, roundsWonLine, rowName, scoreLine, winLine } from "../src/driver/banner-copy.ts";
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

/** The drawn target that shows `like` whole, moved by (dx, dy), if one does. */
function drawnLike(drawdy: FakeDrawdy, like: ReturnType<typeof drawnTargets>[number], dx = 0, dy = 0) {
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    return drawnTargets(drawdy).find(
        (d) => d.batch.length === like.batch.length && near(d.cx, like.cx + dx) && near(d.cy, like.cy + dy) && near(d.w, like.w) && near(d.h, like.h)
    );
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

function setup(drawdy = new FakeDrawdy(), backendUrl: string | null = null) {
    const overrides: { match: (request: any) => boolean; answer: (request: any) => Promise<any> }[] = [];
    const issue = (async (request: any) => {
        const i = overrides.findIndex((o) => o.match(request));
        if (i < 0) return drawdy.issue(request);
        const [{ answer }] = overrides.splice(i, 1);
        return answer(request);
    }) as unknown as DriverCommandIssuer;
    const driver = createHuntDriver({ send: createSend(issue, "mingrath1.its-in-there"), generateId: drawdy.generateId, styling: STYLING, backendUrl });
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
    /** The next command that matches never reaches the board, and is answered with this value. */
    const answerOnce = (match: (request: any) => boolean, value: unknown) =>
        overrides.push({
            match,
            answer: async (request) => {
                drawdy.commands.push(request);
                return { ...request, res: { value } };
            },
        });
    /** The next command that matches reaches the board with only its first `n` elements, as when Drawdy applies part of it. */
    const truncateOnce = (match: (request: any) => boolean, n: number) =>
        overrides.push({
            match,
            answer: (request) => drawdy.issue({ ...request, req: { ...request.req, elements: request.req.elements.slice(0, n) } }),
        });
    return { drawdy, driver, onEvent, flush, failOnce, rewriteOnce, answerOnce, truncateOnce };
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
async function joinRemote(t: ReturnType<typeof setup>, first: unknown, difficulty = 3, league: unknown[] = []) {
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
        snapshot(current: unknown, options: { revision?: number; difficulty?: number; nextDifficulty?: number; league?: unknown[]; taunt?: string | null } = {}) {
            socket.deliver({
                v: 1,
                type: "snapshot",
                revision: options.revision ?? ++revision,
                serverNow: Date.now(),
                self: "u-ana",
                room: {
                    roomId: "room-remote",
                    difficulty: options.difficulty ?? difficulty,
                    nextDifficulty: options.nextDifficulty ?? options.difficulty ?? difficulty,
                    league: options.league ?? league,
                    current,
                    next: null,
                    roundsPlayed: 4,
                },
                taunt: options.taunt === undefined ? "go" : options.taunt,
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

const FRAME_PROBLEM = "กรอบเล็กหรือไกลเกินไป · This frame is too small or too far away";

const laser = (t: ReturnType<typeof setup>, lasers: Point[][]) => t.drawdy.emit(t.onEvent, "subscription:tool:laser", { type: "laser-state-update", lasers });

const entry = (playerId: string, playerName: string, roundsWon = 0) => ({ playerId, playerName, finds: 0, roundsWon });
const LEAGUE = [entry("u-ana", "Ana", 1), entry("u-ben", "Ben"), entry("u-cat", "Cat", 2), entry("u-eve", "Eve", 3)];
const user = (id: string, name: string, color: string) => ({ id, name, color, isHost: false, isSelf: id === "u-ana", cursorPosition: null });
const ANA = user("u-ana", "Ana", "#ff4d4d");
const BEN = user("u-ben", "Ben", "#16a34a");
const CAT = user("u-cat", "Cat", "#eab308");
const ben = (i: number) => findBy(i, "u-ben", "Ben", "#22c55e");
const cat = (i: number) => findBy(i, "u-cat", "Cat", "#eab308");
const presence = (t: ReturnType<typeof setup>, users: unknown[]) => t.drawdy.emit(t.onEvent, "subscription:collaboration:presence-changed", { users });
const upserts = (drawdy: FakeDrawdy) => drawdy.commands.filter((c) => c.type === "command:dom:upsert-floating-element").length;

/** The scoreboard as drawn: each row's name, then the counts drawn beside it, sorted, whatever their layout. */
function drawnBoard(drawdy: FakeDrawdy) {
    const names = LEAGUE.flatMap((e) => [rowName(e.playerName, false), rowName(e.playerName, true)]);
    const rows: string[][] = [];
    let open = false;
    for (const text of bannerTexts(drawdy)) {
        const name = names.includes(text);
        const count = /^(🏆 )?\d+$/.test(text);
        if (name) rows.push([text]);
        else if (open && count) rows.at(-1)!.push(text);
        open = name || (open && count);
    }
    return rows.map(([name, ...cells]) => [name, ...cells.sort()]);
}

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
        assert.ok(bannerTexts(drawdy).includes(winLine("Ana", true)), "two finds to Ben's one win the round");

        room.snapshot(live(), { revision: 1 });
        await t.flush();
        assert.equal(drawdy.tool, "pencil", "a stale snapshot is ignored");
        assert.ok(bannerTexts(drawdy).includes(winLine("Ana", true)));
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

    it("stores its backend on a new hunt frame and dials that frame's room", async () => {
        const t = setup(new FakeDrawdy(), "https://iit.example.workers.dev");
        scribbleBoard(t.drawdy);
        await t.driver.activate();
        t.drawdy.click(t.onEvent, ACTION);
        await pump(() => sockets.length > 0);
        const [frame] = frames(t.drawdy);
        const meta = parseFrameMeta(frame.meta);
        assert.ok(meta, "frame meta validates");
        assert.equal(meta.backendUrl, "https://iit.example.workers.dev");
        assert.equal(sockets[0].url, `wss://iit.example.workers.dev/rooms/${meta.roomId}`);
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

    it("says the room is full, leaves without redialing, and closes the notice", async () => {
        const t = setup();
        t.drawdy.add({ id: "hunt-1", type: "frame", ...HUNT_FRAME, meta: { iit: REMOTE_META } });
        await t.driver.activate();
        t.drawdy.click(t.onEvent, ACTION);
        await pump(() => sockets.length > 0);
        sockets[0].accept();
        sockets[0].deliver({ v: 1, type: "fault", code: "full", retryAfterMs: 60_000 });
        await t.flush();
        assert.deepEqual(bannerTexts(t.drawdy), ["It's In There!", "ห้องเต็ม · This room is full"]);
        assert.equal(sockets[0].readyState, 3, "the socket is closed");
        assert.deepEqual([...t.drawdy.subscriptions.values()].map((s) => s.req?.domElementId), [ACTION], "only the action button stays subscribed");

        mock.timers.tick(60_000);
        await t.flush();
        assert.equal(sockets.length, 1, "nothing redials");
        assert.equal(t.drawdy.floating.size, 0, "the notice closed itself");
    });

    it("keeps dialing a room that is busy for now, after the wait it names, and plays once it gets in", async () => {
        const t = setup();
        t.drawdy.add({ id: "hunt-1", type: "frame", ...HUNT_FRAME, meta: { iit: REMOTE_META } });
        await t.driver.activate();
        t.drawdy.click(t.onEvent, ACTION);
        await pump(() => sockets.length > 0);
        sockets[0].accept();
        sockets[0].deliver({ v: 1, type: "fault", code: "unavailable", retryAfterMs: 60_000 });
        sockets[0].drop();
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("กำลังเชื่อมต่อ… · Connecting…"), "still connecting");
        assert.ok(!bannerTexts(t.drawdy).includes("ห้องเต็ม · This room is full"), "not full");

        mock.timers.tick(59_999);
        await t.flush();
        assert.equal(sockets.length, 1, "no redial before the room's wait is over");
        mock.timers.tick(1);
        await t.flush();
        assert.equal(sockets.length, 2, "a redial once it is");
        sockets[1].accept();
        sockets[1].deliver({
            v: 1,
            type: "snapshot",
            revision: 1,
            serverNow: Date.now(),
            self: "u-ana",
            room: { roomId: "room-remote", difficulty: 1, nextDifficulty: 1, league: [], current: live(), next: null, roundsPlayed: 0 },
            taunt: null,
        });
        await t.flush();
        assert.equal(drawnTargets(t.drawdy).length, 3);
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
        laser(t, [circleTarget(0, 150, 80)]);
        await t.flush();
        assert.equal(room.answer("ok"), "t0", "a stroke around where the target still shows finds it");
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

    it("judges a target where it is drawn while moving it fails, and moves it on the next tick", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const before = drawnTargets(t.drawdy);
        const t0Line = before[0].batch[0].drawdyElementId;
        const movesT0 = (r: any) => r.type === "command:scene:update-drawdy-preview-elements" && r.req.elements[0].drawdyElementId === t0Line;
        t.failOnce(movesT0);
        t.answerOnce(movesT0, { updated: 0 });
        const frame = t.drawdy.elements.get("hunt-1")!;
        frame.x += 150;
        frame.y += 80;
        mock.timers.tick(1_000);
        await t.flush();
        const after = drawnTargets(t.drawdy);
        assert.deepEqual([after[0].cx, after[0].cy], [before[0].cx, before[0].cy], "t0 failed to move");
        assert.ok(Math.abs(after[1].cx - before[1].cx - 150) < 1e-6, "t1 moved");

        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"], "a circle around t0 where it shows finds it, after a retry that moved no line");

        mock.timers.tick(1_000);
        await t.flush();
        const moved = drawnTargets(t.drawdy)[0];
        assert.ok(Math.abs(moved.cx - before[0].cx - 150) < 1e-6 && Math.abs(moved.cy - before[0].cy - 80) < 1e-6, "the next tick moves it");
    });

    it("judges a stroke where the target showed when it was drawn, even when the move it triggers goes through", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const [t0] = drawnTargets(t.drawdy);
        const t0Line = t0.batch[0].drawdyElementId;
        t.failOnce((r) => r.type === "command:scene:update-drawdy-preview-elements" && r.req.elements[0].drawdyElementId === t0Line);
        const frame = t.drawdy.elements.get("hunt-1")!;
        frame.x += 150;
        frame.y += 80;
        mock.timers.tick(1_000);
        await t.flush();
        assert.ok(drawnLike(t.drawdy, t0), "t0 failed to move");

        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"], "a circle around t0 where it showed finds it");
        assert.ok(drawnLike(t.drawdy, t0, 150, 80), "and the retry the stroke set off moved it");
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

    it("takes down a target that moved only some of its lines, and judges it only once it is drawn whole again", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const [t0] = drawnTargets(t.drawdy);
        const t0Line = t0.batch[0].drawdyElementId;
        t.truncateOnce((r) => r.type === "command:scene:update-drawdy-preview-elements" && r.req.elements[0].drawdyElementId === t0Line, 1);
        t.failOnce((r) => r.type === "command:scene:create-drawdy-preview-elements");
        const frame = t.drawdy.elements.get("hunt-1")!;
        frame.x += 150;
        frame.y += 80;
        mock.timers.tick(1_000);
        await t.flush();
        assert.equal(drawnTargets(t.drawdy).length, 2, "the half-moved target is gone");

        laser(t, [circleTarget(0)]);
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(0, 150, 80)]);
        await t.flush();
        assert.equal(room.sent("find.claim").length, 0, "an undrawn target is not judged where it was or where it goes");

        room.snapshot(live());
        await t.flush();
        assert.ok(drawnLike(t.drawdy, t0, 150, 80), "the next snapshot draws it whole where the frame is now");
        laser(t, [circleTarget(0), circleTarget(0, 150, 80), circleTarget(0, 151, 80)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"]);
    });

    it("draws a found target again, whole in the finder's colour, when its recolour updated only some lines", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const [t0] = drawnTargets(t.drawdy);
        const t0Line = t0.batch[0].drawdyElementId;
        t.truncateOnce((r) => r.type === "command:scene:update-drawdy-preview-elements" && r.req.elements[0].drawdyElementId === t0Line, 1);
        room.snapshot(live("round-9", undefined, [findBy(0, "u-ben", "Ben", "#22c55e")]));
        await t.flush();
        const shown = drawnLike(t.drawdy, t0);
        assert.ok(shown, "t0 shows whole where it was");
        assert.ok(shown.batch.every((e: any) => e.strokeColor === "#22c55e" && e.strokeWidth === 3), "every line in Ben's colour");
    });

    it("recolours a find whose recolour failed when a snapshot repeats, and never reveals it as missed", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        const [t0, t1, t2] = drawnTargets(t.drawdy);
        const recolours = (d: typeof t0) => (r: any) =>
            r.type === "command:scene:update-drawdy-preview-elements" && r.req.elements[0].drawdyElementId === d.batch[0].drawdyElementId;
        const shownIn = (d: typeof t0, color: string) => drawnLike(t.drawdy, d)?.batch.every((e: any) => e.strokeColor === color);
        const ben = (i: number) => findBy(i, "u-ben", "Ben", "#22c55e");

        t.failOnce(recolours(t0));
        room.snapshot(live("round-9", undefined, [ben(0)]), { revision: 2 });
        await t.flush();
        assert.ok(shownIn(t0, "#e4e4e7"), "the recolour failed");
        room.snapshot(live("round-9", undefined, [ben(0)]), { revision: 2 });
        await t.flush();
        assert.ok(shownIn(t0, "#22c55e"), "a reconnect repeating the revision recolours it");

        t.failOnce(recolours(t1));
        t.failOnce(recolours(t1));
        room.snapshot(live("round-9", undefined, [ben(0), ben(1)]), { revision: 3 });
        room.snapshot(ended(live("round-9"), "time-up", [ben(0), ben(1)]), { revision: 4 });
        await t.flush();
        assert.ok(shownIn(t1, "#e4e4e7"), "a find whose recolour failed twice is not revealed as missed");
        assert.ok(shownIn(t2, "#ef4444"), "the missed one is");
        room.snapshot(ended(live("round-9"), "time-up", [ben(0), ben(1)]), { revision: 4 });
        await t.flush();
        assert.ok(shownIn(t1, "#22c55e"), "and the repeated revision recolours it");
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

    it("heals a failed marker and a missing preview when a reconnect repeats the same revision", async () => {
        const t = setup();
        t.failOnce((r) => r.type === "command:scene:create-drawdy-preview-elements");
        const room = await joinRemote(t, live());
        laser(t, [circleTarget(1)]);
        await t.flush();
        room.answer("ok");
        t.failOnce((r) => r.type === "command:scene:create-drawdy-preview-elements");
        t.failOnce((r) => r.type === "command:scene:add-drawdy-elements");
        const final = live("round-9", undefined, [findBy(1)]);
        room.snapshot(final, { revision: 2 });
        await t.flush();
        assert.equal(markers(t.drawdy).length, 0);
        assert.equal(drawnTargets(t.drawdy).length, 2);

        const upserts = () => t.drawdy.commands.filter((c) => c.type === "command:dom:upsert-floating-element").length;
        const before = upserts();
        room.snapshot(final, { revision: 2 });
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-9:t1"], "the marker is written");
        assert.equal(drawnTargets(t.drawdy).length, 3, "the missing target is drawn");
        assert.equal(upserts(), before, "the banner is not redrawn for a revision it has shown");
    });

    it("keeps a taunt through the next snapshot of its round, and drops it after a missed revision unless a new one comes", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        room.snapshot(live("round-9", undefined, [ben(0)]), { revision: 2, taunt: "Ben takes the lead!" });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("Ben takes the lead!"));

        room.snapshot(live("round-9", undefined, [ben(0)]), { revision: 3, taunt: null, league: [entry("u-cat", "Cat")] });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("Ben takes the lead!"), "someone joining the league keeps it");

        room.snapshot(live("round-9", undefined, [ben(0), findBy(1)]), { revision: 5, taunt: "Ana takes the lead!" });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("Ana takes the lead!"), "a missed revision with its own taunt shows it");

        room.snapshot(live("round-9", undefined, [ben(0), findBy(1), ben(2)]), { revision: 7, taunt: null });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("หาของที่ซ่อนอยู่ 3 ชิ้น · Find 3 hidden things"), "the live banner renders");
        assert.ok(!bannerTexts(t.drawdy).includes("Ana takes the lead!"), "a missed revision without one drops the old line");
    });

    it("drops the last round's taunt when the next round comes without one", async () => {
        const t = setup();
        const room = await joinRemote(t, live("round-1"));
        room.snapshot(ended(live("round-1"), "time-up"), { revision: 2, taunt: "Time's up. They were right there." });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("Time's up. They were right there."));

        room.snapshot(live("round-2"), { revision: 3, taunt: null });
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("หาของที่ซ่อนอยู่ 3 ชิ้น · Find 3 hidden things"), "the new round's banner renders");
        assert.ok(!bannerTexts(t.drawdy).includes("Time's up. They were right there."));
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

    it("keeps one marker when two tabs of the same player mark a find at once", async () => {
        const tab1 = setup();
        const board = new FakeDrawdy();
        board.elements = tab1.drawdy.elements;
        let seq = 0;
        board.generateId = () => `tab2-${seq++}`;
        const tab2 = setup(board);
        const room1 = await joinRemote(tab1, live());
        const room2 = await joinRemote(tab2, live());
        room1.snapshot(live("round-9", undefined, [findBy(0)]));
        room2.snapshot(live("round-9", undefined, [findBy(0)]));
        await Promise.all([tab1.flush(), tab2.flush()]);
        const written = [tab1, tab2]
            .flatMap((tab) => tab.drawdy.commands)
            .filter((c) => c.type === "command:scene:add-drawdy-elements" && c.req.elements[0].meta?.iitFound)
            .map((c) => c.req.elements[0].drawdyElementId as string);
        assert.equal(written.length, 2, "both tabs wrote the marker");
        assert.deepEqual(markers(board).map((m) => m.id), [written.sort()[0]], "the smallest id stays");
    });

    it("removes extra copies of one of our markers on the next snapshot, keeping the smallest id", async () => {
        const t = setup();
        for (const id of ["m-2", "m-1", "m-3"]) t.drawdy.add({ id, type: "path", x: 300, y: 300, width: 80, height: 80, meta: { iitFound: "round-9:t0" } });
        await joinRemote(t, live("round-9", undefined, [findBy(0)]));
        assert.deepEqual(markers(t.drawdy).map((m) => m.id), ["m-1"]);
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

    it("says the frame is too small instead of starting, and starts once it is fixed", async () => {
        const t = setup();
        t.drawdy.add({ id: "hunt-1", type: "frame", ...HUNT_FRAME, width: 0.5, meta: { iit: REMOTE_META } });
        const room = await joinRemote(t, null);
        assert.equal(room.sent("round.start").length, 0, "a frame the room would refuse is not sent");
        assert.ok(bannerTexts(t.drawdy).includes(FRAME_PROBLEM), "the banner says why");
        assert.ok(bannerTexts(t.drawdy).includes("เริ่ม · Start (Lv 3)"), "and Start stays");

        t.drawdy.elements.get("hunt-1")!.width = HUNT_FRAME.width;
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 1, "Start works once the frame is fixed");
        assert.ok(!bannerTexts(t.drawdy).includes(FRAME_PROBLEM));
    });

    it("keeps Start free when a click finds the frame too far away", async () => {
        const t = setup();
        const room = await joinRemote(t, null);
        const [first] = room.sent("round.start");
        room.socket.deliver({ v: 1, type: "result", requestId: first.requestId, command: "round.start", code: "busy", revision: 1 });
        await t.flush();
        const frame = t.drawdy.elements.get("hunt-1")!;
        frame.x = 1e7 - 10;
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 1);
        assert.ok(bannerTexts(t.drawdy).includes(FRAME_PROBLEM));

        frame.x = HUNT_FRAME.x;
        t.drawdy.click(t.onEvent, NEXT_BUTTON_ID);
        await t.flush();
        assert.equal(room.sent("round.start").length, 2, "Start works once the frame is back");
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

    it("still judges a stroke where the targets last were when the frame cannot be read", async () => {
        const t = setup();
        const room = await joinRemote(t, live());
        t.failOnce((r) => r.type === "command:scene:element-rects");
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.deepEqual(room.sent("find.claim").map((c) => c.targetId), ["t0"]);
    });

    it("runs the round and its countdown even when switching to the laser fails", async () => {
        const t = setup();
        t.failOnce((r) => r.type === "command:tools:get-active");
        await joinRemote(t, live());
        assert.equal(drawnTargets(t.drawdy).length, 3);
        assert.ok(bannerTexts(t.drawdy).includes("หาของที่ซ่อนอยู่ 3 ชิ้น · Find 3 hidden things"));
        const upserts = () => t.drawdy.commands.filter((c) => c.type === "command:dom:upsert-floating-element").length;
        const before = upserts();
        mock.timers.tick(1_000);
        await t.flush();
        assert.equal(upserts(), before + 1, "the countdown ticks");
    });

    it("follows presence while hunting, and redraws the scoreboard only when someone joins, leaves, or changes name or colour", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        await joinRemote(t, live(), 3, LEAGUE);
        const presenceSubscriptions = () => [...t.drawdy.subscriptions.values()].filter((s) => s.type === "subscription:collaboration:presence-changed");
        assert.equal(presenceSubscriptions().length, 1);
        assert.deepEqual(drawnBoard(t.drawdy), [[rowName("Ana", false), "0", roundsWonLine(1)], [rowName("Ben", false), "0"]], "Cat and Eve are not on the board");

        const before = upserts(t.drawdy);
        presence(t, [{ ...ANA, cursorPosition: { x: 5, y: 5 } }, { ...BEN, cursorPosition: { x: 9, y: 9 } }]);
        presence(t, [BEN, ANA]);
        await t.flush();
        assert.equal(upserts(t.drawdy), before, "a cursor move or a reordered list draws nothing");

        presence(t, [ANA, BEN, CAT]);
        await t.flush();
        assert.equal(upserts(t.drawdy), before + 1, "Cat joins");
        assert.deepEqual(drawnBoard(t.drawdy).map(([name]) => name), [rowName("Cat", false), rowName("Ana", false), rowName("Ben", false)]);
        presence(t, [ANA, BEN, { ...CAT, name: "Kat" }]);
        await t.flush();
        assert.equal(upserts(t.drawdy), before + 2, "Cat is renamed");
        presence(t, [ANA, BEN, { ...CAT, name: "Kat", color: "#000000" }]);
        await t.flush();
        assert.equal(upserts(t.drawdy), before + 3, "Cat changes colour");
        presence(t, [ANA, { ...CAT, name: "Kat", color: "#000000" }]);
        await t.flush();
        assert.equal(upserts(t.drawdy), before + 4, "Ben leaves");
        assert.deepEqual(drawnBoard(t.drawdy).map(([name]) => name), [rowName("Cat", false), rowName("Ana", false)]);

        t.drawdy.click(t.onEvent, STOP_BUTTON_ID);
        await t.flush();
        assert.equal(presenceSubscriptions().length, 0, "leaving unsubscribes");
    });

    it("plays as a guest when presence is unavailable, with a scoreboard of us and this round's scorers", async () => {
        const t = setup();
        t.drawdy.denied.add("command:collaboration:get-all-users-in-board");
        await joinRemote(t, live("round-9", undefined, [ben(0)]), 3, LEAGUE);
        assert.ok(![...t.drawdy.subscriptions.values()].some((s) => s.type === "subscription:collaboration:presence-changed"));
        assert.deepEqual(drawnBoard(t.drawdy), [[rowName("Ben", true), "1"], [rowName("Ana", false), "0", roundsWonLine(1)]]);
    });

    it("orders the scoreboard by this round's finds, crowns a sole leader, and shows rounds won", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN, CAT, user("u-dan", "Dan", "#0ea5e9")];
        const eve = (i: number) => findBy(i, "u-eve", "Eve", "#a855f7");
        const room = await joinRemote(t, live("round-9", undefined, [ben(0), eve(1)]), 3, LEAGUE);
        assert.deepEqual(
            drawnBoard(t.drawdy),
            [
                [rowName("Ben", false), "1"],
                [rowName("Eve", false), "1", roundsWonLine(3)],
                [rowName("Cat", false), "0", roundsWonLine(2)],
                [rowName("Ana", false), "0", roundsWonLine(1)],
            ],
            "a tie crowns nobody, Eve scored though she is off the board, and Dan never joined the room"
        );
        room.snapshot(live("round-9", undefined, [ben(0), eve(1), ben(2)]));
        await t.flush();
        assert.deepEqual(drawnBoard(t.drawdy).slice(0, 2), [
            [rowName("Ben", true), "2"],
            [rowName("Eve", false), "1", roundsWonLine(3)],
        ]);
    });

    it("names the winner of a round that ended, ourselves included, or calls a tie, with the score", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, ended(live("round-1"), "time-up", [ben(0), ben(1), findBy(2)]), 3, LEAGUE);
        assert.ok(bannerTexts(t.drawdy).includes(winLine("Ben", false)));
        assert.ok(bannerTexts(t.drawdy).includes(scoreLine([2, 1])));
        room.snapshot(ended(live("round-2"), "all-found", [findBy(0), ben(1), findBy(2)]));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(winLine("Ana", true)));
        assert.ok(bannerTexts(t.drawdy).includes(scoreLine([2, 1])));
        room.snapshot(ended(live("round-3"), "time-up", [findBy(0), ben(1)]));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(TIE_LINE));
        assert.ok(bannerTexts(t.drawdy).includes(scoreLine([1, 1])));
    });

    it("keeps the plain headline for a cancelled round, a round nobody scored in, and a player alone on the board", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, ended(live("round-1"), "cancelled", [ben(0)]), 3, LEAGUE);
        assert.ok(bannerTexts(t.drawdy).includes("จบรอบ · Round over"));
        assert.ok(!bannerTexts(t.drawdy).includes(winLine("Ben", false)));
        room.snapshot(ended(live("round-2"), "time-up"));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("หมดเวลา! · Time's up!"));
        presence(t, [ANA]);
        room.snapshot(ended(live("round-3"), "all-found", [findBy(0), findBy(1), findBy(2)]));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes("เจอครบ! · All found!"));
        assert.ok(!bannerTexts(t.drawdy).includes(winLine("Ana", true)));
    });

    it("says a rival got there first when a fresh stroke circles a target they found, once per target, for 2.5 s", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, live("round-9", undefined, [ben(0)]), 3, LEAGUE);
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")));
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")));
        assert.equal(room.sent("find.claim").length, 0, "a found target is not claimed");

        mock.timers.tick(2_499);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "it stays up through the countdown's redraws");
        mock.timers.tick(1);
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "and clears after 2.5 s");

        laser(t, [circleTarget(0)]);
        laser(t, [circleTarget(0), circleTarget(0, 1)]);
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "neither the same stroke again nor a fresh one around that target says it twice");
    });

    it("shows the newest rival's find in place of an older one, for its own 2.5 s", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN, CAT];
        await joinRemote(t, live("round-9", undefined, [ben(0), cat(1)]), 3, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        mock.timers.tick(1_000);
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(1)]);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Cat")));
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")));
        mock.timers.tick(1_500);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Cat")), "Ben's timer does not clear Cat's line");
        mock.timers.tick(1_000);
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Cat")));
    });

    it("says a rival got there first when the room answers our claim taken, before or after the snapshot that names them", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, live(), 3, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        room.snapshot(live("round-9", undefined, [ben(0)]));
        room.answer("taken");
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "the snapshot came first");

        mock.timers.tick(2_500);
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(1)]);
        await t.flush();
        room.answer("taken");
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "the room has not said who took it yet");
        room.snapshot(live("round-9", undefined, [ben(0), ben(1)]));
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "the answer came first");
    });

    it("says nothing when the round ends before the room names who took our target", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, live(), 3, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        room.answer("taken");
        room.snapshot(ended(live(), "time-up", [ben(0)]));
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")));
    });

    it("never says someone got there first for a find of ours, from this tab or another", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, live("round-9", undefined, [findBy(0)]), 3, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ana")), "a stroke around our own find");
        laser(t, [circleTarget(0), circleTarget(1)]);
        await t.flush();
        room.snapshot(live("round-9", undefined, [findBy(0), findBy(1)]));
        room.answer("taken");
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ana")), "a claim another tab of ours won");
        laser(t, [circleTarget(0), circleTarget(1), circleTarget(2)]);
        await t.flush();
        room.answer("taken");
        room.snapshot(live("round-9", undefined, [findBy(0), findBy(1), findBy(2)]));
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ana")), "and one the room named only after answering");
    });

    it("clears the got-first line when a new round starts, and leaves nothing running after leaving", async () => {
        const t = setup();
        t.drawdy.users = [ANA, BEN];
        const room = await joinRemote(t, live("round-1", undefined, [ben(0)]), 3, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")));
        room.snapshot({ status: "planting", id: "round-2", frameRect: HUNT_FRAME });
        await t.flush();
        assert.ok(!bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "a new round clears it");

        room.snapshot(live("round-2", undefined, [ben(0)]));
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(0, 1)]);
        await t.flush();
        assert.ok(bannerTexts(t.drawdy).includes(gotFirstLine("Ben")), "the same target in the next round says it again");
        t.drawdy.click(t.onEvent, STOP_BUTTON_ID);
        await t.flush();
        assert.deepEqual([...t.drawdy.subscriptions.values()].map((s) => s.req?.domElementId), [ACTION], "only the action button stays subscribed");
        const issued = t.drawdy.commands.length;
        mock.timers.tick(60_000);
        await t.flush();
        assert.equal(t.drawdy.commands.length, issued, "nothing runs after leaving");
        assert.deepEqual(warnings, []);
    });

    /** A snapshot on one room socket, for tests that leave and click the action button again. */
    const deliverSnapshot = (socket: FakeSocket, revision: number, current: unknown, roomId = "room-remote") =>
        socket.deliver({
            v: 1,
            type: "snapshot",
            revision,
            serverNow: Date.now(),
            self: "u-ana",
            room: { roomId, difficulty: 1, nextDifficulty: 1, league: LEAGUE, current, next: null, roundsPlayed: 4 },
            taunt: null,
        });

    /** Leaves the hunt, clicks the action button, and answers the new room socket's hello. */
    async function rejoin(t: ReturnType<typeof setup>) {
        t.drawdy.click(t.onEvent, STOP_BUTTON_ID);
        await t.flush();
        const before = sockets.length;
        t.drawdy.click(t.onEvent, ACTION);
        await pump(() => sockets.length > before);
        assert.ok(sockets.length > before, "the action button opened a new room socket");
        const socket = sockets[sockets.length - 1];
        socket.accept();
        assert.equal((socket.sent[0] as { type?: string } | undefined)?.type, "hello", "and it said hello");
        return socket;
    }

    /** Ben finds t0 and t1, and our find of t2 ends round-7 all found, but the write of its marker fails. */
    async function failedMarkerAtEnd(t: ReturnType<typeof setup>) {
        const room = await joinRemote(t, live("round-7", undefined, [ben(0), ben(1)]), 1, LEAGUE);
        laser(t, [circleTarget(0)]);
        await t.flush();
        laser(t, [circleTarget(0), circleTarget(2)]);
        await t.flush();
        t.failOnce((r) => r.type === "command:scene:add-drawdy-elements");
        assert.equal(room.answer("ok"), "t2");
        room.snapshot(ended(live("round-7"), "all-found", [ben(0), ben(1), findBy(2)]));
        await t.flush();
        assert.deepEqual(markers(t.drawdy), [], "the write at the ended snapshot failed");
        return room;
    }

    it("writes the marker of a find that ended the round, when its write failed, once the next round goes live", async () => {
        const t = setup();
        const room = await failedMarkerAtEnd(t);
        room.snapshot(live("round-8"));
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-7:t2"]);
    });

    it("writes the last ended round's failed marker after leaving and rejoining the frame during the next round", async () => {
        const t = setup();
        await failedMarkerAtEnd(t);
        deliverSnapshot(await rejoin(t), 1, live("round-8"));
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => m.meta.iitFound), ["round-7:t2"]);
    });

    it("keeps the last ended round to its own frame when a hunt moves to another frame and back", async () => {
        const t = setup();
        await failedMarkerAtEnd(t);
        const otherMeta = { ...REMOTE_META, roomId: "room-other", joinToken: "cd".repeat(32) };
        t.drawdy.add({ id: "hunt-2", type: "frame", x: 1300, y: 100, width: 1000, height: 700, meta: { iit: otherMeta } });
        t.drawdy.selection = ["hunt-2"];
        const other = await rejoin(t);
        assert.equal(other.url, "wss://iit.example.workers.dev/rooms/room-other");
        deliverSnapshot(other, 1, live("round-8"), "room-other");
        await t.flush();
        assert.deepEqual(markers(t.drawdy), [], "the other frame writes no marker for the first frame's round");

        t.drawdy.selection = ["hunt-1"];
        const back = await rejoin(t);
        deliverSnapshot(back, 1, live("round-8"));
        await t.flush();
        assert.deepEqual(markers(t.drawdy).map((m) => [m.meta.iitFound, m.frameId]), [["round-7:t2", "hunt-1"]], "the first frame still writes it");
    });
});
