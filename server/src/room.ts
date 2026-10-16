import { DurableObject } from "cloudflare:workers";
import type { Draft } from "@earendil-works/chord";
import type { Room as RoomState } from "../../src/shared/hunt.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, ROOT_CONVERSATION_ID, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  HuntDoc,
  huntHarnessOptions,
  HuntReceipts,
  type OpenRoom,
  PlantNextRound,
  type Receipt,
} from "./durable.ts";
import {
  type ClientMessage,
  type ErrorCode,
  InvalidMessage,
  MAX_MESSAGE_CHARACTERS,
  parseClientMessage,
  type ServerMessage,
} from "./messages.ts";
import {
  claimFind,
  type EndedRound,
  endDueRound,
  newRoom,
  type Player,
  roomView,
  roundDeadline,
  startRound,
} from "./rules.ts";
import { KeyedSerialQueue } from "./serial.ts";
import { selectTauntHost, type TauntHost, type TauntMoment } from "./taunts.ts";

const context = BACKGROUND_CONTEXT;
const RECOVERY_ALARM_DELAY_MS = 60_000;
const RATE_LIMIT = { messages: 20, windowMs: 1_000 };

type ConnectionState = { player?: Player };

type Applied = { room: RoomState; result: Receipt["result"]; moments: TauntMoment[] };

/** A plain copy of a draft, safe to keep after its commit settles. */
const plain = <T>(draft: Draft<T>): T => JSON.parse(JSON.stringify(draft));

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

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const playerOf = (socket: WebSocket): Player | undefined => {
  const state: ConnectionState | null = socket.deserializeAttachment();
  return state?.player;
};

const requestKey = (...parts: string[]): string => JSON.stringify(parts);

const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const roundEndMoment = (round: EndedRound): TauntMoment => ({
  kind: "round-end",
  roundId: round.id,
  reason: round.reason,
  found: round.finds.length,
  total: round.targets.length,
});

