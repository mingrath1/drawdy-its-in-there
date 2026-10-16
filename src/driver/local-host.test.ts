import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { DistributiveOmit } from "@drawdy/driver-protocol";
import type { BoardSnapshot } from "../shared/hunt.ts";
import { isServerMessage, roundDurationMs, targetCount } from "../shared/protocol.ts";
import type { Command, Hello, Result, ServerMessage, Snapshot, WireRound } from "../shared/protocol.ts";
import { createLocalHost } from "./local-host.ts";

const HELLO: Hello = {
    v: 1,
    type: "hello",
    roomId: "room-1",
    joinToken: "ab".repeat(32),
    player: { playerId: "p1", name: "Ana", color: "#ff4d4d" },
};
const BOARD: BoardSnapshot = { frameRect: { x: 0, y: 0, width: 1000, height: 700 }, items: [] };

function setup(difficulty = 1) {
    let clock = 1_000_000;
    let ids = 0;
    const messages: ServerMessage[] = [];
    const host = createLocalHost({ stampIds: ["cat-face", "number-229"], difficulty, now: () => clock });
    const send = (command: DistributiveOmit<Command, "v" | "requestId"> & { requestId?: string }) =>
        host.send({ v: 1, requestId: `q${ids++}`, ...command } as Command);
    const snapshots = () => messages.filter((m): m is Snapshot => m.type === "snapshot");
    const results = () => messages.filter((m): m is Result => m.type === "result");
    const current = (): WireRound | null => snapshots().at(-1)!.room.current;
    const live = () => {
        const round = current();
        assert.equal(round?.status, "live");
        return round as Extract<WireRound, { status: "live" }>;
    };
    return {
        host,
        messages,
        send,
        snapshots,
        results,
        current,
        live,
        advance: (ms: number) => {
            clock += ms;
            mock.timers.tick(ms);
        },
        open: () => host.open(HELLO, (m) => messages.push(m)),
    };
}

