import { describe, expect, it } from "vitest";
import type { Room } from "../../src/shared/hunt.ts";
import { type OpenRoom, publish } from "../src/durable.ts";

const frameRect = { x: 0, y: 0, width: 800, height: 600 };
const room = (roundId: string): Room => ({
  roomId: "room-1",
  difficulty: 1,
  chosenDifficulty: null,
  league: [],
  current: { status: "live", id: roundId, frameRect, targets: [], startedAt: 1, endsAt: 9, finds: [] },
  next: null,
  roundsPlayed: 0,
});

describe("publish", () => {
  it("stores the round's latest taunt: a new line replaces it, and a commit without one keeps it until the round changes", () => {
    const started = room("r1");
    const open: OpenRoom = { revision: 4, taunt: "Ready, set, squint.", room: started };

    const joined: Room = { ...started, league: [{ playerId: "ben", playerName: "Ben", finds: 0, roundsWon: 0 }] };
    expect(publish(open, started, joined, null)).toBe(true);
    expect(open).toMatchObject({ revision: 5, taunt: "Ready, set, squint." });

    const found: Room = { ...joined, roundsPlayed: 1 };
    publish(open, joined, found, "Spotted!");
    expect(open).toMatchObject({ revision: 6, taunt: "Spotted!" });

    publish(open, found, room("r2"), null);
    expect(open).toMatchObject({ revision: 7, taunt: null });
  });
});
