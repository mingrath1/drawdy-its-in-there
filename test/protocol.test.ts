import { test } from "node:test";
import assert from "node:assert/strict";
import {
    commandFingerprint,
    encode,
    isServerMessage,
    MAX_DIFFICULTY,
    MIN_DIFFICULTY,
    parseClient,
    parseFrameMeta,
    parseServer,
    ProtocolError,
    toWire,
    type Command,
} from "../src/shared/protocol.ts";
import type { Rect, Room } from "../src/shared/hunt.ts";
import { openRoom, reduce } from "../src/shared/rules.ts";

const frameRect = { x: 0, y: 0, width: 800, height: 600 };
const target = { id: "t1", stampId: "cat-face", rect: { x: 10, y: 10, width: 40, height: 40 }, rotationDeg: 5, strokeColor: "#fff", strokeWidth: 2 };

test("a claim round-trips and an unknown field is rejected", () => {
    const claim: Command = { v: 1, type: "find.claim", requestId: "r-1", roundId: "round-1", targetId: "t1" };
    assert.deepEqual(parseClient(encode(claim)), claim);
    assert.throws(() => parseClient(JSON.stringify({ ...claim, extra: 1 })), ProtocolError);
});

test("a wrong version is reported as version, bad JSON as invalid", () => {
    assert.throws(() => parseClient(JSON.stringify({ v: 2, type: "hello" })), (e: ProtocolError) => e.code === "version");
    assert.throws(() => parseClient("{nope"), (e: ProtocolError) => e.code === "invalid");
});

test("a board upload over the point budget is rejected", () => {
    const points = Array.from({ length: 128 }, (_, i) => [i, i]);
    const items = Array.from({ length: 70 }, () => ({ rect: frameRect, kind: "freedraw", points }));
    const offer = { v: 1, type: "round.start", requestId: "r-2", board: { frameRect, items } };
    assert.throws(() => parseClient(JSON.stringify(offer)), ProtocolError);
});

test("toWire hides targets of rounds that are not live", () => {
    const room: Room = {
        roomId: "room-1",
        difficulty: 1,
        league: [],
        roundsPlayed: 0,
        current: { status: "ready", id: "a", frameRect, targets: [target] },
        next: { status: "ready", id: "b", frameRect, targets: [target] },
    };
    const wire = toWire(room);
    assert.equal("targets" in (wire.current as object), false);
    assert.deepEqual(wire.next, { status: "ready", id: "b" });
    const snapshot = { v: 1, type: "snapshot", revision: 3, serverNow: 1, self: "p1", room: wire, taunt: null };
    assert.deepEqual(parseServer(encode(snapshot as never)), snapshot);
});

test("live rounds keep their targets on the wire", () => {
    const room: Room = {
        roomId: "room-1",
        difficulty: 2,
        league: [{ playerId: "p1", playerName: "Ann", finds: 1, roundsWon: 0 }],
        roundsPlayed: 1,
        current: { status: "live", id: "a", frameRect, targets: [target], startedAt: 1, endsAt: 60_001, finds: [] },
        next: null,
    };
    assert.equal(toWire(room).current?.status, "live");
    assert.deepEqual((toWire(room).current as { targets: unknown[] }).targets, [target]);
});

test("every accepted board plants a round whose snapshot clients accept", () => {
    const frames: Record<string, Rect> = {
        tiny: { x: 0, y: 0, width: 1, height: 1 },
        wide: { x: 0, y: 0, width: 1000, height: 10 },
        tall: { x: 0, y: 0, width: 10, height: 1000 },
        nearUpperBound: { x: 1e7 - 800, y: 1e7 - 600, width: 800, height: 600 },
        atLowerBound: { x: -1e7, y: -1e7, width: 1, height: 1 },
        wholePlane: { x: -1e7, y: -1e7, width: 2e7, height: 2e7 },
        pastUpperBound: { x: 1e7, y: 1e7, width: 1e7, height: 1e7 },
        belowOneUnit: { x: 0, y: 0, width: 0.001, height: 0.001 },
    };
    const accepted = new Set<string>();
    for (const [name, frameRect] of Object.entries(frames)) {
        const items = [{ rect: { x: frameRect.x, y: frameRect.y, width: 1, height: 1 }, kind: "freedraw", strokeColor: "#".repeat(64), strokeWidth: 1000, points: [[frameRect.x, frameRect.y], [1e7, 1e7]] }];
        let start: Command;
        try {
            start = parseClient(JSON.stringify({ v: 1, type: "round.start", requestId: "r-1", board: { frameRect, items } })) as Command;
        } catch {
            continue;
        }
        accepted.add(name);
        for (let difficulty = MIN_DIFFICULTY; difficulty <= MAX_DIFFICULTY; difficulty++) {
            for (let seed = 0; seed < 5; seed++) {
                const room = { ...openRoom("room-1"), difficulty };
                const player = { playerId: "p1", name: "Ann", color: "#fff" };
                const step = reduce(room, start, player, { now: 1_000, fresh: { roundId: `round-${seed}`, seed }, stampIds: ["cat"] });
                const where = `${name} at level ${difficulty}, seed ${seed}`;
                assert.equal(step.room.current?.status, "live", where);
                const snapshot = { v: 1, type: "snapshot", revision: 1, serverNow: 1_000, self: "p1", room: toWire(step.room), taunt: null };
                assert.ok(isServerMessage(snapshot), `${where}: ${JSON.stringify(snapshot.room.current)}`);
            }
        }
    }
    assert.deepEqual([...accepted].sort(), ["atLowerBound", "nearUpperBound", "tall", "tiny", "wholePlane", "wide"]);
});

test("frame meta is validated before connecting", () => {
    const good = { iit: { v: 1, roomId: "room-1", joinToken: "a".repeat(64), backendUrl: "https://example.workers.dev" } };
    assert.deepEqual(parseFrameMeta(good), good.iit);
    assert.equal(parseFrameMeta({ iit: { ...good.iit, backendUrl: "http://insecure" } }), null);
    assert.equal(parseFrameMeta({ iit: { ...good.iit, joinToken: "short" } }), null);
    assert.equal(parseFrameMeta(undefined), null);
});

test("the fingerprint ignores requestId and key order, and sees payload changes", () => {
    const a: Command = { v: 1, type: "find.claim", requestId: "r-1", roundId: "x", targetId: "t1" };
    const b = { targetId: "t1", roundId: "x", requestId: "r-9", type: "find.claim", v: 1 } as Command;
    assert.equal(commandFingerprint(a), commandFingerprint(b));
    assert.notEqual(commandFingerprint(a), commandFingerprint({ ...a, targetId: "t2" }));
});
