export { Room } from "./room.ts";

// Drawdy runs drivers in a worker whose origin is `null`, so CORS allows any origin. The join token is the gate.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

const roomSocketRoute = /^\/api\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" || url.pathname === "/api/rooms/") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST, OPTIONS" });
      }
      const roomId = crypto.randomUUID();
      const { token } = await env.ROOMS.getByName(roomId).create(roomId);
      return json({ roomId, token }, 201);
    }

    const roomMatch = roomSocketRoute.exec(url.pathname);
    if (roomMatch !== null) {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
      }
      return env.ROOMS.getByName(roomMatch[1]!).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
