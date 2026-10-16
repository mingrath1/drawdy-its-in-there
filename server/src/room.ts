import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Room as RoomState } from "../../src/shared/hunt.ts";
import {
  type ClientMessage,
  type Command,
  commandFingerprint,
  deriveRoomId,
  encode,
  type FaultCode,
  type Hello,
  isServerMessage,
  MAX_DIFFICULTY,
  MAX_FRAME_CHARS,
  parseClient,
  type Player,
  PROTOCOL_VERSION,
  ProtocolError,
  type ResultCode,
  roundDurationMs,
  type ServerMessage,
  type Snapshot,
  toWire,
} from "../../src/shared/protocol.ts";
import { canJoin, expireRound, joinRoom, openRoom, reduce, roundDeadline } from "../../src/shared/rules.ts";
import { STAMP_PACK } from "../../src/stamp-pack.ts";
import {
  HuntDoc,
  huntHarnessOptions,
  HuntReceipts,
  MAX_RECEIPTS,
  type OpenRoom,
  PlantNextRound,
  plain,
  publish,
} from "./durable.ts";
import { KeyedSerialQueue } from "./serial.ts";
import { momentOf, selectTauntHost, type TauntHost } from "./taunts.ts";

const context = BACKGROUND_CONTEXT;
const RECOVERY_ALARM_DELAY_MS = 60_000;
/** No round can end sooner than this after it starts, so an alarm pre-armed this far ahead is never late. */
const EARLIEST_DEADLINE_MS = roundDurationMs(MAX_DIFFICULTY);
const RATE_LIMIT = { perSecond: 10, burst: 20, retryAfterMs: 1_000 };
export const MAX_PLAYERS_ONLINE = 32;
const STAMP_IDS = STAMP_PACK.map((stamp) => stamp.id);
const ROOM_PATH = /^\/rooms\/([A-Za-z0-9:_-]{1,128})\/?$/;

/** Room ids take the same shape as protocol ids. */
export const roomIdFromPath = (pathname: string): string | null =>
  ROOM_PATH.exec(pathname)?.[1] ?? null;

type ConnectionState = { roomId: string; player?: Player };

type CommandOutcome =
  | { kind: "applied"; code: ResultCode; revision: number }
  | { kind: "replayed"; code: ResultCode; revision: number; open: OpenRoom; published: boolean }
  | { kind: "conflict"; revision: number };

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

