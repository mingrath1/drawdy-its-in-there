// The hunt domain, shared by the driver (src/) and the room backend (server/).
// The driver bundle may import only relative files and @drawdy/driver-protocol types,
// so this file has no imports.

export type Rect = { x: number; y: number; width: number; height: number };

/** A bundled stamp: human-drawn line art, normalized to a 0..1 box. */
export type Stamp = {
    id: string;
    label: string;
    /** Each stroke is a list of [x, y] points in the 0..1 box. */
    strokes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
};

/** One hidden thing. Rendered on every client as local preview strokes. */
export type Target = {
    id: string;
    stampId: string;
    /** Canvas-space box the stamp is drawn into. */
    rect: Rect;
    rotationDeg: number;
    strokeColor: string;
    strokeWidth: number;
};

export type PlayerId = string;

export type Find = {
    targetId: string;
    playerId: PlayerId;
    playerName: string;
    playerColor: string;
    at: number;
};

/**
 * A round moves planting → ready → live → ended and never backwards.
 * Only "live" accepts finds. The first committed find for a target wins.
 */
export type Round =
    /** `level` is the difficulty it was planted for. It plays only at that level. */
    | { status: "planting"; id: string; frameRect: Rect; level: number }
    | { status: "ready"; id: string; frameRect: Rect; level: number; targets: Target[] }
    | {
          status: "live";
          id: string;
          frameRect: Rect;
          targets: Target[];
          startedAt: number;
          endsAt: number;
          finds: Find[];
      }
    | {
          status: "ended";
          id: string;
          frameRect: Rect;
          targets: Target[];
          startedAt: number;
          endedAt: number;
          finds: Find[];
          reason: "all-found" | "time-up" | "cancelled";
      };

export type RoundStatus = Round["status"];

export const ROUND_TRANSITIONS: Record<RoundStatus, readonly RoundStatus[]> = {
    planting: ["ready", "ended"],
    ready: ["live", "ended"],
    live: ["ended"],
    ended: [],
};

export type LeagueEntry = {
    playerId: PlayerId;
    playerName: string;
    finds: number;
    roundsWon: number;
};

/** Everything a room remembers across rounds and sessions. */
export type Room = {
    roomId: string;
    /** The level of the current or most recent round. Before any round, the level the first one plays at. */
    difficulty: number;
    /** The level difficulty.set chose for the next round, until a round starts. */
    chosenDifficulty: number | null;
    league: LeagueEntry[];
    current: Round | null;
    next: Round | null;
    roundsPlayed: number;
};

/** A laser stroke or circle a player drew, in canvas space, judged on pointer-up. */
export type Circle = { points: ReadonlyArray<readonly [number, number]> };

/** What the host sees of the board when it hides targets. Built by the driver from scene reads. */
export type BoardItem = {
    rect: Rect;
    kind: "freedraw" | "shape" | "text" | "image" | "line" | "other";
    strokeColor?: string;
    strokeWidth?: number;
    /** Freedraw points in canvas space, thinned. Present only for freedraw. */
    points?: ReadonlyArray<readonly [number, number]>;
};

export type BoardSnapshot = { frameRect: Rect; items: BoardItem[] };

export type PlantRequest = {
    roundId: string;
    seed: number;
    /** 1 is easiest. Raises clutter preference and shrinks stamps. */
    difficulty: number;
    count: number;
    board: BoardSnapshot;
    stampIds: string[];
};

/**
 * Pure and deterministic for a given request. Lives in src/shared/placement.ts so the
 * driver's offline host and the room backend's plant tasks run the same code.
 */
export type PlantFn = (req: PlantRequest) => Target[];

/** Pure. A target counts as found when the circle encloses its centre and is not absurdly large. */
export type JudgeFn = (circle: Circle, target: Target) => boolean;
