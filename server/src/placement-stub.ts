import type { PlantFn, Target } from "../../src/shared/hunt.ts";

/** Stands in for src/shared/placement.ts until it lands: a deterministic grid inside the frame. */
export const plant: PlantFn = (req) => {
  if (req.stampIds.length === 0 || req.count <= 0) return [];
  const { frameRect } = req.board;
  const columns = Math.ceil(Math.sqrt(req.count));
  const rows = Math.ceil(req.count / columns);
  const cellWidth = frameRect.width / columns;
  const cellHeight = frameRect.height / rows;
  const size = Math.min(cellWidth, cellHeight) / (1 + req.difficulty / 2);
  const targets: Target[] = [];
  for (let index = 0; index < req.count; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    targets.push({
      id: `${req.roundId}:${index}`,
      stampId: req.stampIds[(req.seed + index) % req.stampIds.length]!,
      rect: {
        x: frameRect.x + column * cellWidth + (cellWidth - size) / 2,
        y: frameRect.y + row * cellHeight + (cellHeight - size) / 2,
        width: size,
        height: size,
      },
      rotationDeg: 0,
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
    });
  }
  return targets;
};
