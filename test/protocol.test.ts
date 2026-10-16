import { test } from "node:test";
import assert from "node:assert/strict";
import {
    commandFingerprint,
    encode,
    parseClient,
    parseFrameMeta,
    parseServer,
    ProtocolError,
    toWire,
    type Command,
} from "../src/shared/protocol.ts";
import type { Room } from "../src/shared/hunt.ts";

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