describe("local host", () => {
    beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
    afterEach(() => mock.timers.reset());

    it("greets with a snapshot of an empty room", async () => {
        const t = setup(2);
        await t.open();
        const [first] = t.snapshots();
        assert.equal(first.self, "p1");
        assert.equal(first.room.difficulty, 2);
        assert.equal(first.room.current, null);
        assert.deepEqual(first.room.league, [{ playerId: "p1", playerName: "Ana", finds: 0, roundsWon: 0 }]);
    });

    it("starts a live round at the room's level with the protocol's count and clock", async () => {
        const t = setup(2);
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const round = t.live();
        assert.equal(round.targets.length, targetCount(2));
        assert.equal(round.endsAt - round.startedAt, roundDurationMs(2));
        assert.equal(t.results().at(-1)!.code, "ok");
        assert.equal(t.snapshots().at(-1)!.room.difficulty, 2);
        assert.ok(t.snapshots().at(-1)!.taunt, "the start comes with a taunt");

        t.send({ type: "round.start", board: BOARD });
        assert.equal(t.results().at(-1)!.code, "busy");
    });

    it("records a find once, replays a retried requestId, and flags a changed retry", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const round = t.live();
        const [a, b] = round.targets;

        t.send({ type: "find.claim", requestId: "c1", roundId: round.id, targetId: a.id });
        t.send({ type: "find.claim", requestId: "c1", roundId: round.id, targetId: a.id });
        t.send({ type: "find.claim", requestId: "c1", roundId: round.id, targetId: b.id });
        t.send({ type: "find.claim", requestId: "c2", roundId: round.id, targetId: a.id });
        t.send({ type: "find.claim", requestId: "c3", roundId: "old-round", targetId: a.id });
        assert.deepEqual(
            t.results().slice(-5).map((r) => r.code),
            ["ok", "ok", "request-conflict", "taken", "stale"]
        );
        assert.equal(t.live().finds.length, 1);
        assert.deepEqual(t.snapshots().at(-1)!.room.league, [{ playerId: "p1", playerName: "Ana", finds: 1, roundsWon: 0 }]);
    });

    it("ends the round when everything is found and credits the finder", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const round = t.live();
        for (const target of round.targets) t.send({ type: "find.claim", roundId: round.id, targetId: target.id });
        const ended = t.current();
        assert.equal(ended?.status === "ended" && ended.reason, "all-found");
        assert.equal(t.snapshots().at(-1)!.room.difficulty, 1);
        assert.equal(t.snapshots().at(-1)!.room.nextDifficulty, 2);
        assert.equal(t.snapshots().at(-1)!.room.league[0].roundsWon, 1);
        assert.ok(t.snapshots().at(-1)!.taunt);

        t.send({ type: "find.claim", roundId: round.id, targetId: round.targets[0].id });
        assert.equal(t.results().at(-1)!.code, "not-live", "a round that ended early did not expire");
    });

    it("ends the round at its deadline, however late the timer runs", async () => {
        const t = setup(3);
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const { endsAt } = t.live();
        t.advance(roundDurationMs(3) + 5_000);
        const ended = t.current();
        assert.equal(ended?.status, "ended");
        assert.equal(ended?.status === "ended" && ended.reason, "time-up");
        assert.equal(ended?.status === "ended" && ended.endedAt, endsAt);
        assert.equal(t.snapshots().at(-1)!.room.difficulty, 3);
        assert.equal(t.snapshots().at(-1)!.room.nextDifficulty, 3);

        t.send({ type: "find.claim", roundId: ended!.id, targetId: `${ended!.id}:0` });
        assert.equal(t.results().at(-1)!.code, "expired");
    });

    it("plants the next round from a board offer and promotes it on the next start", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const first = t.live();
        t.send({ type: "board.offer", afterRoundId: first.id, board: BOARD });
        assert.equal(t.results().at(-1)!.code, "ok");
        const next = t.snapshots().at(-1)!.room.next;
        assert.equal(next?.status, "ready");
        for (const target of first.targets) t.send({ type: "find.claim", roundId: first.id, targetId: target.id });
        t.send({ type: "round.start", board: BOARD });
        assert.equal(t.live().id, next!.id);
        assert.equal(t.live().targets.length, targetCount(2));
    });

    it("lets the difficulty change only between rounds", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        t.send({ type: "difficulty.set", value: 4 });
        assert.equal(t.results().at(-1)!.code, "busy");
        t.send({ type: "round.cancel", roundId: t.live().id });
        t.send({ type: "difficulty.set", value: 4 });
        assert.equal(t.results().at(-1)!.code, "ok");
        assert.equal(t.snapshots().at(-1)!.room.nextDifficulty, 4);
    });

    it("refuses a claim on a cancelled round as not live", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        const round = t.live();
        t.send({ type: "round.cancel", roundId: round.id });
        t.send({ type: "find.claim", roundId: round.id, targetId: round.targets[0].id });
        assert.equal(t.results().at(-1)!.code, "not-live");
    });

    it("tops out at level 4: six targets in 30 seconds, and all found stays at 4", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "difficulty.set", value: 4 });
        t.send({ type: "round.start", board: BOARD });
        const round = t.live();
        assert.equal(round.targets.length, 6);
        assert.equal(round.endsAt - round.startedAt, 30_000);
        for (const target of round.targets) t.send({ type: "find.claim", roundId: round.id, targetId: target.id });
        assert.equal(t.snapshots().at(-1)!.room.difficulty, 4);
        assert.equal(t.snapshots().at(-1)!.room.nextDifficulty, 4);
    });

    it("speaks only valid protocol messages", async () => {
        const t = setup();
        await t.open();
        t.send({ type: "round.start", board: BOARD });
        for (const target of t.live().targets) t.send({ type: "find.claim", roundId: t.live().id, targetId: target.id });
        t.send({ type: "round.start", board: BOARD });
        t.advance(60_000);
        for (const message of t.messages) assert.equal(isServerMessage(message), true, JSON.stringify(message));
    });
});
