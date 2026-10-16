# It's In There! — Wire Protocol & Room Design (Muse)

Trust model in one line: board collaborators are trusted, outsiders are not. The token keeps a public URL from being a public room; it does not stop a collaborator cheating (see Risk 1).

## 1. `src/shared/protocol.ts`

```ts
// Wire protocol: driver (Drawdy worker, origin null) <-> one Room DO per hunt frame.
// No imports except ./hunt.ts types; no packages (driver bundle rule). Hand-rolled validation.
import type { BoardSnapshot, Find, LeagueEntry, PlayerId, Rect, Room as RoomState, Round, Target } from "./hunt.ts";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_CHARS = 262_144; // WS frame cap; board.offer is the big one
export const MAX_BOARD_ITEMS = 2_000, MAX_POINTS = 512, MAX_STAMPS = 32;
export const DEFAULT_ROUND_MS = 90_000, MIN_ROUND_MS = 30_000, MAX_ROUND_MS = 300_000;
type V = typeof PROTOCOL_VERSION;

export type PlayerInfo = { id: PlayerId; name: string; color: string };
export type Snapshot = { room: RoomState; players: PlayerInfo[] };
export type Err = { code: ErrorCode; message: string };
export type ErrorCode = "bad_frame" | "unsupported_version" | "unauthenticated" | "bad_token" | "room_exists"
  | "not_joined" | "rate_limited" | "round_live" | "round_planting" | "no_live_round" | "round_mismatch"
  | "target_taken" | "target_unknown" | "bad_difficulty" | "internal";

export type ClientMsg =
  | { v: V; type: "hello"; requestId: string; createIfMissing: boolean; joinToken: string; player: PlayerInfo }
  | { v: V; type: "round.start"; requestId: string; board: BoardSnapshot; durationMs?: number }
  | { v: V; type: "board.offer"; requestId: string; board: BoardSnapshot; stampIds: string[] }
  | { v: V; type: "find.claim"; requestId: string; roundId: string; targetId: string }
  | { v: V; type: "difficulty.set"; requestId: string; difficulty: number }
  | { v: V; type: "ping"; t: number };

export type ServerMsg =
  | { v: V; type: "welcome"; requestId: string; playerId: PlayerId; seq: number; serverNow: number; snapshot: Snapshot }
  | { v: V; type: "snapshot"; seq: number; serverNow: number; snapshot: Snapshot }
  | { v: V; type: "result"; requestId: string; command: Retriable["type"]; ok: true; seq: number }
  | { v: V; type: "result"; requestId: string; command: Retriable["type"]; ok: false; seq: number; error: Err }
  | { v: V; type: "taunt"; roundId: string; text: string }
  | { v: V; type: "pong"; t: number; serverNow: number }
  | { v: V; type: "error"; error: Err; requestId?: string };

/** Mutating commands: carried in the driver outbox and replayed with their original requestId. */
export type Retriable = Extract<ClientMsg, { type: "round.start" | "board.offer" | "find.claim" | "difficulty.set" }>;
export const isRetriable = (m: ClientMsg): m is Retriable => m.type !== "hello" && m.type !== "ping";

/** Implemented by RemoteHost (WebSocket + outbox) and LocalHost (offline, §5). Driver code sees only this. */
export interface HuntHost {
  send(msg: ClientMsg): void;
  subscribe(cb: (msg: ServerMsg) => void): () => void;
  close(): void;
}

export class ProtocolError extends Error {}
const fail = (m: string): never => { throw new ProtocolError(m); };
const rec = (x: unknown): Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : fail("expected object");
const str = (x: unknown, name: string, max = 128): string =>
  typeof x === "string" && x.length >= 1 && x.length <= max ? x : fail(`${name}: string 1..${max}`);
const optStr = (x: unknown, name: string, max = 128): string | undefined => (x === undefined ? undefined : str(x, name, max));
const num = (x: unknown, name: string): number =>
  typeof x === "number" && Number.isFinite(x) ? x : fail(`${name}: finite number`);
const int = (x: unknown, name: string, lo: number, hi: number): number =>
  Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi ? (x as number) : fail(`${name}: int ${lo}..${hi}`);
const bool = (x: unknown, name: string): boolean => (typeof x === "boolean" ? x : fail(`${name}: boolean`));
const arr = (x: unknown, name: string, max: number): unknown[] =>
  Array.isArray(x) && x.length <= max ? x : fail(`${name}: array <=${max}`);

const parseRect = (x: unknown): Rect => { const r = rec(x); return { x: num(r.x, "rect.x"), y: num(r.y, "rect.y"), width: num(r.width, "rect.width"), height: num(r.height, "rect.height") }; };
const parsePoints = (x: unknown): ReadonlyArray<readonly [number, number]> =>
  arr(x, "points", MAX_POINTS).map((p) => { const t = arr(p, "point", 2); return [num(t[0], "pt.x"), num(t[1], "pt.y")] as const; });
const KINDS = new Set(["freedraw", "shape", "text", "image", "line", "other"]);
export const parseBoard = (x: unknown): BoardSnapshot => { const b = rec(x); return { frameRect: parseRect(b.frameRect),
  items: arr(b.items, "board.items", MAX_BOARD_ITEMS).map((i) => { const it = rec(i);
    if (typeof it.kind !== "string" || !KINDS.has(it.kind)) fail("board item kind");
    return { rect: parseRect(it.rect), kind: it.kind as BoardSnapshot["items"][number]["kind"],
      ...(it.strokeColor === undefined ? {} : { strokeColor: str(it.strokeColor, "strokeColor", 64) }),
      ...(it.strokeWidth === undefined ? {} : { strokeWidth: num(it.strokeWidth, "strokeWidth") }),
      ...(it.points === undefined ? {} : { points: parsePoints(it.points) }) }; }) }; };
const parsePlayer = (x: unknown): PlayerInfo => { const p = rec(x);
  return { id: str(p.id, "player.id", 64), name: str(p.name, "player.name", 64), color: str(p.color, "player.color", 32) }; };
const parseTarget = (x: unknown): Target => { const t = rec(x); return { id: str(t.id, "target.id", 64),
  stampId: str(t.stampId, "target.stampId", 64), rect: parseRect(t.rect), rotationDeg: num(t.rotationDeg, "rotationDeg"),
  strokeColor: str(t.strokeColor, "strokeColor", 64), strokeWidth: num(t.strokeWidth, "strokeWidth") }; };
const parseFind = (x: unknown): Find => { const f = rec(x); return { targetId: str(f.targetId, "find.targetId", 64),
  playerId: str(f.playerId, "find.playerId", 64), playerName: str(f.playerName, "find.playerName", 64),
  playerColor: str(f.playerColor, "find.playerColor", 32), at: num(f.at, "find.at") }; };
const parseLeague = (x: unknown): LeagueEntry[] => arr(x, "league", 256).map((e) => { const l = rec(e);
  return { playerId: str(l.playerId, "league.playerId", 64), playerName: str(l.playerName, "league.playerName", 64),
    finds: int(l.finds, "league.finds", 0, 1e9), roundsWon: int(l.roundsWon, "league.roundsWon", 0, 1e9) }; });
const parseRound = (x: unknown): Round => { const r = rec(x); const base = { id: str(r.id, "round.id", 64), frameRect: parseRect(r.frameRect) };
  const targets = () => arr(r.targets, "round.targets", MAX_STAMPS).map(parseTarget);
  const finds = () => arr(r.finds, "round.finds", MAX_STAMPS).map(parseFind);
  switch (r.status) {
    case "planting": return { status: "planting", ...base };
    case "ready": return { status: "ready", ...base, targets: targets() };
    case "live": return { status: "live", ...base, targets: targets(), finds: finds(), startedAt: num(r.startedAt, "startedAt"), endsAt: num(r.endsAt, "endsAt") };
    case "ended": if (r.reason !== "all-found" && r.reason !== "time-up" && r.reason !== "cancelled") fail("round.reason");
      return { status: "ended", ...base, targets: targets(), finds: finds(), startedAt: num(r.startedAt, "startedAt"), endedAt: num(r.endedAt, "endedAt"), reason: r.reason as "all-found" | "time-up" | "cancelled" };
    default: return fail("round.status"); } };
export const parseRoom = (x: unknown): RoomState => { const r = rec(x); return { roomId: str(r.roomId, "roomId", 64),
  difficulty: int(r.difficulty, "difficulty", 1, 5), league: parseLeague(r.league),
  current: r.current === null ? null : parseRound(r.current), next: r.next === null ? null : parseRound(r.next),
  roundsPlayed: int(r.roundsPlayed, "roundsPlayed", 0, 1e9) }; };
const parseSnapshot = (x: unknown): Snapshot => { const s = rec(x);
  return { room: parseRoom(s.room), players: arr(s.players, "players", 256).map(parsePlayer) }; };
const parseErr = (x: unknown): Err => { const e = rec(x); return { code: str(e.code, "error.code", 64) as ErrorCode, message: str(e.message, "error.message", 256) }; };
const reqId = (r: Record<string, unknown>): string => str(r.requestId, "requestId", 128);

function frame(raw: string): Record<string, unknown> {
  if (raw.length > MAX_FRAME_CHARS) fail("frame too large");
  let x: unknown; try { x = JSON.parse(raw); } catch { fail("invalid JSON"); }
  const r = rec(x); if (r.v !== PROTOCOL_VERSION) fail("unsupported_version"); return r; }

export function parseClientMsg(raw: string): ClientMsg { const r = frame(raw); const v = PROTOCOL_VERSION;
  switch (r.type) {
    case "hello": return { v, type: "hello", requestId: reqId(r), createIfMissing: bool(r.createIfMissing, "createIfMissing"), joinToken: str(r.joinToken, "joinToken", 128), player: parsePlayer(r.player) };
    case "round.start": { const m: Extract<ClientMsg, { type: "round.start" }> = { v, type: "round.start", requestId: reqId(r), board: parseBoard(r.board) };
      if (r.durationMs !== undefined) m.durationMs = int(r.durationMs, "durationMs", MIN_ROUND_MS, MAX_ROUND_MS); return m; }
    case "board.offer": return { v, type: "board.offer", requestId: reqId(r), board: parseBoard(r.board), stampIds: arr(r.stampIds, "stampIds", MAX_STAMPS).map((s) => str(s, "stampId", 64)) };
    case "find.claim": return { v, type: "find.claim", requestId: reqId(r), roundId: str(r.roundId, "roundId", 64), targetId: str(r.targetId, "targetId", 64) };
    case "difficulty.set": return { v, type: "difficulty.set", requestId: reqId(r), difficulty: int(r.difficulty, "difficulty", 1, 5) };
    case "ping": return { v, type: "ping", t: num(r.t, "t") };
    default: return fail("unknown client message type"); } }

export function parseServerMsg(raw: string): ServerMsg { const r = frame(raw); const v = PROTOCOL_VERSION;
  switch (r.type) {
    case "welcome": return { v, type: "welcome", requestId: reqId(r), playerId: str(r.playerId, "playerId", 64), seq: int(r.seq, "seq", 0, Number.MAX_SAFE_INTEGER), serverNow: num(r.serverNow, "serverNow"), snapshot: parseSnapshot(r.snapshot) };
    case "snapshot": return { v, type: "snapshot", seq: int(r.seq, "seq", 0, Number.MAX_SAFE_INTEGER), serverNow: num(r.serverNow, "serverNow"), snapshot: parseSnapshot(r.snapshot) };
    case "result": { const cmd = str(r.command, "command", 32) as Retriable["type"]; const seq = int(r.seq, "seq", 0, Number.MAX_SAFE_INTEGER);
      return bool(r.ok, "ok") ? { v, type: "result", requestId: reqId(r), command: cmd, ok: true, seq }
        : { v, type: "result", requestId: reqId(r), command: cmd, ok: false, seq, error: parseErr(r.error) }; }
    case "taunt": return { v, type: "taunt", roundId: str(r.roundId, "roundId", 64), text: str(r.text, "taunt", 200) };
    case "pong": return { v, type: "pong", t: num(r.t, "t"), serverNow: num(r.serverNow, "serverNow") };
    case "error": { const m: Extract<ServerMsg, { type: "error" }> = { v, type: "error", error: parseErr(r.error) };
      const q = optStr(r.requestId, "requestId", 128); if (q !== undefined) m.requestId = q; return m; }
    default: return fail("unknown server message type"); } }

export const encode = (m: ClientMsg | ServerMsg): string => { const s = JSON.stringify(m); if (s.length > MAX_FRAME_CHARS) fail("frame too large"); return s; };
```

