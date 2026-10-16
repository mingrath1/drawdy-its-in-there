import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
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
    room: { roomId: "room-1", difficulty: 1, league: [], current: null, next: null, roundsPlayed: 0 },
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
    beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
    afterEach(() => mock.timers.reset());

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
        t.last().deliver(snapshot(1));
        t.last().drop();
        mock.timers.tick(500);
        assert.equal(t.sockets.length, 11);
    });

    it("stops for good on an auth or version fault", async () => {
        const t = setup();
        t.last().accept();
        t.last().deliver({ v: 1, type: "fault", code: "auth", retryAfterMs: 0 });
        await assert.rejects(t.opened, (e: RoomFault) => e.code === "auth");
        mock.timers.tick(BACKOFF_CAP_MS * 2);
        assert.equal(t.sockets.length, 1);
        assert.equal(t.received.at(-1)?.type, "fault");
    });

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
});
