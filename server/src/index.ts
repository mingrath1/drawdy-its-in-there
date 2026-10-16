import { roomIdFromPath } from "./room.ts";

export { Room } from "./room.ts";

// Drawdy runs drivers in a worker whose origin is `null`. Origin is not authentication; the join token in hello is.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    const roomId = roomIdFromPath(new URL(request.url).pathname);
    if (roomId === null) return json({ error: "Not found" }, 404);
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }
    return env.ROOMS.getByName(roomId).fetch(request);
  },
} satisfies ExportedHandler<Env>;
