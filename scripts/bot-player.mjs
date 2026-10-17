// A test bot for the race: a second player on its own connection, so one browser can race a rival.
// It joins by join token, claims targets on a schedule, and logs what the room answers. It is a test
// tool with fixed rules: it reads each snapshot and sends find.claim, and it never starts, cancels or
// changes a round.
// Usage: node scripts/bot-player.mjs --token <64-hex joinToken> [--backend URL] [--name Ben]
//   [--color #2563eb] [--id bot-ben] [--first 8] [--every 7] [--max 2] [--rounds N]

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRemoteHost } from "../src/driver/remote-host.ts";
import { deriveRoomId, PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { roundStandings } from "../src/shared/standings.ts";

const DEFAULT_BACKEND = "https://its-in-there-room.mingrath.workers.dev";
const USAGE =
    "usage: node scripts/bot-player.mjs --token <64-hex joinToken> [--backend URL] [--name Ben] " +
    "[--color #2563eb] [--id bot-ben] [--first 8] [--every 7] [--max 2] [--rounds N]";
const FLAGS = ["token", "backend", "name", "color", "id", "first", "every", "max", "rounds"];
const TOKEN = /^[0-9a-f]{64}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SECONDS = /^\d+(\.\d+)?$/;
const COUNT = /^[1-9]\d*$/;
/** Why the bot stops for each room refusal that will not change on retry. */
const FATAL = {
    auth: "the room refused the join token",
    version: "the room speaks another protocol version",
    full: "the room's league is full, and a full league never frees a place",
    invalid: "the room rejected this bot's messages",
    timeout: "the room did not answer within 15 s",
};

const isHttpUrl = (text) => {
    try {
        return ["http:", "https:"].includes(new URL(text).protocol);
    } catch {
        return false;
    }
};
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function parseArgs(argv) {
    const given = new Map();
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (!flag.startsWith("--") || !FLAGS.includes(flag.slice(2))) throw new Error(`unknown option ${flag}`);
        if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
        given.set(flag.slice(2), value);
    }
    const pick = (key, fallback, pattern, what) => {
        const text = given.get(key);
        if (text === undefined) return fallback;
        if (!pattern.test(text)) throw new Error(`--${key} must be ${what}`);
        return Number(text);
    };
    const token = given.get("token");
    if (token === undefined) throw new Error("--token is required");
    if (!TOKEN.test(token)) throw new Error("--token must be 64 lowercase hex characters");
    const name = given.get("name") ?? "Test bot";
    if (!NAME.test(name)) throw new Error("--name must be 1 to 64 characters with no control characters");
    const color = given.get("color") ?? "#2563eb";
    if (!COLOR.test(color)) throw new Error("--color must be a #rrggbb colour");
    const id = given.get("id") ?? `bot-${slug(name)}`;
    if (!ID.test(id)) throw new Error("--id must be 1 to 128 letters, digits, colons, underscores or dashes");
    const backend = given.get("backend") ?? DEFAULT_BACKEND;
    if (!isHttpUrl(backend)) throw new Error("--backend must be an http:// or https:// URL");
    return {
        token,
        backend,
        name,
        color,
        id,
        first: pick("first", 8, SECONDS, "a number of seconds, zero or more"),
        every: pick("every", 7, SECONDS, "a number of seconds, zero or more"),
        max: pick("max", 2, COUNT, "a whole number, one or more"),
        rounds: pick("rounds", null, COUNT, "a whole number, one or more"),
    };
}

/** The first target in round order that nobody has found and this bot has not claimed. Null unless the round is live. */
export function pickTarget(round, claimed) {
    if (round?.status !== "live") return null;
    const found = new Set(round.finds.map((find) => find.targetId));
    return round.targets.find((target) => !found.has(target.id) && !claimed.has(target.id)) ?? null;
}

/**
 * The server-clock time of this bot's next claim in the round, or null when it makes none. Claims are
 * anchored to the round's start, not to when this bot heard about it, so a late joiner catches up at once.
 */
export function nextClaimAt(round, plan, progress) {
    if (progress.sent >= plan.max || pickTarget(round, progress.claimed) === null) return null;
    const at = round.startedAt + Math.round((plan.first + progress.sent * plan.every) * 1000);
    return at < round.endsAt ? at : null;
}

/** Milliseconds from this machine's clock until a server-clock time, when the server runs `offset` ms ahead. */
export const waitMs = (serverAt, offset, localNow) => Math.max(0, serverAt - (localNow + offset));

/** Records each round's status, and says whether this snapshot ends a round the bot saw live. */
export function endsSeenRound(seen, round) {
    if (!round) return false;
    const was = seen.get(round.id);
    seen.set(round.id, round.status);
    return round.status === "ended" && was === "live";
}

/** The bot leaves once its --rounds rounds have ended and its last claim is answered, so that answer still gets logged. */
export const mayLeave = (rounds, roundsEnded, pendingClaims) => rounds !== null && roundsEnded >= rounds && pendingClaims === 0;

/** The snapshot's taunt, when its publication is newer than the last taunt logged. */
export const newTaunt = (snapshot, lastRevision) =>
    snapshot.taunt !== null && snapshot.revision > lastRevision ? snapshot.taunt : null;

