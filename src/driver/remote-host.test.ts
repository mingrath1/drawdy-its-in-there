import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { MAX_FRAME_CHARS, encode } from "../shared/protocol.ts";
import type { Command, Hello, ServerMessage, Snapshot } from "../shared/protocol.ts";
import { BACKOFF_CAP_MS, createRemoteHost, RoomFault } from "./remote-host.ts";
import { FakeSocket } from "../../test/fake-socket.ts";

const HELLO: Hello = {
    v: 1,
    type: "hello",
    roomId: "room-1",
    joinToken: "cd".repeat(32),
    player: { playerId: "p1", name: "Ana", color: "#ff4d4d" },
};

const snapshot = (revision: number): Snapshot => ({
    v: 1,
    type: "snapshot",
    revision,
    serverNow: 1_000,
    self: "p1",
    room: { roomId: "room-1", difficulty: 1, nextDifficulty: 1, league: [], current: null, next: null, roundsPlayed: 0 },
    taunt: null,
});
const claim = (requestId: string): Command => ({ v: 1, type: "find.claim", requestId, roundId: "r1", targetId: "t1" });
const result = (requestId: string) => ({ v: 1, type: "result", requestId, command: "find.claim", code: "ok", revision: 2 });

function setup() {
    const sockets: FakeSocket[] = [];
    const received: ServerMessage[] = [];
    const host = createRemoteHost({
        backendUrl: "https://iit.example.workers.dev/",
        roomId: "room-1",
        connect: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
        },
        random: () => 1,
    });
    const opened = host.open(HELLO, (m) => received.push(m));
    opened.catch(() => {});
    return { host, sockets, received, opened, last: () => sockets[sockets.length - 1] };
}