/** One hunt room: its rounds, league and difficulty, and the players connected to it. */
export class Room extends DurableObject<Env> {
  #harness!: Harness;
  readonly #taunts: TauntHost;
  readonly #operations = new KeyedSerialQueue<WebSocket>();
  readonly #rates = new WeakMap<WebSocket, { start: number; count: number }>();
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
          if (open !== null) this.#broadcast({ type: "room", room: roomView(open.room) });
        }
      });
      await this.#refreshAlarm();
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }

  async create(roomId: string): Promise<{ token: string }> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    // Plant tasks belong to a conversation, so the root one must exist.
    await this.#harness.root(context);
    await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(HuntDoc);
      if (doc.open !== null) throw new Error(`Room ${roomId} already exists`);
      doc.open = { tokenHash, room: newRoom(roomId) };
    }, context);
    return { token };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({} satisfies ConnectionState);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async alarm(): Promise<void> {
    const ended = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(HuntDoc);
      if (doc.open === null) return null;
      const step = endDueRound(plain(doc.open.room), Date.now());
      if (step === null) return null;
      doc.open.room = step.room;
      return step.ended;
    }, context);
    await this.#refreshAlarm();
    if (ended !== null) await this.#announce([roundEndMoment(ended)]);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.#withinRate(socket)) {
      return this.#refuse(socket, "rate-limited", "Too many messages", 1008);
    }
    if (typeof message !== "string") {
      return this.#refuse(socket, "invalid-message", "Binary messages are not supported", 1003);
    }
    if (message.length > MAX_MESSAGE_CHARACTERS) {
      return this.#refuse(socket, "too-large", "Message exceeds the size limit", 1009);
    }
    let parsed: ClientMessage;
    try {
      parsed = parseClientMessage(message);
    } catch (error) {
      if (!(error instanceof InvalidMessage)) throw error;
      return this.#refuse(socket, "invalid-message", error.message, 1002);
    }
    try {
      await this.#operations.run(socket, () => this.#handle(socket, parsed));
    } catch (error) {
      reportError("Room message failed", error, { type: parsed.type });
      this.#send(socket, {
        type: "error",
        code: "command-failed",
        message: error instanceof Error ? error.message : "Command failed",
        ...("requestId" in parsed ? { requestId: parsed.requestId } : {}),
      });
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    reciprocateClose(socket, code, reason);
  }

  override async webSocketError(_socket: WebSocket, error: unknown): Promise<void> {
    reportError("Room WebSocket failed", error);
  }

  async #handle(socket: WebSocket, message: ClientMessage): Promise<void> {
    if (message.type === "join") return this.#join(socket, message.token, message.player);
    const player = playerOf(socket);
    if (player === undefined) return this.#refuse(socket, "not-joined", "Join the room first", 1008);
    switch (message.type) {
      case "round.start": {
        const seeds = {
          now: Date.now(),
          current: { id: crypto.randomUUID(), seed: randomSeed() },
          next: { id: crypto.randomUUID(), seed: randomSeed() },
        };
        return this.#applyOnce(
          socket,
          message.requestId,
          requestKey(message.type, player.id),
          async (room, tx) => {
            const step = startRound(room, { board: message.board, stampIds: message.stampIds }, seeds);
            if (step.kind !== "started") return { room, result: step, moments: [] };
            await tx.createTask(PlantNextRound, step.plantNext, {
              ownership: { kind: "conversation" },
              conversationId: ROOT_CONVERSATION_ID,
              background: true,
            });
            return {
              room: step.room,
              result: { kind: "started", roundId: step.round.id },
              moments: [{ kind: "round-start", roundId: step.round.id, difficulty: step.room.difficulty }],
            };
          },
        );
      }
      case "find.claim":
        return this.#applyOnce(
          socket,
          message.requestId,
          requestKey(message.type, player.id, message.roundId, message.targetId),
          (room) => {
            const step = claimFind(room, { ...message, player }, Date.now());
            const moments: TauntMoment[] = [];
            if (step.result.kind === "found") {
              moments.push({ kind: "find", roundId: message.roundId, find: step.result.find });
            }
            if (step.ended !== null) moments.push(roundEndMoment(step.ended));
            return { room: step.room, result: step.result, moments };
          },
        );
    }
  }

  async #join(socket: WebSocket, token: string, player: Player): Promise<void> {
    const open = (await this.#harness.snapshot(HuntDoc, context))?.open ?? null;
    if (open === null) return this.#refuse(socket, "room-not-found", "No such room", 1008);
    if ((await sha256Hex(token)) !== open.tokenHash) {
      return this.#refuse(socket, "bad-token", "Wrong join token", 1008);
    }
    socket.serializeAttachment({ player } satisfies ConnectionState);
    this.#send(socket, { type: "joined", player, room: roomView(open.room) });
  }

  /**
   * Applies a command once per requestId. A retry gets the stored result back and changes nothing, the receipt
   * pattern from pi-durable-cloudflare's conversation commands.
   */
  async #applyOnce(
    socket: WebSocket,
    requestId: string,
    key: string,
    apply: (room: RoomState, tx: Tx) => Applied | Promise<Applied>,
  ): Promise<void> {
    const outcome = await this.#harness.commit(async (tx) => {
      const doc = await tx.doc(HuntReceipts, requestId, null);
      if (doc.receipt !== undefined) {
        return doc.receipt.key === key
          ? { kind: "replayed" as const, result: doc.receipt.result }
          : { kind: "reused" as const };
      }
      const hunt = await tx.doc(HuntDoc);
      if (hunt.open === null) throw new Error("The room does not exist");
      const room = plain(hunt.open.room);
      const applied = await apply(room, tx);
      if (applied.room !== room) hunt.open.room = applied.room;
      doc.receipt = { key, result: applied.result };
      return { kind: "applied" as const, ...applied };
    }, context);

    if (outcome.kind === "reused") {
      this.#send(socket, {
        type: "error",
        code: "request-reused",
        message: `Request ${requestId} was already used for another command`,
        requestId,
      });
      return;
    }
    this.#send(socket, { type: "result", requestId, result: outcome.result });
    if (outcome.kind === "applied") {
      await this.#refreshAlarm();
      await this.#announce(outcome.moments);
    }
  }

  async #announce(moments: readonly TauntMoment[]): Promise<void> {
    for (const moment of moments) {
      this.#broadcast({ type: "taunt", moment: moment.kind, text: await this.#taunts(moment) });
    }
  }

  #withinRate(socket: WebSocket): boolean {
    const now = Date.now();
    const window = this.#rates.get(socket);
    if (window === undefined || now - window.start >= RATE_LIMIT.windowMs) {
      this.#rates.set(socket, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= RATE_LIMIT.messages;
  }

  #refuse(socket: WebSocket, code: ErrorCode, message: string, closeCode: number): void {
    this.#send(socket, { type: "error", code, message });
    try {
      socket.close(closeCode, message);
    } catch {
      // The socket may already have closed.
    }
  }

  #broadcast(message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (playerOf(socket) !== undefined) this.#sendText(socket, text);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    this.#sendText(socket, JSON.stringify(message));
  }

  #sendText(socket: WebSocket, text: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(text);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  /** One alarm serves both the live round's deadline and the harness's recovery of unfinished tasks. */
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
