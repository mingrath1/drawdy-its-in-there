// Two-player race against a local Worker: a scripted Ana and the test bot (scripts/bot-player.mjs) as Ben.
// Round 1 (level 2, 4 targets) should end in a dead heat; round 2 (5 targets) in Ana's win with a rematch nudge for Ben.
// Usage: node scripts/race-check.mjs <checkout> <backendUrl>, e.g. node scripts/race-check.mjs . http://127.0.0.1:8792
// after `cd server && npx wrangler dev --port 8792 --local`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const [checkout, backendUrl] = process.argv.slice(2);
const { createRemoteHost } = await import(pathToFileURL(`${checkout}/src/driver/remote-host.ts`).href);
const { deriveRoomId, PROTOCOL_VERSION } = await import(pathToFileURL(`${checkout}/src/shared/protocol.ts`).href);

const t0 = Date.now();
const out = (line) => process.stdout.write(`[+${String(Date.now() - t0).padStart(5)} ms] ${line}\n`);
let failures = 0;
const check = (ok, what) => {
    out(`${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures++;
};

const joinToken = randomBytes(32).toString("hex");
const roomId = deriveRoomId(joinToken);
out(`backend ${backendUrl}, room ${roomId.slice(0, 12)}…`);

const bot = spawn(process.execPath, [`${checkout}/scripts/bot-player.mjs`, "--token", joinToken, "--backend", backendUrl,
    "--name", "Ben", "--id", "bot-ben", "--color", "#2563eb", "--first", "3", "--every", "3", "--max", "2", "--rounds", "2"]);
const botExit = new Promise((resolve) => bot.on("exit", resolve));
bot.stdout.on("data", (d) => String(d).trim().split("\n").forEach((l) => out(`[bot] ${l}`)));
bot.stderr.on("data", (d) => String(d).trim().split("\n").filter((l) => !l.startsWith("[iit]")).forEach((l) => out(`[bot err] ${l}`)));

console.log = () => {};
const host = createRemoteHost({ backendUrl, roomId });
const messages = [];
const waiters = [];
const taunts = [];
let seq = 0;
let lastTauntRev = 0;
const deliver = (m) => {
    messages.push(m);
    if (m.type === "snapshot" && m.taunt && m.revision > lastTauntRev) {
        lastTauntRev = m.revision;
        taunts.push(m.taunt);
        out(`[ana] taunt r${m.revision}: ${m.taunt}`);
    }
    for (const w of [...waiters]) if (w.match(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
};
const until = (match, what, ms = 60_000) => {
    const seen = messages.findLast(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waited ${ms} ms for ${what}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
};
const send = async (command) => {
    const requestId = `ana-${seq++}`;
    host.send({ v: PROTOCOL_VERSION, requestId, ...command });
    const result = await until((m) => m.type === "result" && m.requestId === requestId, requestId);
    out(`[ana] ${command.type}${command.targetId ? ` ${command.targetId.slice(-2)}` : ""} -> ${result.code}`);
    return result;
};
const latest = () => messages.findLast((m) => m.type === "snapshot");
const round = () => latest().room.current;
const benFinds = (id, n) => (m) => m.type === "snapshot" && m.room.current?.id === id && m.room.current.finds.filter((f) => f.playerId === "bot-ben").length >= n;
const lastUnfound = () => {
    const r = round();
    const found = new Set(r.finds.map((f) => f.targetId));
    return [...r.targets].reverse().find((t) => !found.has(t.id));
};
const claimLast = () => send({ type: "find.claim", roundId: round().id, targetId: lastUnfound().id });

await host.open({ v: PROTOCOL_VERSION, type: "hello", roomId, joinToken, player: { playerId: "e2e-ana", name: "Ana", color: "#e11d48" } }, deliver);
await until((m) => m.type === "snapshot" && m.room.league.some((e) => e.playerId === "bot-ben"), "Ben in the league");

const board = {
    frameRect: { x: 0, y: 0, width: 1200, height: 800 },
    items: [0, 1, 2, 3, 4].map((i) => {
        const x = 60 + i * 220;
        return { rect: { x, y: 200, width: 150, height: 160 }, kind: "freedraw", strokeColor: "#e4e4e7", strokeWidth: 2,
            points: Array.from({ length: 14 }, (_, k) => [x + k * 10, 200 + (k % 2) * 160]) };
    }),
};
const startRound = async () => {
    check((await send({ type: "round.start", board })).code === "ok", "round.start answered ok");
    const live = await until((m) => m.type === "snapshot" && m.room.current?.status === "live", "a live round");
    return live.room.current;
};
const tauntsSince = (n) => taunts.slice(n);

// Round 1: Ana 1, Ben ties, Ben takes the lead, Ana ties it on the last target: a dead heat.
check((await send({ type: "difficulty.set", value: 2 })).code === "ok", "difficulty set to 2");
let mark = taunts.length;
const r1 = await startRound();
check(r1.targets.length === 4, `round 1 hides 4 targets (got ${r1.targets.length})`);
await claimLast();
await until(benFinds(r1.id, 2), "Ben's 2 finds in round 1");
await claimLast();
const end1 = await until((m) => m.type === "snapshot" && m.room.current?.id === r1.id && m.room.current.status === "ended", "round 1 end");
await new Promise((r) => setTimeout(r, 300));
let said = tauntsSince(mark);
check(said.some((t) => t.startsWith("Ben ") && /ties it up|is level now/.test(t)), "round 1: a taunt names Ben tying it up");
check(said.some((t) => t.startsWith("Ben ") && /takes the lead|is out front/.test(t)), "round 1: a taunt names Ben taking the lead");
check(/Dead heat|Dead level/.test(said.at(-1)), `round 1 ends on the dead-heat line: ${said.at(-1)}`);
const won1 = Object.fromEntries(end1.room.league.map((e) => [e.playerName, e.roundsWon]));
check(won1.Ana === 1 && won1.Ben === 1, `a tie counts as a round won for both: ${JSON.stringify(won1)}`);

// Round 2: Ana 1, Ben ties, Ana's claim on Ben's find is taken, Ben takes the lead, Ana ties, Ana wins.
mark = taunts.length;
const r2 = await startRound();
check(r2.targets.length === 5, `round 2 is one level up: 5 targets (got ${r2.targets.length})`);
await claimLast();
const benFirst = await until(benFinds(r2.id, 1), "Ben's first find in round 2");
const bensTarget = benFirst.room.current.finds.find((f) => f.playerId === "bot-ben").targetId;
check((await send({ type: "find.claim", roundId: r2.id, targetId: bensTarget })).code === "taken", "Ana circling Ben's find is answered taken");
await until(benFinds(r2.id, 2), "Ben's 2 finds in round 2");
await claimLast();
await claimLast();
const end2 = await until((m) => m.type === "snapshot" && m.room.current?.id === r2.id && m.room.current.status === "ended", "round 2 end");
await new Promise((r) => setTimeout(r, 300));
said = tauntsSince(mark);
check(said.some((t) => t.startsWith("Ana ") && /ties it up|is level now/.test(t)), "round 2: a taunt names Ana tying it up");
check(/^Ben (ขอแก้มือไหม|ไปต่อไหม)/.test(said.at(-1)), `round 2 ends on a rematch nudge for Ben: ${said.at(-1)}`);
const won2 = Object.fromEntries(end2.room.league.map((e) => [e.playerName, e.roundsWon]));
check(won2.Ana === 2 && won2.Ben === 1, `Ana's win is counted: ${JSON.stringify(won2)}`);

const code = await botExit;
check(code === 0, `the test bot left on its own after 2 rounds (exit ${code})`);
host.close();
out(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
