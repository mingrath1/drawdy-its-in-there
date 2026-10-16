// One player's hunt: find or create the hunt frame, open its room through a HuntHost, render
// every snapshot, judge laser strokes, and write the found marker for our own winning claims.
// Every event runs through one queue, so handlers never interleave.

import type { DriverSubscriptionEvent, ModuleStyling, SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import type { BoardSnapshot, Find, Rect, Round, Target } from "../shared/hunt.ts";
import { judge } from "../shared/judge.ts";
import { PROTOCOL_VERSION, deriveRoomId, foundTag, parseFrameMeta } from "../shared/protocol.ts";
import type { FrameMeta, HuntHost, Player, Result, ServerMessage, Snapshot, WireRound } from "../shared/protocol.ts";
import { STAMP_PACK } from "../stamp-pack.ts";
import type { PackStamp } from "../stamp-pack.ts";
import { BANNER_ID, BANNER_TOP, BANNER_WIDTH, NEXT_BUTTON_ID, STOP_BUTTON_ID, bannerSchema } from "./banner.ts";
import type { BannerModel } from "./banner.ts";
import { BOARD_PROPERTIES, boardSnapshot } from "./board.ts";
import { CommandError, log, warn } from "./command.ts";
import type { Send } from "./command.ts";
import { BACKEND_URL } from "./config.ts";
import { domSchemaProblems } from "./dom-schema.ts";
import { createLocalHost } from "./local-host.ts";
import { createRemoteHost } from "./remote-host.ts";
import { FOUND_POP, foundMarker, previewLines, shifted, stampRuns } from "./render.ts";
import type { Point } from "./render.ts";

export const ACTION_BUTTON_ID = "iit:action";
const ACTION_BUTTON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#698cf9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 7.6 7.2 3.8 9.8 5.9M14.6 7.6l-.8-3.8-2.6 2.1"/><circle cx="10.5" cy="11.5" r="6"/><path d="M15 16l5 5"/></svg>`;
const FRAME_NAME = "It's In There!";
const LASER = "laser-pointer";
const MISSED_COLOR = "#ef4444";
const DEFAULT_PLAYER_COLOR = "#698cf9";
const REVEAL_MS = 3_000;
const REVEAL_BLINK_MS = 250;
const POP_SETTLE_MS = 1_200;
const DIFFICULTY_KEY = "local-difficulty";
/** A hunt zone smaller than this, in canvas units, grows about its centre so stamps stay findable. */
const MIN_ZONE = 240;
/** The viewport zone leaves this share of the view clear on each side, so the frame is visible. */
const VIEW_INSET = 0.1;
const SELECTION_PADDING = 24;

export type DriverContext = { send: Send; generateId: () => string; styling: ModuleStyling };

export type HuntDriver = {
    activate(): Promise<void>;
    handleEvent(event: DriverSubscriptionEvent): void;
    /** Resolves once every queued handler has run. */
    settled(): Promise<void>;
};

type TargetView = { target: Target; runs: Point[][]; ids: string[]; previewId: string | null };

type RoundView = {
    id: string;
    targets: Map<string, TargetView>;
    painted: Set<string>;
    /** How many of the laser trail's strokes are already judged. The trail only grows until it fades. */
    judged: number;
    ended: boolean;
    reveal: ReturnType<typeof setInterval> | null;
};

type Hunt = {
    frameId: string;
    frameRect: Rect;
    meta: FrameMeta;
    me: Player;
    host: HuntHost;
    snapshot: Snapshot | null;
    clockSkew: number;
    /** The host's latest line. Snapshots without a new moment carry none, so the last one stays up. */
    taunt: string | null;
    /** The board our last round.start sent, offered once more to plant the next round while this one plays. */
    offerBoard: BoardSnapshot | null;
    startOnOpen: boolean;
    round: RoundView | null;
    claims: Map<string, { roundId: string; target: Target }>;
    banner: { x: number; y: number } | null;
    subscriptions: string[];
    toolToRestore: string | null;
    ticker: ReturnType<typeof setInterval> | null;
    savedDifficulty: number | null;
};

type Place = { kind: "join"; frameId: string; rect: Rect; meta: FrameMeta } | { kind: "new"; rect: Rect };

const stamps = new Map<string, PackStamp>(STAMP_PACK.map((s) => [s.id, s]));

export function createHuntDriver(ctx: DriverContext): HuntDriver {
    const { send } = ctx;
    const localRooms = new Map<string, HuntHost>();
    const guestId = `guest-${Math.random().toString(36).slice(2, 10)}`;
    let hunt: Hunt | null = null;
    let queue: Promise<void> = Promise.resolve();
    let requestSeq = 0;

    const enqueue = (label: string, task: () => Promise<void>) => {
        queue = queue.then(task).catch((error) => warn(`${label} failed:`, error instanceof Error ? error.message : error));
    };
    const withHunt = (task: (h: Hunt) => Promise<void>) => () => (hunt ? task(hunt) : Promise.resolve());
    const quietly = (label: string, work: Promise<unknown>) =>
        work.then(
            () => undefined,
            (error) => warn(`${label} failed:`, error instanceof Error ? error.message : error)
        );
    const nextRequestId = () => `c-${Date.now().toString(36)}-${requestSeq++}`;

    async function onActionClick() {
        const current = hunt;
        if (current) {
            if (!current.snapshot || isRunning(current.snapshot.room.current)) {
                log("a hunt is already running here; click ignored");
                return;
            }
            await leave(current);
        }
        log("click: looking for a hunt frame in the selection or view");
        let place: Place;
        try {
            place = await findPlace();
        } catch (error) {
            if (error instanceof CommandError && error.reason === "unauthorized") {
                warn("scene permission denied; the hunt needs it to read and mark the board");
                return;
            }
            throw error;
        }

        const local = place.kind === "new" ? BACKEND_URL === null : place.meta.backendUrl === null;
        const difficulty = local ? await loadDifficulty() : 1;
        const me = await whoAmI();
        const banner = await bannerSpot();
        const frame = place.kind === "join" ? place : await createFrame(place.rect);
        log(
            `${place.kind === "join" ? "joining" : "created"} hunt frame ${frame.frameId}, room ${frame.meta.roomId} on ${frame.meta.backendUrl ?? "the local host"}, as ${me.name}`
        );

        const h: Hunt = {
            frameId: frame.frameId,
            frameRect: frame.rect,
            meta: frame.meta,
            me,
            host: hostFor(frame.meta, difficulty),
            snapshot: null,
            clockSkew: 0,
            taunt: null,
            offerBoard: null,
            startOnOpen: true,
            round: null,
            claims: new Map(),
            banner,
            subscriptions: [],
            toolToRestore: null,
            ticker: null,
            savedDifficulty: local ? difficulty : null,
        };
        hunt = h;
        try {
            h.subscriptions = await subscribe(banner !== null);
            await renderBanner(h);
        } catch (error) {
            warn("could not set up the hunt:", error instanceof Error ? error.message : error);
            await leave(h);
            return;
        }
        // Not awaited: the queue stays free while the room connects, so Leave works at once.
        h.host
            .open(
                { v: PROTOCOL_VERSION, type: "hello", roomId: h.meta.roomId, joinToken: h.meta.joinToken, player: me },
                (message) => enqueue(`room ${message.type}`, () => onMessage(h, message))
            )
            .catch((error) =>
                enqueue("opening the room", async () => {
                    if (hunt !== h) return;
                    warn("could not open the room:", error instanceof Error ? error.message : error);
                    await leave(h);
                })
            );
    }

    async function findPlace(): Promise<Place> {
        const { drawdyElementIds: selected } = await send({ type: "command:scene:get-current-selected-drawdy-elements" });
        if (selected.length > 0) {
            const { drawdyElements } = await send({
                type: "command:scene:get-drawdy-elements",
                req: { properties: ["type", "meta"], drawdyElementIds: selected },
            });
            const joinable = await joinableFrame(drawdyElements, null);
            if (joinable) return joinable;
            const { rect } = await send({ type: "command:scene:query-combined-rect", req: { drawdyElementIds: selected } });
            if (rect) return { kind: "new", rect: atLeast(grow(rect, SELECTION_PADDING), MIN_ZONE) };
        }
        const { rect: view } = await send({ type: "command:camera:get-viewport-rect" });
        const { drawdyElements } = await send({ type: "command:scene:query-rect", req: { rect: view, properties: ["type", "meta"] } });
        const joinable = await joinableFrame(drawdyElements, view);
        if (joinable) return joinable;
        return { kind: "new", rect: atLeast(grow(view, -Math.min(view.width, view.height) * VIEW_INSET), MIN_ZONE) };
    }

    async function joinableFrame(elements: readonly SubscribedDrawdyElement[], view: Rect | null): Promise<Place | null> {
        const frames: { id: string; meta: FrameMeta }[] = [];
        for (const e of elements) {
            if (e.type !== "frame" || !e.meta || !("iit" in e.meta)) continue;
            const meta = parseFrameMeta(e.meta);
            if (meta) frames.push({ id: e.id, meta });
            else warn(`ignored hunt frame ${e.id}: its meta.iit does not validate`);
        }
        if (frames.length === 0) return null;
        const { rects } = await send({ type: "command:scene:element-rects", req: { drawdyElementIds: frames.map((f) => f.id) } });
        let best: Place | null = null;
        let bestOverlap = -1;
        for (const { drawdyElementId, rect } of rects) {
            const frame = frames.find((f) => f.id === drawdyElementId);
            const overlap = view ? overlapArea(rect, view) : 0;
            if (frame && overlap > bestOverlap) {
                best = { kind: "join", frameId: frame.id, rect, meta: frame.meta };
                bestOverlap = overlap;
            }
        }
        return best;
    }

    async function createFrame(rect: Rect): Promise<{ frameId: string; rect: Rect; meta: FrameMeta }> {
        const joinToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const meta: FrameMeta = { v: 1, roomId: deriveRoomId(joinToken), joinToken, backendUrl: BACKEND_URL };
        if (!parseFrameMeta({ iit: meta })) throw new Error("built a hunt frame meta that does not validate");
        const frameId = ctx.generateId();
        await send({
            type: "command:scene:add-drawdy-elements",
            req: {
                elements: [
                    {
                        type: "frame",
                        drawdyElementId: frameId,
                        name: FRAME_NAME,
                        position: [rect.x, rect.y],
                        width: rect.width,
                        height: rect.height,
                        rotation: 0,
                        meta: { iit: meta },
                    },
                ],
            },
        });
        return { frameId, rect, meta };
    }

    function hostFor(meta: FrameMeta, difficulty: number): HuntHost {
        if (meta.backendUrl) return createRemoteHost({ backendUrl: meta.backendUrl, roomId: meta.roomId });
        // A local room lives as long as the driver, so reopening its frame resumes it.
        let host = localRooms.get(meta.roomId);
        if (!host) {
            host = createLocalHost({ stampIds: STAMP_PACK.map((s) => s.id), difficulty });
            localRooms.set(meta.roomId, host);
        }
        return host;
    }

    async function subscribe(withBanner: boolean): Promise<string[]> {
        const ids: string[] = [];
        const add = (label: string, work: Promise<{ subscriptionId: string }>) =>
            quietly(label, work.then(({ subscriptionId }) => ids.push(subscriptionId)));
        await add("laser subscription", send({ type: "subscription:tool:laser" }));
        await add("next button", send({ type: "subscription:dom:element-clicked", req: { domElementId: NEXT_BUTTON_ID } }));
        await add("stop button", send({ type: "subscription:dom:element-clicked", req: { domElementId: STOP_BUTTON_ID } }));
        if (withBanner) await add("theme subscription", send({ type: "subscription:dom:theme-changed" }));
        return ids;
    }

    async function whoAmI(): Promise<Player> {
        try {
            const { users } = await send({ type: "command:collaboration:get-all-users-in-board" });
            const self = users.find((u) => u.isSelf) ?? users[0];
            if (self) {
                return {
                    playerId: clean(self.id, 128) || guestId,
                    name: clean(self.name, 64) || "You",
                    color: clean(self.color, 64) || DEFAULT_PLAYER_COLOR,
                };
            }
        } catch (error) {
            warn("presence unavailable; playing as You:", error instanceof Error ? error.message : error);
        }
        return { playerId: guestId, name: "You", color: DEFAULT_PLAYER_COLOR };
    }

    async function loadDifficulty(): Promise<number> {
        try {
            const { got } = await send({ type: "command:kv-storage:get", req: { key: DIFFICULTY_KEY } });
            const value = got?.difficulty;
            return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
        } catch (error) {
            warn("stored difficulty unavailable; starting at 1:", error instanceof Error ? error.message : error);
            return 1;
        }
    }

    async function bannerSpot(): Promise<{ x: number; y: number } | null> {
        try {
            const { width } = await send({ type: "command:dom:window-size" });
            return { x: Math.max(8, Math.round((width - BANNER_WIDTH) / 2)), y: BANNER_TOP };
        } catch (error) {
            warn("no banner, the dom permission is unavailable:", error instanceof Error ? error.message : error);
            return null;
        }
    }

    async function onMessage(h: Hunt, message: ServerMessage) {
        if (hunt !== h) return;
        if (message.type === "result") return onResult(h, message);
        if (message.type === "fault") {
            warn(`room fault: ${message.code}`);
            if (message.code === "auth" || message.code === "version") await leave(h);
            return;
        }
        if (h.snapshot && message.revision <= h.snapshot.revision) return;
        h.snapshot = message;
        h.clockSkew = message.serverNow - Date.now();
        if (message.taunt) h.taunt = message.taunt;
        const current = message.room.current;
        log(
            `snapshot r${message.revision}: ${current ? `${current.status} ${current.id}` : "no round"}, difficulty ${message.room.difficulty}`
        );
        if (h.savedDifficulty !== null && h.savedDifficulty !== message.room.difficulty) {
            h.savedDifficulty = message.room.difficulty;
            await quietly(
                "saving difficulty",
                send({ type: "command:kv-storage:set", req: { key: DIFFICULTY_KEY, payload: { difficulty: message.room.difficulty } } })
            );
        }
        await renderRound(h, current);
        if (h.startOnOpen) {
            h.startOnOpen = false;
            if (!isRunning(current)) await requestRound(h);
        }
        await renderBanner(h);
    }

    async function requestRound(h: Hunt) {
        if (isRunning(h.snapshot?.room.current ?? null)) {
            log("a round is already running");
            return;
        }
        const rect = await frameRect(h);
        if (!rect) {
            warn("the hunt frame is gone; leaving the hunt");
            await leave(h);
            return;
        }
        h.frameRect = rect;
        const { drawdyElements } = await send({ type: "command:scene:query-rect", req: { rect, properties: BOARD_PROPERTIES } });
        const board = boardSnapshot(rect, drawdyElements);
        const points = board.items.reduce((n, i) => n + (i.points?.length ?? 0), 0);
        log(`asking for a round: board has ${board.items.length} items and ${points} points`);
        h.offerBoard = board;
        h.host.send({ v: PROTOCOL_VERSION, type: "round.start", requestId: nextRequestId(), board });
    }

    async function renderRound(h: Hunt, current: WireRound | null) {
        if (h.round && h.round.id !== current?.id) await clearRound(h);
        if (!current || current.status === "planting" || current.status === "ready") return;
        if (!h.round) {
            // Targets are drawn only for a live round; one already over when we arrive stays hidden.
            if (current.status !== "live") return;
            h.round = await drawRound(h, current);
            await toLaser(h);
            startTicker(h);
            if (h.offerBoard) {
                h.host.send({ v: PROTOCOL_VERSION, type: "board.offer", requestId: nextRequestId(), afterRoundId: current.id, board: h.offerBoard });
                h.offerBoard = null;
            }
        }
        await paintFinds(h.round, current.finds);
        if (current.status === "ended" && !h.round.ended) await finishRound(h, h.round, current);
    }

    async function drawRound(h: Hunt, round: Extract<Round, { status: "live" }>): Promise<RoundView> {
        h.frameRect = (await frameRect(h)) ?? h.frameRect;
        const offset = { dx: h.frameRect.x - round.frameRect.x, dy: h.frameRect.y - round.frameRect.y };
        const view: RoundView = { id: round.id, targets: new Map(), painted: new Set(), judged: 0, ended: false, reveal: null };
        for (const planted of round.targets) {
            const target = shifted(planted, offset);
            const runs = stampRuns(stamps.get(target.stampId) ?? STAMP_PACK[0], target);
            const ids = runs.map(() => ctx.generateId());
            const tv: TargetView = { target, runs, ids, previewId: null };
            view.targets.set(target.id, tv);
            try {
                const { previewId } = await send({
                    type: "command:scene:create-drawdy-preview-elements",
                    req: { elements: previewLines(ids, runs, target.strokeColor, target.strokeWidth) },
                });
                tv.previewId = previewId;
            } catch (error) {
                warn(`could not draw target ${target.id}:`, error instanceof Error ? error.message : error);
            }
        }
        log(`round ${round.id} is live: drew ${view.targets.size} targets, frame offset (${offset.dx}, ${offset.dy})`);
        return view;
    }

    async function paint(tv: TargetView, color: string, strokeWidth = tv.target.strokeWidth) {
        if (!tv.previewId) return;
        await send({
            type: "command:scene:update-drawdy-preview-elements",
            req: { elements: previewLines(tv.ids, tv.runs, color, strokeWidth) },
        });
    }

    async function paintFinds(view: RoundView, finds: Find[]) {
        for (const find of finds) {
            if (view.painted.has(find.targetId)) continue;
            view.painted.add(find.targetId);
            const tv = view.targets.get(find.targetId);
            if (tv) await quietly("recolouring a find", paint(tv, find.playerColor, tv.target.strokeWidth * 1.5));
            log(`found ${find.targetId} by ${find.playerName}`);
        }
    }

    async function finishRound(h: Hunt, view: RoundView, round: Extract<Round, { status: "ended" }>) {
        view.ended = true;
        stopTicker(h);
        await restoreTool(h);
        log(`round ${round.id} ended (${round.reason}): ${round.finds.length}/${round.targets.length} found`);
        const missed = [...view.targets.values()].filter((tv) => !view.painted.has(tv.target.id));
        if (missed.length === 0) return;
        for (const tv of missed) await quietly("revealing a target", paint(tv, MISSED_COLOR));
        let blinks = 0;
        view.reveal = setInterval(() => {
            blinks++;
            const done = blinks * REVEAL_BLINK_MS >= REVEAL_MS;
            if (done && view.reveal) clearInterval(view.reveal);
            const color = (tv: TargetView) => (done || blinks % 2 === 0 ? MISSED_COLOR : tv.target.strokeColor);
            enqueue("reveal", async () => {
                if (h.round !== view) return;
                for (const tv of missed) await paint(tv, color(tv));
            });
        }, REVEAL_BLINK_MS);
    }

    async function clearRound(h: Hunt) {
        const view = h.round;
        if (!view) return;
        h.round = null;
        if (view.reveal) clearInterval(view.reveal);
        const previewIds = [...view.targets.values()].flatMap((tv) => (tv.previewId ? [tv.previewId] : []));
        if (previewIds.length > 0) {
            await quietly("removing targets", send({ type: "command:scene:delete-drawdy-preview-elements", req: { previewIds } }));
        }
    }

    async function judgeStrokes(h: Hunt, lasers: readonly (readonly [number, number])[][]) {
        const view = h.round;
        const current = h.snapshot?.room.current;
        if (!view || view.ended || current?.status !== "live" || current.id !== view.id) return;
        if (lasers.length < view.judged) view.judged = 0;
        const fresh = lasers.slice(view.judged);
        view.judged = lasers.length;

        const taken = new Set(current.finds.map((f) => f.targetId));
        for (const claim of h.claims.values()) if (claim.roundId === view.id) taken.add(claim.target.id);
        for (const stroke of fresh) {
            const hits = [...view.targets.values()].filter((tv) => !taken.has(tv.target.id) && judge({ points: stroke }, tv.target));
            log(`laser stroke of ${stroke.length} points: ${hits.length > 0 ? `hit ${hits.map((tv) => tv.target.id).join(", ")}` : "miss"}`);
            for (const tv of hits) {
                taken.add(tv.target.id);
                const requestId = nextRequestId();
                h.claims.set(requestId, { roundId: view.id, target: tv.target });
                h.host.send({ v: PROTOCOL_VERSION, type: "find.claim", requestId, roundId: view.id, targetId: tv.target.id });
            }
        }
    }

    async function onResult(h: Hunt, result: Result) {
        const claim = h.claims.get(result.requestId);
        if (!claim) {
            log(`${result.command} answered ${result.code}`);
            return;
        }
        h.claims.delete(result.requestId);
        log(`claim on ${claim.target.id} answered ${result.code}`);
        if (result.code === "ok") await writeMarker(h, claim.roundId, claim.target);
    }

    /** Only the winning claimant writes the marker, and only if no element carries its tag yet. */
    async function writeMarker(h: Hunt, roundId: string, target: Target) {
        const tag = foundTag(roundId, target.id);
        const rect = (await frameRect(h)) ?? h.frameRect;
        const { drawdyElements } = await send({ type: "command:scene:query-rect", req: { rect, properties: ["meta"] } });
        if (drawdyElements.some((e) => e.meta?.iitFound === tag)) {
            log(`marker ${tag} is already on the board`);
            return;
        }
        const id = ctx.generateId();
        await send({
            type: "command:scene:add-drawdy-elements",
            req: { elements: [foundMarker({ id, frameId: h.frameId, frameRect: rect, target, color: h.me.color, tag })] },
        });
        await send({
            type: "command:scene:update-drawdy-elements",
            req: { updates: [{ drawdyElementId: id, properties: { localAnimation: FOUND_POP } }] },
        });
        log(`marker ${tag} written`);
        // Clear the pop once it has played, so a reload does not replay it on every trophy.
        setTimeout(
            () =>
                enqueue("settling the marker", () =>
                    send({
                        type: "command:scene:update-drawdy-elements",
                        req: { updates: [{ drawdyElementId: id, properties: { localAnimation: null } }] },
                    }).then(() => undefined)
                ),
            POP_SETTLE_MS
        );
    }

    async function toLaser(h: Hunt) {
        if (h.toolToRestore !== null) return;
        const { toolId } = await send({ type: "command:tools:get-active" });
        if (toolId === LASER) return;
        await send({ type: "command:tools:set-active", req: { toolId: LASER } });
        h.toolToRestore = toolId ?? "select";
        log(`switched to the laser; will restore ${h.toolToRestore}`);
    }

    async function restoreTool(h: Hunt) {
        const previous = h.toolToRestore;
        if (previous === null) return;
        h.toolToRestore = null;
        const { toolId } = await send({ type: "command:tools:get-active" });
        if (toolId === LASER) await send({ type: "command:tools:set-active", req: { toolId: previous } });
    }

    function startTicker(h: Hunt) {
        stopTicker(h);
        h.ticker = setInterval(() => enqueue("countdown", () => renderBanner(h)), 1_000);
    }

    function stopTicker(h: Hunt) {
        if (h.ticker) clearInterval(h.ticker);
        h.ticker = null;
    }

    function bannerModel(h: Hunt): BannerModel {
        const s = h.snapshot;
        const nextLevel = s?.room.difficulty ?? 1;
        const league = (s?.room.league ?? []).map((e) => ({ name: e.playerName, finds: e.finds }));
        const round = s?.room.current ?? null;
        if (!s) return { nextLevel, league, phase: "connecting" };
        if (!round) return { nextLevel, league, phase: "idle" };
        if (round.status === "planting" || round.status === "ready") return { nextLevel, league, phase: "hiding" };
        const targets = round.targets.map((t) => {
            const stamp = stamps.get(t.stampId);
            const find = round.finds.find((f) => f.targetId === t.id);
            return { label: stamp?.label ?? t.stampId, labelTh: stamp?.labelTh, foundColor: find?.playerColor ?? null };
        });
        if (round.status === "live") {
            const secondsLeft = (round.endsAt - (Date.now() + h.clockSkew)) / 1000;
            return { nextLevel, league, phase: "live", secondsLeft, targets, taunt: h.taunt };
        }
        return { nextLevel, league, phase: "ended", reason: round.reason, targets, taunt: h.taunt };
    }

    async function renderBanner(h: Hunt) {
        if (!h.banner || hunt !== h) return;
        const schema = bannerSchema(bannerModel(h), ctx.styling);
        const problems = domSchemaProblems(schema);
        if (problems.length > 0) {
            warn("banner not sent; its schema would hang Drawdy:", problems);
            return;
        }
        await send({
            type: "command:dom:upsert-floating-element",
            req: { domId: BANNER_ID, position: h.banner, schema, asPopover: false },
        });
    }

    async function leave(h: Hunt) {
        if (hunt === h) hunt = null;
        h.host.close();
        stopTicker(h);
        await clearRound(h);
        if (h.banner) await quietly("removing the banner", send({ type: "command:dom:remove-floating-element", req: { domId: BANNER_ID } }));
        await quietly("restoring the tool", restoreTool(h));
        for (const subscriptionId of h.subscriptions) {
            await quietly("unsubscribing", send({ type: "command:subscription:remove", req: { subscriptionId } }));
        }
        log("left the hunt; the frame and its markers stay on the board");
    }

    async function frameRect(h: Hunt): Promise<Rect | null> {
        const { rects } = await send({ type: "command:scene:element-rects", req: { drawdyElementIds: [h.frameId] } });
        return rects.find((r) => r.drawdyElementId === h.frameId)?.rect ?? null;
    }

    return {
        async activate() {
            await send({ type: "command:dom:create-action-button", req: { domElementId: ACTION_BUTTON_ID, svg: ACTION_BUTTON_SVG } });
            await send({ type: "subscription:dom:element-clicked", req: { domElementId: ACTION_BUTTON_ID } });
            log("ready: action button created; nothing else runs until it is clicked");
        },
        handleEvent(event) {
            switch (event.type) {
                case "subscription:dom:element-clicked": {
                    const id = event.body.domElementId;
                    if (id === ACTION_BUTTON_ID) enqueue("action button", onActionClick);
                    else if (id === NEXT_BUTTON_ID) enqueue("next round", withHunt(requestRound));
                    else if (id === STOP_BUTTON_ID) enqueue("stop", withHunt(leave));
                    return;
                }
                case "subscription:tool:laser":
                    enqueue("laser", withHunt((h) => judgeStrokes(h, event.body.lasers)));
                    return;
                case "subscription:dom:theme-changed":
                    ctx.styling = event.body.styling;
                    enqueue("theme", withHunt(renderBanner));
                    return;
            }
        },
        settled: () => queue,
    };
}

function isRunning(round: WireRound | null): boolean {
    return round?.status === "planting" || round?.status === "ready" || round?.status === "live";
}

function grow(rect: Rect, by: number): Rect {
    return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

function atLeast(rect: Rect, min: number): Rect {
    const width = Math.max(rect.width, min);
    const height = Math.max(rect.height, min);
    return { x: rect.x - (width - rect.width) / 2, y: rect.y - (height - rect.height) / 2, width, height };
}

function overlapArea(a: Rect, b: Rect): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

function clean(value: unknown, max: number): string {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
