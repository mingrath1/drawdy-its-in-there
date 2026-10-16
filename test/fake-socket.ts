// A WebSocket stand-in that a test drives from the room's side.

import type { RoomSocket } from "../src/driver/remote-host.ts";

export class FakeSocket implements RoomSocket {
    readyState = 0;
    sent: unknown[] = [];
    onopen: RoomSocket["onopen"] = null;
    onmessage: RoomSocket["onmessage"] = null;
    onclose: RoomSocket["onclose"] = null;
    onerror: RoomSocket["onerror"] = null;
    readonly url: string;
    constructor(url: string) {
        this.url = url;
    }
    send(data: string) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.readyState = 3;
        this.onclose?.({});
    }
    accept() {
        this.readyState = 1;
        this.onopen?.({});
    }
    deliver(message: unknown) {
        this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
    }
    drop() {
        this.readyState = 3;
        this.onclose?.({});
    }
}
