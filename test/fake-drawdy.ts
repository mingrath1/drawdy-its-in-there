// A stand-in for Drawdy's driver host, for tests. It keeps a scene, previews, floating elements,
// subscriptions, the active tool, and storage, and it behaves like the live client where that
// matters: freedraw previews are rejected, and a malformed DOM schema never gets an answer.

import type { DriverCommandIssuer, DriverSubscriptionEvent } from "@drawdy/driver-protocol";
import type { Rect } from "../src/shared/hunt.ts";
import { domSchemaProblems } from "../src/driver/dom-schema.ts";

type Request = { type: string; driverId: string; requestId: string; req?: any };
type Element = Record<string, any> & { id: string; type: string; x: number; y: number; width: number; height: number };

export class FakeDrawdy {
    commands: Request[] = [];
    elements = new Map<string, Element>();
    previews = new Map<string, any[]>();
    floating = new Map<string, any>();
    subscriptions = new Map<string, Request>();
    tool = "pencil";
    kv = new Map<string, Record<string, unknown>>();
    selection: string[] = [];
    viewport: Rect = { x: 0, y: 0, width: 1600, height: 1000 };
    users = [{ id: "u-ana", name: "Ana", color: "#ff4d4d", isHost: true, isSelf: true, cursorPosition: null }];
    /** Command types answered with an "unauthorized" error, as after a denied permission prompt. */
    denied = new Set<string>();
    /** Runs after each command is answered, so a test can change the board mid-flow. */
    afterCommand: (request: Request) => void = () => {};
    private seq = 0;

    generateId = () => `el-${this.seq++}`;

    issue: DriverCommandIssuer = (async (request: Request) => {
        this.commands.push(request);
        if (this.denied.has(request.type)) return { ...request, res: { error: { type: "unauthorized" } } };
        let value: unknown;
        try {
            value = this.handle(request);
        } catch (error) {
            return { ...request, res: { error: { type: "bad-argument", message: (error as Error).message } } };
        }
        if (value === HANG) return new Promise(() => {});
        this.afterCommand(request);
        return { ...request, res: { value } };
    }) as unknown as DriverCommandIssuer;

    add(element: Element) {
        this.elements.set(element.id, element);
    }

    /** Fires a subscription event to every matching subscriber. */
    emit(onEvent: (event: DriverSubscriptionEvent) => void, type: string, body: unknown, match: (req: any) => boolean = () => true) {
        for (const [subscriptionId, sub] of this.subscriptions) {
            if (sub.type === type && match(sub.req)) onEvent({ type, subscriptionId, body } as DriverSubscriptionEvent);
        }
    }

    click(onEvent: (event: DriverSubscriptionEvent) => void, domElementId: string) {
        this.emit(onEvent, "subscription:dom:element-clicked", { domElementId, clientX: 0, clientY: 0 }, (req) => req.domElementId === domElementId);
    }

    typesIssued(): string[] {
        return this.commands.map((c) => c.type);
    }

