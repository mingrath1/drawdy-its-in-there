// The room backend over a WebSocket. Hello goes first on every connection. Commands wait in a
// FIFO outbox until their result arrives, and after each reconnect's first snapshot the outbox
// is replayed with the original requestIds, so the room's receipts make the replay harmless.

import { encode, isCommand, parseServer, ProtocolError } from "../shared/protocol.ts";
import type { Command, Fault, Hello, HuntHost, ServerMessage } from "../shared/protocol.ts";
import { log, warn } from "./command.ts";

const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;
const OPEN_TIMEOUT_MS = 15_000;
const OPEN = 1;

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
    let redial: ReturnType<typeof setTimeout> | null = null;
    let pendingOpen: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

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
        ws.onopen = () => {
            if (socket === ws && hello) ws.send(encode(hello));
        };
        ws.onmessage = (event) => {
            if (socket === ws) handle(ws, event.data);
        };
        ws.onclose = () => {
            if (socket !== ws) return;
            socket = null;
            scheduleRedial();
        };
        ws.onerror = () => {};
    };

    const scheduleRedial = () => {
        if (stopped || redial) return;
        const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempts);
        const jittered = ceiling / 2 + (random() * ceiling) / 2;
        const delay = Math.min(BACKOFF_CAP_MS, Math.max(retryFloorMs, jittered));
        attempts++;
        retryFloorMs = 0;
        log(`room connection closed; retrying in ${Math.round(delay)} ms`);
        redial = setTimeout(() => {
            redial = null;
            dial();
        }, delay);
    };

    const handle = (ws: RoomSocket, raw: unknown) => {
        let message: ServerMessage;
        try {
            message = parseServer(raw);
        } catch (error) {
            warn("dropped a room message", error instanceof ProtocolError ? error.code : error);
            return;
        }
        if (message.type === "snapshot" && !synced) {
            synced = true;
            attempts = 0;
            for (const command of outbox) ws.send(encode(command));
            settleOpen();
        } else if (message.type === "result") {
            const index = outbox.findIndex((c) => c.requestId === message.requestId);
            if (index >= 0) outbox.splice(index, 1);
        } else if (message.type === "fault") {
            if (message.code === "auth" || message.code === "version") {
                stopped = true;
                settleOpen(new RoomFault(message.code));
                socket = null;
                ws.close();
                warn(`room refused this player (${message.code}); not reconnecting`);
            } else {
                retryFloorMs = message.retryAfterMs;
            }
        }
        receive?.(message);
    };

    return {
        open(h, onMessage) {
            hello = h;
            receive = onMessage;
            stopped = false;
            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => settleOpen(new RoomFault("timeout")), OPEN_TIMEOUT_MS);
                pendingOpen = { resolve, reject, timer };
                dial();
            });
        },
        send(command) {
            if (!isCommand(command)) {
                warn("dropped an invalid command", (command as { type?: unknown }).type);
                return;
            }
            outbox.push(command);
            if (synced && socket?.readyState === OPEN) socket.send(encode(command));
        },
        close() {
            stopped = true;
            receive = null;
            if (redial) clearTimeout(redial);
            redial = null;
            settleOpen(new RoomFault("unavailable"));
            const ws = socket;
            socket = null;
            ws?.close();
        },
    };
}
