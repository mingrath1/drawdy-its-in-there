// The room backend over a WebSocket. Hello goes first on every connection. Commands wait in a
// FIFO outbox until their result arrives, and after each reconnect's first snapshot the outbox
// is replayed with the original requestIds, so the room's receipts make the replay harmless.

import { MAX_FRAME_CHARS, PROTOCOL_VERSION, encode, isCommand, parseServer, ProtocolError } from "../shared/protocol.ts";
import type { Command, Fault, Hello, HuntHost, ServerMessage } from "../shared/protocol.ts";
import { log, warn } from "./command.ts";

const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
const OPEN_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const OPEN = 1;

type Timer = ReturnType<typeof setTimeout>;

/** The slice of WebSocket this host uses, so tests can hand it a fake. */
export type RoomSocket = {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
};

type RemoteHostOptions = {
    backendUrl: string;
    roomId: string;
    connect?: (url: string) => RoomSocket;
    random?: () => number;
};

function roomSocketUrl(backendUrl: string, roomId: string): string {
    return `${backendUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/rooms/${encodeURIComponent(roomId)}`;
}

export class RoomFault extends Error {
    readonly code: Fault["code"] | "timeout";
    constructor(code: Fault["code"] | "timeout") {
        super(`room refused: ${code}`);
        this.code = code;
    }
}

export function createRemoteHost(options: RemoteHostOptions): HuntHost {
    const url = roomSocketUrl(options.backendUrl, options.roomId);
    const connect = options.connect ?? ((u: string) => new WebSocket(u) as unknown as RoomSocket);
    const random = options.random ?? Math.random;
    const outbox: Command[] = [];
    let hello: Hello | null = null;
    let receive: ((message: ServerMessage) => void) | null = null;
    let socket: RoomSocket | null = null;
    let synced = false;
    let stopped = false;
    let attempts = 0;
    let retryFloorMs = 0;
    let redial: Timer | null = null;
    let handshake: Timer | null = null;
    let watchdog: Timer | null = null;
    let pendingOpen: { resolve: () => void; reject: (error: Error) => void; timer: Timer } | null = null;

    const settleOpen = (error?: Error) => {
        if (!pendingOpen) return;
        clearTimeout(pendingOpen.timer);
        if (error) pendingOpen.reject(error);
        else pendingOpen.resolve();
        pendingOpen = null;
    };

    const dial = () => {
        if (stopped || !hello) return;
        synced = false;
        const ws = connect(url);
        socket = ws;
        handshake = setTimeout(() => abandon(ws, "no snapshot within 10 s"), HANDSHAKE_TIMEOUT_MS);
        ws.onopen = () => {
            if (socket === ws && hello) ws.send(encode(hello));
        };
        ws.onmessage = (event) => {
            if (socket === ws) handle(ws, event.data);
        };
        ws.onclose = () => abandon(ws, "room connection closed");
        ws.onerror = () => {};
    };

    /** Drops this connection and dials again. The outbox replays once the next one syncs. */
    const abandon = (ws: RoomSocket, why: string) => {
        if (socket !== ws) return;
        socket = null;
        synced = false;
        handshake = cancel(handshake);
        watchdog = cancel(watchdog);
        ws.close();
        if (stopped || redial) return;
        const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
        const delay = Math.max(retryFloorMs, ceiling / 2 + (random() * ceiling) / 2);
        attempts++;
        retryFloorMs = 0;
        log(`${why}; retrying in ${Math.round(delay)} ms`);
        redial = setTimeout(() => {
            redial = null;
            dial();
        }, delay);
    };

    /** A room that holds a command this long without answering is treated as gone, so the replay retries it. */
    const armWatchdog = (restart: boolean) => {
        if (watchdog && !restart) return;
        watchdog = cancel(watchdog);
        const ws = socket;
        if (!ws || !synced || outbox.length === 0) return;
        watchdog = setTimeout(() => abandon(ws, "no result within 15 s"), RESPONSE_TIMEOUT_MS);
    };

    const stop = (reason: RoomFault) => {
        stopped = true;
        redial = cancel(redial);
        handshake = cancel(handshake);
        watchdog = cancel(watchdog);
        settleOpen(reason);
        const ws = socket;
        socket = null;
        ws?.close();
    };

    const refuse = (code: "auth" | "version" | "full") => {
        stop(new RoomFault(code));
        warn(`room refused this player (${code}); not reconnecting`);
    };

    const handle = (ws: RoomSocket, raw: unknown) => {
        let message: ServerMessage;
        try {
            message = parseServer(raw);
        } catch (error) {
            if (error instanceof ProtocolError && error.code === "version") {
                refuse("version");
                receive?.({ v: PROTOCOL_VERSION, type: "fault", code: "version", retryAfterMs: 0 });
                return;
            }
            warn("dropped a room message", error instanceof ProtocolError ? error.code : error);
            return;
        }
        if (message.type === "snapshot" && !synced) {
            synced = true;
            attempts = 0;
            handshake = cancel(handshake);
            for (const command of outbox) ws.send(encode(command));
            armWatchdog(true);
            settleOpen();
        } else if (message.type === "result") {
            const index = outbox.findIndex((c) => c.requestId === message.requestId);
            if (index >= 0) outbox.splice(index, 1);
            armWatchdog(true);
        } else if (message.type === "fault") {
            if (message.code === "auth" || message.code === "version" || message.code === "full") refuse(message.code);
            else retryFloorMs = message.retryAfterMs;
        }
        receive?.(message);
    };

    return {
        open(h, onMessage) {
            hello = h;
            receive = onMessage;
            stopped = false;
            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => stop(new RoomFault("timeout")), OPEN_TIMEOUT_MS);
                pendingOpen = { resolve, reject, timer };
                dial();
            });
        },
        send(command) {
            if (!isCommand(command)) {
                warn("dropped an invalid command", (command as { type?: unknown }).type);
                return;
            }
            const frame = encode(command);
            if (frame.length > MAX_FRAME_CHARS) {
                warn(`dropped a ${command.type} of ${frame.length} characters; the room takes at most ${MAX_FRAME_CHARS}`);
                return;
            }
            outbox.push(command);
            if (synced && socket?.readyState === OPEN) {
                socket.send(frame);
                armWatchdog(false);
            }
        },
        close() {
            receive = null;
            stop(new RoomFault("unavailable"));
        },
    };
}

function cancel(timer: Timer | null): null {
    if (timer) clearTimeout(timer);
    return null;
}