    private handle(r: Request): unknown {
        if (r.type.startsWith("subscription:")) {
            const subscriptionId = `sub-${this.seq++}`;
            this.subscriptions.set(subscriptionId, r);
            return { subscriptionId };
        }
        const pick = (e: Element, properties: string[]) => {
            const out: Record<string, unknown> = { id: e.id };
            for (const p of properties) if (e[p] !== undefined) out[p] = e[p];
            return out;
        };
        switch (r.type) {
            case "command:dom:create-action-button":
                return { created: true };
            case "command:subscription:remove":
                return { removed: this.subscriptions.delete(r.req.subscriptionId) };
            case "command:scene:get-current-selected-drawdy-elements":
                return { drawdyElementIds: this.selection };
            case "command:scene:get-drawdy-elements":
                return {
                    drawdyElements: (r.req.drawdyElementIds ?? [...this.elements.keys()])
                        .flatMap((id: string) => (this.elements.has(id) ? [pick(this.elements.get(id)!, r.req.properties)] : [])),
                };
            case "command:scene:query-combined-rect": {
                const found = r.req.drawdyElementIds.flatMap((id: string) => (this.elements.has(id) ? [this.elements.get(id)!] : []));
                if (found.length === 0) return { rect: null };
                const x = Math.min(...found.map((e: Element) => e.x));
                const y = Math.min(...found.map((e: Element) => e.y));
                const right = Math.max(...found.map((e: Element) => e.x + e.width));
                const bottom = Math.max(...found.map((e: Element) => e.y + e.height));
                return { rect: { x, y, width: right - x, height: bottom - y } };
            }
            case "command:camera:get-viewport-rect":
                return { rect: this.viewport };
            case "command:scene:query-rect": {
                const q: Rect = r.req.rect;
                const hits = [...this.elements.values()].filter(
                    (e) => e.x < q.x + q.width && e.x + e.width > q.x && e.y < q.y + q.height && e.y + e.height > q.y
                );
                return { drawdyElements: hits.map((e) => pick(e, r.req.properties)) };
            }
            case "command:scene:element-rects":
                return {
                    rects: r.req.drawdyElementIds.flatMap((id: string) => {
                        const e = this.elements.get(id);
                        return e ? [{ drawdyElementId: id, rect: { x: e.x, y: e.y, width: e.width, height: e.height } }] : [];
                    }),
                };
            case "command:scene:add-drawdy-elements": {
                const taken = r.req.elements.filter((e: any) => this.elements.has(e.drawdyElementId));
                if (taken.length > 0) throw new Error("ids already exist");
                for (const e of r.req.elements) {
                    const geometry =
                        e.type === "frame"
                            ? { x: e.position[0], y: e.position[1], width: e.width, height: e.height }
                            : { x: e.x, y: e.y, width: e.width, height: e.height };
                    this.add({ ...e, ...geometry, id: e.drawdyElementId, type: e.type === "shape" ? "path" : e.type });
                }
                return undefined;
            }
            case "command:scene:remove-drawdy-elements": {
                let removed = 0;
                for (const id of r.req.drawdyElementIds) if (this.elements.delete(id)) removed++;
                return { removed };
            }
            case "command:scene:update-drawdy-elements": {
                for (const u of r.req.updates) Object.assign(this.elements.get(u.drawdyElementId)!, u.properties);
                return { updated: r.req.updates.length };
            }
            case "command:scene:create-drawdy-preview-elements": {
                if (r.req.elements.some((e: any) => e.type === "freedraw" || e.type === "frame")) {
                    throw new Error("Frame and freedraw elements peview not yet supported.");
                }
                const previewId = `pv-${this.seq++}`;
                this.previews.set(previewId, r.req.elements);
                return { previewId, previewed: r.req.elements.length };
            }
            case "command:scene:update-drawdy-preview-elements": {
                let updated = 0;
                for (const [, batch] of this.previews) {
                    for (let i = 0; i < batch.length; i++) {
                        const next = r.req.elements.find((e: any) => e.drawdyElementId === batch[i].drawdyElementId);
                        if (next) {
                            batch[i] = next;
                            updated++;
                        }
                    }
                }
                return { updated };
            }
            case "command:scene:delete-drawdy-preview-elements": {
                let deleted = 0;
                for (const id of r.req.previewIds) if (this.previews.delete(id)) deleted++;
                return { deleted };
            }
            case "command:tools:get-active":
                return { toolId: this.tool };
            case "command:tools:set-active":
                this.tool = r.req.toolId;
                return undefined;
            case "command:kv-storage:get":
                return { got: this.kv.get(r.req.key) };
            case "command:kv-storage:set":
                this.kv.set(r.req.key, r.req.payload);
                return undefined;
            case "command:collaboration:get-all-users-in-board":
                return { users: this.users };
            case "command:dom:window-size":
                return { width: 1400, height: 900 };
            case "command:dom:upsert-floating-element": {
                if (domSchemaProblems(r.req.schema).length > 0) return HANG;
                const created = !this.floating.has(r.req.domId);
                this.floating.set(r.req.domId, r.req);
                return { created };
            }
            case "command:dom:remove-floating-element":
                return { removed: this.floating.delete(r.req.domId) };
            default:
                throw new Error(`the fake does not know ${r.type}`);
        }
    }
}

const HANG = Symbol("hang");
