import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
    describeSnapshot,
    endsSeenRound,
    nextClaimAt,
    newTaunt,
    parseArgs,
    pickTarget,
    waitMs,
} from "./bot-player.mjs";

const BOT = fileURLToPath(new URL("./bot-player.mjs", import.meta.url));
const TOKEN = "ab".repeat(32);
const BASE = ["--token", TOKEN];
const ROUND_ID = "1a2b3c4d-0000-4000-8000-000000000000";
const PLAN = { first: 8, every: 7, max: 2 };
const nothingClaimed = () => ({ sent: 0, claimed: new Set() });

const target = (id) => ({
    id,
    stampId: "cat",
    rect: { x: 0, y: 0, width: 80, height: 80 },
    rotationDeg: 0,
    strokeColor: "#18181b",
    strokeWidth: 2,
});
const found = (targetId, playerId, playerName, at = 2_000) => ({
    targetId,
    playerId,
    playerName,
    playerColor: "#2563eb",
    at,
});
const live = (targetIds, finds = [], { startedAt = 1_000, endsAt = 61_000 } = {}) => ({
    status: "live",
    id: ROUND_ID,
    frameRect: { x: 0, y: 0, width: 800, height: 600 },
    targets: targetIds.map(target),
    startedAt,
    endsAt,
    finds,
});

test("parseArgs reads every flag", () => {
    const options = parseArgs([
        "--token", TOKEN,
        "--backend", "http://127.0.0.1:8791",
        "--name", "Ben",
        "--color", "#2563eb",
        "--id", "bot-ben",
        "--first", "8",
        "--every", "7",
        "--max", "2",
        "--rounds", "3",
    ]);
    assert.deepEqual(options, {
        token: TOKEN,
        backend: "http://127.0.0.1:8791",
        name: "Ben",
        color: "#2563eb",
        id: "bot-ben",
        first: 8,
        every: 7,
        max: 2,
        rounds: 3,
    });
});

test("parseArgs fills the defaults, and derives the id from the name", () => {
    assert.deepEqual(parseArgs(BASE), {
        token: TOKEN,
        backend: "https://its-in-there-room.mingrath.workers.dev",
        name: "Test bot",
        color: "#2563eb",
        id: "bot-test-bot",
        first: 8,
        every: 7,
        max: 2,
        rounds: null,
    });
    assert.equal(parseArgs([...BASE, "--name", "Ben"]).id, "bot-ben");
});

test("parseArgs needs a 64-character lowercase hex token", () => {
    assert.throws(() => parseArgs([]), /--token is required/);
    assert.throws(() => parseArgs(["--token", "ab".repeat(31)]), /64 lowercase hex/);
    assert.throws(() => parseArgs(["--token", "AB".repeat(32)]), /64 lowercase hex/);
    assert.throws(() => parseArgs(["--token", "zz".repeat(32)]), /64 lowercase hex/);
});

test("parseArgs accepts only http and https backends", () => {
    assert.throws(() => parseArgs([...BASE, "--backend", "ws://127.0.0.1:8791"]), /--backend/);
    assert.throws(() => parseArgs([...BASE, "--backend", "not a url"]), /--backend/);
});

test("parseArgs rejects pacing that cannot work", () => {
    assert.throws(() => parseArgs([...BASE, "--first", "-1"]), /--first/);
    assert.throws(() => parseArgs([...BASE, "--every", "-1"]), /--every/);
    assert.throws(() => parseArgs([...BASE, "--max", "0"]), /--max/);
    assert.throws(() => parseArgs([...BASE, "--max", "1.5"]), /--max/);
    assert.throws(() => parseArgs([...BASE, "--rounds", "0"]), /--rounds/);
});

test("parseArgs rejects unknown flags, flags without a value, and names the room cannot take", () => {
    assert.throws(() => parseArgs([...BASE, "--speed", "9"]), /unknown option --speed/);
    assert.throws(() => parseArgs([...BASE, "--max"]), /--max needs a value/);
    assert.throws(() => parseArgs([...BASE, "--name", "Ben\nBen"]), /--name/);
    assert.throws(() => parseArgs([...BASE, "--color", "blue"]), /--color/);
    assert.throws(() => parseArgs([...BASE, "--id", "bot ben"]), /--id/);
});