const roundText = (round) => {
    if (round === null) return "no round yet";
    if (round.status === "planting" || round.status === "ready") return `${round.status} ${round.id.slice(0, 8)}`;
    const standings = roundStandings(round.finds)
        .rows.map((row) => `${row.name} ${row.finds}`)
        .join(", ");
    const head = round.status === "live" ? "live" : `ended (${round.reason})`;
    const who = standings === "" ? "" : ` (${standings})`;
    return `${head} ${round.id.slice(0, 8)}, ${round.finds.length} of ${round.targets.length} found${who}`;
};

/** One line per snapshot: the round, who found what in it, and the league's totals. */
export function describeSnapshot(snapshot) {
    const { room } = snapshot;
    const league =
        room.league.length === 0
            ? "nobody yet"
            : room.league
                  .map((e) => `${e.playerName} ${plural(e.finds, "find", "finds")}, ${plural(e.roundsWon, "round", "rounds")} won`)
                  .join("; ");
    return `snapshot r${snapshot.revision}: ${roundText(room.current)}. league: ${league}`;
}

const pad = (n, width = 2) => String(n).padStart(width, "0");
const stamp = () => {
    const now = new Date();
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};
const say = (line) => console.log(`${stamp()} ${line}`);

/** Joins the room and claims on schedule until a signal arrives or --rounds rounds have ended. Resolves to the exit code. */
export function play(options) {
    const roomId = deriveRoomId(options.token);
    const plan = { first: options.first, every: options.every, max: options.max };
    const runId = randomUUID();
    const host = createRemoteHost({ backendUrl: options.backend, roomId });
    return new Promise((resolve) => {
        let finished = false;
        let latest = null; // the newest snapshot
        let offset = 0; // the server's clock minus this machine's, as of the newest snapshot
        let progress = { roundId: null, sent: 0, claimed: new Set() };
        let timer = null;
        let seq = 0;
        let tauntRevision = 0;
        let roundsEnded = 0;
        const pending = new Map(); // requestId -> targetId, until its result arrives
        const seen = new Map();

        const finish = (code, line) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            say(line);
            host.close();
            resolve(code);
        };

        // Picks the target at fire time, from the newest snapshot, so a find that landed meanwhile is skipped.
        const fire = () => {
            timer = null;
            const round = latest.room.current;
            const target = pickTarget(round, progress.claimed);
            if (target !== null) {
                const requestId = `${runId}-${seq++}`;
                progress.claimed.add(target.id);
                progress.sent++;
                pending.set(requestId, target.id);
                const sent = host.send({ v: PROTOCOL_VERSION, requestId, type: "find.claim", roundId: round.id, targetId: target.id });
                if (!sent) {
                    pending.delete(requestId);
                    say(`claim ${target.id} was not sent`);
                }
            }
            arm();
        };

        const leaveIfDone = () => {
            if (!mayLeave(options.rounds, roundsEnded, pending.size)) return false;
            finish(0, `${plural(roundsEnded, "round", "rounds")} ended; leaving the room`);
            return true;
        };

        const arm = () => {
            clearTimeout(timer);
            timer = null;
            const at = nextClaimAt(latest?.room.current ?? null, plan, progress);
            if (at !== null) timer = setTimeout(fire, waitMs(at, offset, Date.now()));
        };

        const onSnapshot = (snapshot) => {
            latest = snapshot;
            offset = snapshot.serverNow - Date.now();
            const round = snapshot.room.current;
            if (round !== null && round.id !== progress.roundId) progress = { roundId: round.id, sent: 0, claimed: new Set() };
            say(describeSnapshot(snapshot));
            const taunt = newTaunt(snapshot, tauntRevision);
            if (taunt !== null) {
                tauntRevision = snapshot.revision;
                say(`taunt: ${taunt}`);
            }
            if (endsSeenRound(seen, round)) roundsEnded++;
            if (leaveIfDone()) return;
            arm();
        };

        const onResult = (result) => {
            const targetId = pending.get(result.requestId) ?? "?";
            pending.delete(result.requestId);
            say(`claim ${targetId} -> ${result.code} (r${result.revision})`);
            leaveIfDone();
        };

        const receive = (message) => {
            if (message.type === "snapshot") return onSnapshot(message);
            if (message.type === "result") return onResult(message);
            // rate-limit and unavailable come back on their own; the host dials again.
            if (message.code === "rate-limit" || message.code === "unavailable") return say(`room said ${message.code}; retrying`);
            finish(1, `stopped: ${FATAL[message.code] ?? message.code}`);
        };

        say(
            `joining room ${roomId.slice(0, 8)} as ${options.name} (${options.id}) at ${options.backend}: ` +
                `claims at ${plan.first} s, then every ${plan.every} s, at most ${plan.max} per round`,
        );
        host
            .open({ v: PROTOCOL_VERSION, type: "hello", roomId, joinToken: options.token, player: { playerId: options.id, name: options.name, color: options.color } }, receive)
            .catch((error) => finish(1, `stopped: ${FATAL[error.code] ?? error.message}`));
        process.once("SIGINT", () => finish(0, "stopped by SIGINT"));
        process.once("SIGTERM", () => finish(0, "stopped by SIGTERM"));
    });
}

export function main(argv) {
    if (argv.includes("--help")) {
        console.log(USAGE);
        return Promise.resolve(0);
    }
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        console.error(`bot-player: ${error.message}\n${USAGE}`);
        return Promise.resolve(2);
    }
    return play(options);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