describe("remote host", () => {
    let warnings: unknown[][];
    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
        mock.method(console, "log", () => {});
        warnings = [];
        mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it("dials the room over wss, says hello first, and opens on the first snapshot", async () => {
        const t = setup();
        let open = false;
        void t.opened.then(() => (open = true));
        assert.equal(t.last().url, "wss://iit.example.workers.dev/rooms/room-1");
        t.last().accept();
        assert.deepEqual(t.last().sent, [HELLO]);
        await Promise.resolve();
        assert.equal(open, false);
        t.last().deliver(snapshot(1));
        await t.opened;
        assert.deepEqual(t.received, [snapshot(1)]);
    });

    it("holds commands until the snapshot, then sends them in order", async () => {
        const t = setup();
        t.host.send(claim("a"));
        t.host.send(claim("b"));
        t.last().accept();
        assert.deepEqual(t.last().sent, [HELLO]);
        t.last().deliver(snapshot(1));
        t.host.send(claim("c"));
        assert.deepEqual(t.last().sent, [HELLO, claim("a"), claim("b"), claim("c")]);
    });

    it("replays unanswered commands with their original ids after reconnecting", async () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        t.host.send(claim("a"));
        t.host.send(claim("b"));
        t.last().deliver(result("a"));
        t.last().drop();

        assert.equal(t.sockets.length, 1);
        mock.timers.tick(500);
        assert.equal(t.sockets.length, 2);
        t.last().accept();
        assert.deepEqual(t.last().sent, [HELLO]);
        t.last().deliver(snapshot(2));
        assert.deepEqual(t.last().sent, [HELLO, claim("b")]);
    });

    it("backs off exponentially, capped at 30 s, and resets after a snapshot", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        const waits: number[] = [];
        for (let i = 0; i < 9; i++) {
            const before = t.sockets.length;
            t.last().drop();
            let waited = 0;
            while (t.sockets.length === before) {
                mock.timers.tick(250);
                waited += 250;
            }
            waits.push(waited);
        }
        assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
        assert.ok(waits.every((w) => w <= BACKOFF_CAP_MS));

        t.last().accept();
        t.last().deliver(snapshot(2));
        t.last().drop();
        mock.timers.tick(500);
        assert.equal(t.sockets.length, 11);
    });

    for (const code of ["auth", "full"] as const) {
        it(`stops for good on a ${code} fault`, async () => {
            const t = setup();
            t.last().accept();
            t.last().deliver({ v: 1, type: "fault", code, retryAfterMs: 60_000 });
            await assert.rejects(t.opened, (e: RoomFault) => e.code === code);
            mock.timers.tick(BACKOFF_CAP_MS * 4);
            assert.equal(t.sockets.length, 1);
            assert.equal(t.received.at(-1)?.type, "fault");
        });
    }

    it("waits at least the room's retryAfterMs after a rate-limit fault", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        t.last().deliver({ v: 1, type: "fault", code: "rate-limit", retryAfterMs: 5_000 });
        t.last().drop();
        mock.timers.tick(4_999);
        assert.equal(t.sockets.length, 1);
        mock.timers.tick(1);
        assert.equal(t.sockets.length, 2);
    });

    it("ignores malformed messages and refuses invalid commands", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver("{not json");
        t.last().deliver({ v: 1, type: "snapshot" });
        assert.deepEqual(t.received, []);
        t.last().deliver(snapshot(1));
        t.host.send({ v: 1, type: "find.claim", requestId: "bad id with spaces", roundId: "r1", targetId: "t1" });
        assert.deepEqual(t.last().sent, [HELLO]);
    });

    it("does not reconnect after close", async () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        await t.opened;
        t.host.close();
        mock.timers.tick(BACKOFF_CAP_MS * 2);
        assert.equal(t.sockets.length, 1);
    });

    it("refuses a command too big for one frame, so it can never block the outbox", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        const points = Array.from({ length: 128 }, (_, k): [number, number] => [Math.PI * 1000 + k, Math.E * 1000 + k]);
        const item = { rect: { x: 0, y: 0, width: 1, height: 1 }, kind: "freedraw" as const, points };
        const big: Command = { v: 1, type: "round.start", requestId: "big", board: { frameRect: { x: 0, y: 0, width: 100, height: 100 }, items: Array(64).fill(item) } };
        assert.ok(encode(big).length > MAX_FRAME_CHARS);
        t.host.send(big);
        t.host.send(claim("a"));
        assert.deepEqual(t.last().sent, [HELLO, claim("a")]);
        assert.equal(warnings.length, 1);
        t.last().drop();
        mock.timers.tick(500);
        t.last().accept();
        t.last().deliver(snapshot(2));
        assert.deepEqual(t.last().sent, [HELLO, claim("a")], "the refused command is not replayed");
    });

    it("redials when a connection brings no snapshot within 10 s, on every reconnect", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        t.last().drop();
        mock.timers.tick(500);
        assert.equal(t.sockets.length, 2);
        t.last().accept();
        mock.timers.tick(9_999);
        assert.equal(t.sockets[1].readyState, 1);
        mock.timers.tick(1);
        assert.equal(t.sockets[1].readyState, 3, "the silent connection is closed");
        mock.timers.tick(1_000);
        assert.equal(t.sockets.length, 3);
        mock.timers.tick(10_000);
        assert.equal(t.sockets[2].readyState, 3, "the next one gets the same deadline");
        mock.timers.tick(2_000);
        assert.equal(t.sockets.length, 4);
    });

    it("reconnects and replays with the original ids when a command gets no result within 15 s", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        t.host.send(claim("a"));
        mock.timers.tick(10_000);
        t.last().deliver(result("a"));
        t.host.send(claim("b"));
        mock.timers.tick(14_999);
        assert.equal(t.sockets[0].readyState, 1, "an answered command resets the deadline");
        mock.timers.tick(1);
        assert.equal(t.sockets[0].readyState, 3);
        mock.timers.tick(500);
        assert.equal(t.sockets.length, 2);
        t.last().accept();
        t.last().deliver(snapshot(2));
        assert.deepEqual(t.last().sent, [HELLO, claim("b")]);
    });

    it("closes its socket and stops dialing when open times out", async () => {
        const t = setup();
        let error: RoomFault | undefined;
        t.opened.catch((e: RoomFault) => (error = e));
        mock.timers.tick(15_000);
        await settle();
        assert.equal(error?.code, "timeout");
        assert.equal(t.last().readyState, 3, "the socket is closed");
        const dialed = t.sockets.length;
        mock.timers.tick(BACKOFF_CAP_MS * 4);
        assert.equal(t.sockets.length, dialed, "and nothing redials");
    });

    it("waits out a retryAfterMs longer than the backoff cap", () => {
        const t = setup();
        t.last().accept();
        t.last().deliver(snapshot(1));
        t.last().deliver({ v: 1, type: "fault", code: "unavailable", retryAfterMs: 60_000 });
        t.last().drop();
        mock.timers.tick(59_999);
        assert.equal(t.sockets.length, 1);
        mock.timers.tick(1);
        assert.equal(t.sockets.length, 2);
    });

    it("stops for good when the room speaks another protocol version", async () => {
        const t = setup();
        let error: RoomFault | undefined;
        t.opened.catch((e: RoomFault) => (error = e));
        t.last().accept();
        t.last().deliver({ v: 2, type: "snapshot" });
        await settle();
        assert.equal(error?.code, "version");
        assert.deepEqual(t.received, [{ v: 1, type: "fault", code: "version", retryAfterMs: 0 }], "the hunt hears it as a version fault");
        assert.equal(t.last().readyState, 3);
        mock.timers.tick(BACKOFF_CAP_MS * 2);
        assert.equal(t.sockets.length, 1);
    });
});