/** A reserved code cannot be sent back, so a close without a status gets a normal one. */
const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  try {
    if (isReservedCloseCode(code)) socket.close(1000);
    else socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const connectionState = (socket: WebSocket): ConnectionState => socket.deserializeAttachment();

const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

const snapshot = (open: OpenRoom, self: string, taunt: string | null): Snapshot => ({
  v: PROTOCOL_VERSION,
  type: "snapshot",
  revision: open.revision,
  serverNow: Date.now(),
  self,
  room: toWire(open.room),
  taunt,
});

export class Room extends DurableObject<Env> {
  #harness!: Harness;
  readonly #taunts: TauntHost;
  readonly #operations = new KeyedSerialQueue<WebSocket>();
  readonly #buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  readonly #alarmTaskWatches = new Set<TaskId>();
  #alarmUpdate: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#taunts = selectTauntHost(env);
    void ctx.blockConcurrencyWhile(() => this.#initialize());
  }

  async #initialize(): Promise<void> {
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      huntHarnessOptions((error) => reportError("Harness background task failed", error)),
      context,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("Harness failed");
    });

    try {
      this.#harness = harness;
      // Planting commits from a background task, so broadcast from the commit line rather than from each handler.
      harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type !== "document" || change.record.kind !== HuntDoc.definition.kind) continue;
          const open = (change.value as { open: OpenRoom | null } | null)?.open ?? null;
          if (open !== null) this.#broadcast(open);
        }
      });
      await this.#expireOverdueRound();
      await this.#refreshAlarm();
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const roomId = roomIdFromPath(new URL(request.url).pathname);
    if (roomId === null || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade to /rooms/<roomId> required" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ roomId } satisfies ConnectionState);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async alarm(): Promise<void> {
    await this.#expireOverdueRound();
    await this.#refreshAlarm();
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.#withinRate(socket)) {
      return this.#fault(socket, "rate-limit", 1008, RATE_LIMIT.retryAfterMs);
    }
    if (typeof message !== "string") return this.#fault(socket, "invalid", 1003);
    if (message.length > MAX_FRAME_CHARS) return this.#fault(socket, "invalid", 1009);
    let parsed: ClientMessage;
    try {
      parsed = parseClient(message);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return this.#fault(socket, error.code, 1002);
    }
    try {
      await this.#operations.run(socket, () =>
        parsed.type === "hello" ? this.#hello(socket, parsed) : this.#command(socket, parsed),
      );
    } catch (error) {
      // Never acknowledge a failed commit. The client replays and its receipt tells whether the commit happened.
      reportError("Room message failed", error, { type: parsed.type });
      this.#fault(socket, "unavailable", 1011, RATE_LIMIT.retryAfterMs);
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    reciprocateClose(socket, code, reason);
  }

  override async webSocketError(_socket: WebSocket, error: unknown): Promise<void> {
    reportError("Room WebSocket failed", error);
  }

  /**
   * The first hello to an empty room creates it. Its id commits to the token, so only a token holder gets this far.
   * Commits run one at a time, so admitting and attaching the player inside one keeps racing hellos under both caps.
   */
  async #hello(socket: WebSocket, hello: Hello): Promise<void> {
    const state = connectionState(socket);
    if (state.player !== undefined) return this.#fault(socket, "invalid", 1002);
    if (hello.roomId !== state.roomId || hello.roomId !== deriveRoomId(hello.joinToken)) {
      return this.#fault(socket, "auth", 1008);
    }
    const { player } = hello;
    const now = Date.now();
    // Plant tasks belong to a conversation, so the root one must exist.
    await this.#harness.root(context);
    const admitted = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(HuntDoc);
      const before = doc.open === null ? openRoom(hello.roomId) : plain<RoomState>(doc.open.room);
      if (!canJoin(before, player.playerId) || !this.#hasPlaceOnline(player.playerId)) return null;
      socket.serializeAttachment({ ...state, player } satisfies ConnectionState);
      doc.open ??= { revision: 0, taunt: null, room: before };
      const after = joinRoom(expireRound(before, now), player);
      // The player is attached already, so a published change reaches this socket by broadcast, taunt included.
      const published = publish(doc.open, before, after, this.#tauntFor(before, after));
      return { open: plain<OpenRoom>(doc.open), published };
    }, context);
    if (admitted === null) return this.#fault(socket, "full", 1008, RECOVERY_ALARM_DELAY_MS);
    if (!admitted.published) this.#send(socket, snapshot(admitted.open, player.playerId, null));
    await this.#refreshAlarmAfterReply();
  }

  /**
   * Runs one command once per (player, requestId). An overdue round ends first, then the receipt is checked, so a
   * claim that won before the deadline still replays its "ok" afterwards.
   */
  async #command(socket: WebSocket, command: Command): Promise<void> {
    const player = connectionState(socket).player;
    if (player === undefined) return this.#fault(socket, "auth", 1008);
    const now = Date.now();
    if (command.type === "round.start" || command.type === "board.offer") {
      await this.#setAlarmNoLaterThan(now + EARLIEST_DEADLINE_MS);
    }
    const rules = {
      now,
      fresh: { roundId: crypto.randomUUID(), seed: randomSeed() },
      stampIds: STAMP_IDS,
    };
    const fingerprint = commandFingerprint(command);

    const outcome = await this.#harness.commit(async (tx): Promise<CommandOutcome> => {
      const doc = await tx.doc(HuntDoc);
      if (doc.open === null) throw new Error("The room does not exist");
      const before = plain<RoomState>(doc.open.room);
      const reconciled = expireRound(before, now);
      const { receipts } = await tx.doc(HuntReceipts, player.playerId, null);
      const stored = receipts.find((receipt) => receipt.requestId === command.requestId);
      if (stored !== undefined) {
        const published = publish(doc.open, before, reconciled, this.#tauntFor(before, reconciled));
        return stored.fingerprint === fingerprint
          ? { kind: "replayed", code: stored.code, revision: stored.revision, open: plain<OpenRoom>(doc.open), published }
          : { kind: "conflict", revision: doc.open.revision };
      }
      const step = reduce(reconciled, command, player, rules);
      publish(doc.open, before, step.room, this.#tauntFor(before, step.room));
      if (step.plant !== null) {
        await tx.createTask(PlantNextRound, step.plant, {
          ownership: { kind: "conversation" },
          conversationId: ROOT_CONVERSATION_ID,
          background: true,
        });
      }
      receipts.push({ requestId: command.requestId, fingerprint, code: step.code, revision: doc.open.revision });
      if (receipts.length > MAX_RECEIPTS) receipts.splice(0, receipts.length - MAX_RECEIPTS);
      return { kind: "applied", code: step.code, revision: doc.open.revision };
    }, context);

    // A replayed result carries its original revision, so the current state goes beside it, by broadcast or here.
    if (outcome.kind === "replayed" && !outcome.published) {
      this.#send(socket, snapshot(outcome.open, player.playerId, null));
    }
    this.#send(socket, {
      v: PROTOCOL_VERSION,
      type: "result",
      requestId: command.requestId,
      command: command.type,
      code: outcome.kind === "conflict" ? "request-conflict" : outcome.code,
      revision: outcome.revision,
    });
    await this.#refreshAlarmAfterReply();
  }

  async #expireOverdueRound(): Promise<void> {
    const open = (await this.#harness.snapshot(HuntDoc, context))?.open ?? null;
    if (open === null || roundDeadline(open.room) === undefined) return;
    const now = Date.now();
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(HuntDoc);
      if (doc.open === null) return;
      const before = plain<RoomState>(doc.open.room);
      const after = expireRound(before, now);
      publish(doc.open, before, after, this.#tauntFor(before, after));
    }, context);
  }

  #tauntFor(before: RoomState, after: RoomState): string | null {
    const moment = momentOf(before, after);
    return moment === null ? null : this.#taunts(moment);
  }

  #withinRate(socket: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.#buckets.get(socket) ?? { tokens: RATE_LIMIT.burst, at: now };
    bucket.tokens = Math.min(
      RATE_LIMIT.burst,
      bucket.tokens + ((now - bucket.at) / 1_000) * RATE_LIMIT.perSecond,
    );
    bucket.at = now;
    this.#buckets.set(socket, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #fault(socket: WebSocket, code: FaultCode, closeCode: number, retryAfterMs = 0): void {
    this.#send(socket, { v: PROTOCOL_VERSION, type: "fault", code, retryAfterMs });
    try {
      socket.close(closeCode, code);
    } catch {
      // The socket may already have closed.
    }
  }

  /** A player already online may open another connection. A new one needs a free place. */
  #hasPlaceOnline(playerId: string): boolean {
    const online = new Set(this.#players().map(({ player }) => player.playerId));
    return online.has(playerId) || online.size < MAX_PLAYERS_ONLINE;
  }

  #players(): Array<{ socket: WebSocket; player: Player }> {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const player = connectionState(socket).player;
      return player === undefined || socket.readyState !== WebSocket.READY_STATE_OPEN
        ? []
        : [{ socket, player }];
    });
  }

  #broadcast(open: OpenRoom): void {
    for (const { socket, player } of this.#players()) {
      this.#send(socket, snapshot(open, player.playerId, open.taunt));
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    if (!isServerMessage(message as unknown)) {
      reportError("Room withheld a message its clients would reject", new Error(`invalid ${message.type}`), {
        revision: message.type === "fault" ? undefined : message.revision,
      });
      return;
    }
    try {
      socket.send(encode(message));
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  /** One alarm serves the live round's deadline and the harness's recovery of unfinished tasks. */
  #refreshAlarm(): Promise<void> {
    return this.#serializeAlarmUpdate(async () => {
      const { tasks } = await this.#harness.inspect(context);
      const open = (await this.#harness.snapshot(HuntDoc, context))?.open ?? null;
      const now = Date.now();
      const deadlines: number[] = [];
      const deadline = open === null ? undefined : roundDeadline(open.room);
      if (deadline !== undefined) deadlines.push(deadline);
      const tasksToResume: TaskId[] = [];
      for (const task of tasks) {
        if (task.state.kind === "blocked") continue;
        deadlines.push(now + RECOVERY_ALARM_DELAY_MS);
        tasksToResume.push(task.record.id);
      }

      await this.#replaceAlarm(deadlines.length === 0 ? undefined : Math.min(...deadlines));
      // waitForTask starts the scheduler, so persist its recovery alarm first.
      for (const taskId of tasksToResume) this.#refreshAlarmWhenTaskSettles(taskId);
    });
  }

  /** The reply is out, so a failed refresh is only logged. The pre-armed alarm or the next wake reconciles it. */
  #refreshAlarmAfterReply(): Promise<void> {
    return this.#refreshAlarm().catch((error: unknown) => reportError("Room alarm refresh failed", error));
  }

  #setAlarmNoLaterThan(timestamp: number): Promise<void> {
    return this.#serializeAlarmUpdate(() =>
      this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.getAlarm();
        if (current === null || timestamp < current) await transaction.setAlarm(timestamp);
      }),
    );
  }

  #serializeAlarmUpdate(operation: () => Promise<void>): Promise<void> {
    const update = this.#alarmUpdate.then(operation, operation);
    this.#alarmUpdate = update;
    return update;
  }

  #refreshAlarmWhenTaskSettles(taskId: TaskId): void {
    if (this.#alarmTaskWatches.has(taskId)) return;
    this.#alarmTaskWatches.add(taskId);
    void this.#harness
      .waitForTask(taskId, context)
      .then(() => this.#refreshAlarm())
      .catch((error: unknown) =>
        reportError("Harness task alarm reconciliation failed", error, { taskId }),
      )
      .finally(() => this.#alarmTaskWatches.delete(taskId));
  }

  #replaceAlarm(timestamp: number | undefined): Promise<void> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.getAlarm();
      if (timestamp === undefined) {
        if (current !== null) await transaction.deleteAlarm();
      } else if (current !== timestamp) {
        await transaction.setAlarm(timestamp);
      }
    });
  }
}
