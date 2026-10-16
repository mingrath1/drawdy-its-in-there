import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAMP_PACK } from "../src/stamp-pack.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const svgPath = join(docsDir, "stamp-sheet.svg");
const pngPath = join(docsDir, "stamp-sheet.png");

const COLS = 5;
const BOX = 200;
const INSET = 18;
const GAP = 30;
const PAD = 40;
const HEADER = 70;
const LABEL_H = 66;

const escapeXml = (text) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cellSvg(stamp, index) {
    const x = PAD + (index % COLS) * (BOX + GAP);
    const y = HEADER + Math.floor(index / COLS) * (BOX + LABEL_H + GAP);
    const span = BOX - 2 * INSET;
    const polylines = stamp.strokes
        .map((stroke) => {
            const points = stroke
                .map(([px, py]) => `${(x + INSET + px * span).toFixed(1)},${(y + INSET + py * span).toFixed(1)}`)
                .join(" ");
            return `<polyline points="${points}"/>`;
        })
        .join("\n      ");
    return `  <g>
    <rect x="${x}" y="${y}" width="${BOX}" height="${BOX}" fill="#fbfaf7" stroke="#d8d4cc"/>
    <g fill="none" stroke="#1d1d1f" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
      ${polylines}
    </g>
    <text x="${x + BOX / 2}" y="${y + BOX + 28}" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#111">${escapeXml(stamp.label)}</text>
    <text x="${x + BOX / 2}" y="${y + BOX + 52}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#666">${escapeXml(stamp.labelTh ?? "")}</text>
  </g>`;
}

function sheetSvg() {
    const rows = Math.ceil(STAMP_PACK.length / COLS);
    const width = PAD * 2 + COLS * BOX + (COLS - 1) * GAP;
    const contentHeight = HEADER + rows * (BOX + LABEL_H) + (rows - 1) * GAP + PAD;
    // QuickLook fits the SVG height to its square thumbnail and crops the sides, so the canvas stays square.
    const side = Math.max(width, contentHeight);
    const top = (side - contentHeight) / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <g transform="translate(0 ${top})">
  <text x="${PAD}" y="${PAD + 10}" font-family="sans-serif" font-size="24" fill="#111">It&apos;s In There! stamp pack (${STAMP_PACK.length} stamps)</text>
${STAMP_PACK.map(cellSvg).join("\n")}
  </g>
</svg>
`;
}

function renderPng() {
    const quickLookOut = `${svgPath}.png`;
    rmSync(pngPath, { force: true });
    rmSync(quickLookOut, { force: true });
    const attempts = [
        { tool: "qlmanage", args: ["-t", "-s", "2400", "-o", docsDir, svgPath], produced: quickLookOut },
        { tool: "sips", args: ["-s", "format", "png", svgPath, "--out", pngPath], produced: pngPath },
    ];
    for (const { tool, args, produced } of attempts) {
        try {
            execFileSync(tool, args, { stdio: "ignore" });
        } catch {
            continue;
        }
        if (!existsSync(produced)) continue;
        if (produced !== pngPath) renameSync(produced, pngPath);
        return tool;
    }
    return null;
}

mkdirSync(docsDir, { recursive: true });
writeFileSync(svgPath, sheetSvg());
console.log(`wrote ${svgPath}`);

const converter = renderPng();
console.log(converter ? `wrote ${pngPath} (via ${converter})` : "PNG skipped: neither qlmanage nor sips converted the SVG");