Deliberately absent: no circle geometry on `find.claim`, no chat, no per-stroke traffic. The laser subscription is a full visible-set on every pointer-up (DDP ll.1585–96), so the driver dedupes stroke identities locally, runs the shared `JudgeFn` per new stroke against live targets, and only a pass becomes a claim. One claim per (stroke, target).

## 2. Room behaviour

Storage (DO SQLite, from the template): one row `room(roomId, seq, stateJson)`, `receipts(requestId PK, playerId, command, resultJson)`, `meta(key,value)` for `tokenHash`, `plantJobJson`. Every mutation runs inside one storage transaction under a single in-DO serial queue (the template's `KeyedSerialQueue`, keyed globally, not per-socket — see §4), increments persisted `seq`, then broadcasts one `snapshot`. Clients ignore `seq <= lastSeq`.

| Message | Rule |
|---|---|
| `hello` | Must be first frame within 5 s, else close 1008. Creates or authenticates (§3). Reply is `welcome` carrying the full snapshot; nothing else is sent before it. Connection attachment (hibernation-safe, like template `serializeAttachment`) stores only `player`. |
| `round.start` | Any joined player, only when nothing is live. If `next` is `ready`: promote it (`startedAt=now`, `endsAt=now+clamp(durationMs ?? DEFAULT)`, `finds=[]`), set alarm (§timers), and treat the supplied `board` as the pre-plant source for the following round. If `next` is null and `current` is null/`ended`: create `current={planting}` and plant from this board; on plant success it goes `ready` then immediately `live` (the start was already requested). If `next` is `planting`: `result ok:false round_planting`. If live: `round_live`. |
| `board.offer` | Any joined player. Accepted only while a round is live and `next===null`: creates `next={planting}` and starts the plant job (§below). First offer wins; later offers get `ok:true seq` with no effect (idempotent no-op, not an error — every driver's client offers on seeing `round.live`, so racing offers are normal). Outside live: `no_live_round`. |
| `find.claim` | Only while `current.status==="live"`, `roundId===current.id`, target exists. First committed claim per target wins; the finder is taken from the connection attachment, never from the payload. On win: append `Find{at: serverNow}`, `league[finder].finds++`, broadcast snapshot (drivers diff `finds` to burst the marker in `playerColor` via `LocalAnimation` on their own scene marker and to strike the preview target). If all targets found, end the round in the same transaction. Losers: `result ok:false target_taken` + fresh snapshot. Wrong round: `round_mismatch`; not live: `no_live_round`. |
| `difficulty.set` | Any joined player, int 1–5. Persists to `room.difficulty`. Applies to the *next* `PlantRequest` only; a planting already in flight keeps its request (deterministic replay after eviction depends on this). |
| `ping` | `pong` echo. Never stored, never rate-limited as a command, never in the outbox. |

**Judging.** The finder's driver runs the shared `JudgeFn(circle, target)` (centre enclosed, not absurdly large). The room does not re-judge and receives no geometry. This is the brief's split, and it is also the only one consistent with DDP: collaborators' lasers may not even be delivered to other drivers, so each driver can only report its own finds.

**Pre-planting (durable child task).** Plant request is derived, never client-supplied except the board: `{roundId, seed: fnv(roomId+roundId+attempt), difficulty: room.difficulty, count: 3+2*difficulty, board, stampIds}`. On `board.offer`/`round.start`-promotion the Room, in the admission transaction, writes `next={planting}` + `plantJob{request, attempt:0}` and creates a pi-durable child task (`plant`, `background:true`, owned by the Room's harness conversation, as in the template's child-task pattern) that runs the shared deterministic `PlantFn`. Completion commits only if `next` is still that `planting` id: `targets.length>=1` and every rect inside `frameRect` → `next={ready}` + snapshot; throw/empty → retry `attempt+1` (new seed) up to 3, then `next=null` and a `taunt` ("The stamps escaped. Start again."). A late result for a superseded round is dropped. Because `PlantFn` is pure for a given request, an evicted DO simply re-creates/resumes the task with the persisted request and gets identical targets.

**Ending a round.** In the ending transaction (`all-found` or alarm `time-up`): `reason`, `endedAt`, `roundsPlayed++`, and `roundsWon++` for every player tied at the max find count (>0). League `finds` were already credited per find, so a crash between find and end cannot lose score. Then, if `next` is `ready`, it stays ready (next `round.start` promotes it — a human beat between rounds is a feature); if `next===null`, nothing is planted until the next start supplies a board.

**Timers.** One DO alarm, always the earliest of: live round `endsAt`; `now+60s` recovery watchdog while any plant job is non-terminal (mirrors the template's `RECOVERY_ALARM_DELAY_MS` re-arm); nothing otherwise (`deleteAlarm`). `alarm()` reloads state from SQLite first: end an expired live round, resume a stuck plant job, re-arm. `endsAt` is never extended by reconnects or claims.

## 3. Join & auth

1. First ever Hunt click on a frame (and only after a click — FACTS rule 3; creating the action button itself is ungated): the driver reads the frame's `meta`. If `meta.iit` has `{roomId, joinToken}` it uses them. Otherwise it generates `roomId = crypto.randomUUID()`, `joinToken` = 32 random bytes base64url, and writes both back with `update-drawdy-elements` (`meta` merges; ids via `ctx.generateId()`). Two creators racing: both write, last write wins in Drawdy; the loser learns on reconnect (step 4).
2. Connect `wss://<backend>/rooms/<roomId>/ws`. Worker route validates `roomId` as a UUID, then `ROOMS.idFromName(roomId).fetch(req)`. No `Origin` check at all — the worker origin is `null`, there are no cookies, and the token is the credential, so CORS/`Origin: null` is a non-issue by construction.
3. First frame: `hello{createIfMissing:true, joinToken, player}` where `player` is the driver's own user from `collaboration:get-all-users-in-board`. If the DO has no `tokenHash`, it stores `SHA-256(joinToken)` and an empty `Room{difficulty:1,...}` in the same transaction and admits. If it has one, it hashes and compares; mismatch → `error bad_token`, close 1008. A second creator whose token lost the meta race gets `bad_token`, re-reads the frame `meta`, and retries once with the stored pair.
4. There is no room-creation HTTP endpoint: an uninitialised DO *is* a creatable room, which removes the template's unauthenticated `POST /api/sessions` surface entirely. Guessing a roomId is useless without the 256-bit token; tokens never appear in URLs or logs.

**Rate limits** (per connection, in-memory token buckets — volatile is fine, they are abuse brakes not state): 60 messages/60 s overall; `find.claim` ≤ 20/min; `board.offer` ≤ 1/10 s and ≤ 256 KB frame (global cap above); `round.start` ≤ 6/min. Breach → `result/error rate_limited`; third breach → close 1008. `hello` failures (bad token) are counted per DO (10/min) to slow guessing.

## 4. Reconnect & recovery

- **Snapshot-on-connect.** After `welcome`, state is complete: room, league, live round with targets and finds, players. The driver rebuilds all preview elements from `snapshot.room.current/next` (previews are local and never survive refresh anyway) and re-derives found-markers from `finds`. No event replay log exists or is needed; `seq` only orders snapshots.
- **Outbox replay.** The driver keeps the template's `CommandOutbox`: every `Retriable` is enqueued before send with a driver-minted `requestId` (`<playerId>:<counter>:<uuid>`), removed on matching `result`, and replayed verbatim — original requestIds, original order — immediately after `welcome` on every reconnect. On the Room, admission of any `Retriable` first checks `receipts`: hit → resend the stored `result` (plus current snapshot if the stored result was a find win, so the client re-syncs), no re-application. This makes a claim retried after a lost ack safe: it returns the original verdict, win or lose. Receipts are pruned when their round ends + 24 h.
- **DO eviction mid-round.** Room state, `seq`, receipts, `tokenHash`, plant job, and the platform alarm are all in DO SQLite/storage, so eviction loses nothing committed. Hibernating sockets keep their `player` attachment; on wake the DO reloads, re-arms the alarm to `min(endsAt, plantWatchdog)`, and resumes the plant child task from its persisted `PlantRequest`. Clients whose sockets actually dropped reconnect, get a snapshot, and replay their outbox — an in-flight claim either committed (receipt replays its verdict) or never happened (claim re-applies against possibly-updated state). Accepted finds are never double-credited: the target is already in `finds` and the receipt short-circuits before that check anyway.
- **Two claims, same millisecond.** Meaningless question at the client; the DO answers it. All commands funnel through one serial queue and each claim is a single SQLite transaction that checks `finds` for the target before inserting. First transaction to commit wins; its `Find.at` is the *server's* clock at commit. The loser gets `target_taken`. Client timestamps are never trusted for ordering — identical `at` values in `finds` are impossible to weaponise because insertion order, not `at`, is the record.

## 5. Offline single-player

No backend URL configured → `LocalHost`, same `HuntHost`, same `ClientMsg`/`ServerMsg`, same parse functions on every message (it literally round-trips through `encode`/`parseClientMsg` in dev builds; in prod it calls the same handlers). `LocalHost` runs the identical state machine in memory: `PlantFn` invoked directly instead of via a child task, `setTimeout(endsAt-now)` instead of a DO alarm, `serverNow = Date.now()`, one synthetic connection (the local player, `createIfMissing` ignored, token unchecked). League/difficulty live in memory only. The driver — laser handling, judging, previews, bursts, scoreboard — is byte-for-byte the same code; only the host constructor differs:

```ts
const host: HuntHost = backendUrl
  ? new RemoteHost(`${backendUrl}/rooms/${roomId}/ws`, outbox)  // WS, hello on open, replay on welcome
  : new LocalHost(localPlayer, plantFn);                        // in-process, same protocol types
```

## 6. Three riskiest parts

1. **Trusted judging.** Anyone (or any script) that can speak the protocol with the token can claim every target without drawing a circle; player ids are also self-asserted at `hello`. *Test:* a raw-WebSocket test client claims all targets in one burst and wins — assert this *works today* (documenting the hole), and if it ever must not, the fix is already shaped: add optional `circle` to `find.claim` and let the Room re-run the shared `JudgeFn` + check `circle` plausibility against the laser it cannot see… it cannot see lasers, so full verification is impossible; the real mitigation is social (private boards). Ship knowing this.
2. **Plant-task lifecycle vs. round churn.** Stale plant results, a frame that moved after the snapshot, retries reseeding — a wrong commit here shows targets in the wrong place or strands the room in `planting`. *Test:* `cloudflare:test` with a fake slow/throwing `PlantFn`: start round 1, offer a board, evict mid-plant (`evictDurableObject`), assert identical targets after resume (deterministic seed); end the round before the plant lands and assert the late result fills `next` only if the id still matches; force 3 failures and assert `next=null`, no stuck alarm.
3. **Receipt/outbox interplay across eviction.** The template's recovery tests show the shape: a claim whose ack was lost, retried after eviction, must return the original verdict and credit the league exactly once; two sockets claiming the same target in the same tick must produce exactly one find. *Test:* two real WS clients + `Promise.all` claims on one target (assert one `ok`, one `target_taken`, `league.finds` sums to 1); kill the socket after commit but before ack delivery, reconnect, replay, assert same `result`, still one find; `evictDurableObject` between the two and repeat.