test("the CLI prints usage and exits 2 on a bad token, and 0 for --help", () => {
    const bad = spawnSync(process.execPath, [BOT, "--token", "nope"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--token must be 64 lowercase hex/);
    assert.match(bad.stderr, /usage: node scripts\/bot-player\.mjs/);
    const help = spawnSync(process.execPath, [BOT, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage: node scripts\/bot-player\.mjs/);
});

test("pickTarget takes the first target in round order that nobody has found", () => {
    const round = live(["t1", "t2", "t3"], [found("t1", "ana", "Ana")]);
    assert.equal(pickTarget(round, new Set()).id, "t2");
});

test("pickTarget skips the targets this bot already claimed", () => {
    const round = live(["t1", "t2", "t3"], [found("t2", "ana", "Ana")]);
    assert.equal(pickTarget(round, new Set(["t1"])).id, "t3");
});

test("pickTarget returns null when every target is found or claimed", () => {
    const round = live(["t1", "t2"], [found("t1", "ana", "Ana")]);
    assert.equal(pickTarget(round, new Set(["t2"])), null);
});

test("pickTarget returns null unless the round is live", () => {
    const planting = { status: "planting", id: ROUND_ID, frameRect: { x: 0, y: 0, width: 800, height: 600 } };
    assert.equal(pickTarget(null, new Set()), null);
    assert.equal(pickTarget(planting, new Set()), null);
    assert.equal(pickTarget({ ...live(["t1"]), status: "ended" }, new Set()), null);
});

test("the first claim is due first seconds after the round starts, on the server clock", () => {
    assert.equal(nextClaimAt(live(["t1", "t2", "t3"]), PLAN, nothingClaimed()), 1_000 + 8_000);
});

test("each later claim is due every seconds after the one before", () => {
    const progress = { sent: 1, claimed: new Set(["t1"]) };
    assert.equal(nextClaimAt(live(["t1", "t2", "t3"]), PLAN, progress), 1_000 + 15_000);
});

test("no claim once the bot has sent max claims this round", () => {
    const progress = { sent: 2, claimed: new Set(["t1", "t2"]) };
    assert.equal(nextClaimAt(live(["t1", "t2", "t3"]), PLAN, progress), null);
});

test("no claim when nothing unfound is left for the bot", () => {
    const round = live(["t1", "t2"], [found("t1", "ana", "Ana")]);
    assert.equal(nextClaimAt(round, PLAN, { sent: 0, claimed: new Set(["t2"]) }), null);
});

test("no claim at or after the round's end", () => {
    assert.equal(nextClaimAt(live(["t1"], [], { endsAt: 9_000 }), PLAN, nothingClaimed()), null);
    assert.equal(nextClaimAt(live(["t1"], [], { endsAt: 9_001 }), PLAN, nothingClaimed()), 9_000);
});

test("no claim unless the round is live", () => {
    assert.equal(nextClaimAt(null, PLAN, nothingClaimed()), null);
    assert.equal(nextClaimAt({ ...live(["t1"]), status: "ended" }, PLAN, nothingClaimed()), null);
});

test("fractional seconds are allowed", () => {
    const progress = { sent: 1, claimed: new Set(["t1"]) };
    assert.equal(nextClaimAt(live(["t1", "t2"]), { first: 0.5, every: 0.25, max: 2 }, progress), 1_000 + 750);
});

test("waitMs counts down to a server-clock time from this machine's clock", () => {
    assert.equal(waitMs(9_000, 0, 4_000), 5_000);
});

test("a server clock ahead of this machine's clock shortens the wait", () => {
    // The server is 2 s ahead: at local 4 s it reads 6 s, so 9 s on the server is 3 s away.
    assert.equal(waitMs(9_000, 2_000, 4_000), 3_000);
});

test("a due time already past is due now", () => {
    assert.equal(waitMs(9_000, 0, 20_000), 0);
});

test("a round that goes from live to ended counts once", () => {
    const seen = new Map();
    const ended = { ...live(["t1"]), status: "ended" };
    assert.equal(endsSeenRound(seen, live(["t1"])), false);
    assert.equal(endsSeenRound(seen, ended), true);
    assert.equal(endsSeenRound(seen, ended), false);
});

test("a round first seen already ended does not count", () => {
    assert.equal(endsSeenRound(new Map(), { ...live(["t1"]), status: "ended" }), false);
});

test("no round counts nothing", () => {
    assert.equal(endsSeenRound(new Map(), null), false);
});

const snapshotOf = (current, league = []) => ({
    v: 1,
    type: "snapshot",
    revision: 12,
    serverNow: 5_000,
    self: "bot-ben",
    room: { roomId: "room", difficulty: 1, nextDifficulty: 2, league, current, next: null, roundsPlayed: 1 },
    taunt: null,
});

test("describeSnapshot names the live round, its finds and the league", () => {
    const current = live(["t1", "t2", "t3"], [found("t1", "ana", "Ana"), found("t2", "ana", "Ana", 3_000)]);
    const league = [
        { playerId: "ana", playerName: "Ana", finds: 2, roundsWon: 1 },
        { playerId: "bot-ben", playerName: "Ben", finds: 0, roundsWon: 0 },
    ];
    assert.equal(
        describeSnapshot(snapshotOf(current, league)),
        "snapshot r12: live 1a2b3c4d, 2 of 3 found (Ana 2). league: Ana 2 finds, 1 round won; Ben 0 finds, 0 rounds won",
    );
});

test("describeSnapshot names an ended round by its reason and says when nobody is listed", () => {
    const ended = { ...live(["t1", "t2"], [found("t1", "ana", "Ana"), found("t2", "ben", "Ben")]), status: "ended", reason: "all-found", endedAt: 20_000 };
    assert.equal(
        describeSnapshot(snapshotOf(ended)),
        "snapshot r12: ended (all-found) 1a2b3c4d, 2 of 2 found (Ana 1, Ben 1). league: nobody yet",
    );
    assert.equal(describeSnapshot(snapshotOf(null)), "snapshot r12: no round yet. league: nobody yet");
});

test("newTaunt reports a taunt once, when its publication is newer than the last one logged", () => {
    const snap = (revision, taunt) => ({ revision, taunt });
    assert.equal(newTaunt(snap(12, null), 11), null);
    assert.equal(newTaunt(snap(12, "Spotted!"), 11), "Spotted!");
    assert.equal(newTaunt(snap(12, "Spotted!"), 12), null);
});
