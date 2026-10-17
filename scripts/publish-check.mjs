// Checks the repository against Drawdy's submission rules (https://ddp.drawdy.io/quickstart.md, section 6)
// and simulates Drawdy's esbuild build. Prints a Markdown report and exits 1 if any rule fails.
// Usage: node scripts/publish-check.mjs > docs/PUBLISH-CHECK.md

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ESBUILD = "esbuild@0.28.2";
const ENTRY = "src/index.ts";
const ALLOWED_PACKAGE = "@drawdy/driver-protocol";
const KB = 1024;
const MB = 1024 * KB;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

const checks = [];
const check = (rule, ok, evidence) => checks.push({ rule, ok, evidence });
const size = (path) => statSync(path).size;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const PERMISSIONS = new Set(["dom", "scene", "storage", "collaboration"]);
check("`manifest.json` at the root is valid JSON", true, "parsed with `JSON.parse`");
check(
    "`driverId` is dot-namespaced lowercase, at most 100 characters",
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(manifest.driverId) && manifest.driverId.length <= 100,
    `\`${manifest.driverId}\`, ${manifest.driverId.length} characters`,
);
check("`driverName` is 1 to 100 characters", manifest.driverName?.length >= 1 && manifest.driverName.length <= 100, `\`${manifest.driverName}\`, ${manifest.driverName?.length} characters`);
check("`driverVersion` is semver `major.minor.patch`", /^\d+\.\d+\.\d+$/.test(manifest.driverVersion), `\`${manifest.driverVersion}\``);
check("`description` is 1 to 500 characters", manifest.description?.length >= 1 && manifest.description.length <= 500, `${manifest.description?.length} characters`);
check("`main` is a plain `.js` filename", /^[\w.-]+\.js$/.test(manifest.main), `\`${manifest.main}\``);
check(
    "`permissions` is an array drawn from `dom`, `scene`, `storage`, `collaboration`",
    Array.isArray(manifest.permissions) && manifest.permissions.every((p) => PERMISSIONS.has(p)),
    `\`${JSON.stringify(manifest.permissions)}\``,
);

const icon = manifest.icon;
const iconOk = typeof icon === "string" && !icon.startsWith("/") && !icon.includes("..") && existsSync(icon);
check("`icon` is a relative path to a file in the repository", iconOk, `\`${icon}\``);
if (iconOk) {
    check("Icon is PNG, WebP or SVG", /\.(png|webp|svg)$/.test(icon), `extension \`${icon.split(".").pop()}\``);
    check("Icon is 256 KB or smaller", size(icon) <= 256 * KB, `${size(icon)} bytes`);
    if (icon.endsWith(".svg")) {
        const svg = readFileSync(icon, "utf8");
        const active = svg.match(/<script|<foreignObject|\son\w+\s*=|javascript:|<iframe|<embed|<object|xlink:href|<use\b/gi) ?? [];
        check("SVG icon contains no scripts", active.length === 0, active.length ? `found ${active.join(", ")}` : "no `<script>`, event handler, `javascript:`, `foreignObject` or external reference");
    }
}

check("Entry file at `src/index.ts`", existsSync(ENTRY), `\`${ENTRY}\` exists`);

// Source trace, so type-only imports that esbuild erases are checked too.
const reached = new Set();
const specifiers = new Map();
const IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
const resolveSource = (from, spec) => {
    const base = normalize(join(dirname(from), spec));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile());
};
const walk = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!specifiers.has(spec)) specifiers.set(spec, file);
        if (spec.startsWith(".")) {
            const target = resolveSource(file, spec);
            if (!target) throw new Error(`${file} imports ${spec}, which does not resolve`);
            walk(target);
        }
    }
};
walk(ENTRY);
const packages = [...specifiers.keys()].filter((s) => !s.startsWith("."));
const badPackages = packages.filter((s) => s !== ALLOWED_PACKAGE);
check(
    `No package import other than \`${ALLOWED_PACKAGE}\` reachable from the entry`,
    badPackages.length === 0,
    `${reached.size} source files reached, package imports: ${packages.map((p) => `\`${p}\``).join(", ") || "none"}${badPackages.length ? `. Disallowed: ${badPackages.join(", ")}` : ""}`,
);
const outside = [...reached].filter((f) => !f.startsWith("src/"));
check("Import graph stays inside `src/` and never reaches `server/`", outside.length === 0, outside.length ? outside.join(", ") : "every reached file is under `src/`");
const virtual = [...specifiers.keys()].filter((s) => s.startsWith("virtual:") || s.includes("?"));
check("No `virtual:` or bundler-plugin imports", virtual.length === 0, virtual.length ? virtual.join(", ") : "no `virtual:` or `?query` specifiers");

const tree = execFileSync("git", ["ls-tree", "-r", "-l", "HEAD"], { encoding: "utf8" }).trim().split("\n");
const committedBytes = tree.reduce((sum, line) => sum + Number(line.split(/\s+/)[3]), 0);
check("At most 500 committed files", tree.length <= 500, `${tree.length} files at \`${head}\``);
check("At most 20 MB committed", committedBytes <= 20 * MB, `${(committedBytes / MB).toFixed(2)} MB (${committedBytes} bytes) at \`${head}\``);
check("`README.md` is 200 KB or smaller", existsSync("README.md") && size("README.md") <= 200 * KB, `${size("README.md")} bytes`);
check("`CHANGELOG.md` exists and is 200 KB or smaller", existsSync("CHANGELOG.md") && size("CHANGELOG.md") <= 200 * KB, existsSync("CHANGELOG.md") ? `${size("CHANGELOG.md")} bytes` : "missing");

const ignored = ["node_modules/", "dist/", ".wrangler/", "server/node_modules/", "research/"];
const notIgnored = ignored.filter((p) => {
    try {
        execFileSync("git", ["check-ignore", "-q", p]);
        return false;
    } catch {
        return true;
    }
});
check("Build output, dependencies and research are gitignored", notIgnored.length === 0, notIgnored.length ? `not ignored: ${notIgnored.join(", ")}` : ignored.map((p) => `\`${p}\``).join(", "));

const leaks = (() => {
    try {
        return execFileSync("git", ["grep", "-nIE", "/Users/|/home/[a-z]|C:\\\\Users|ghp_|github_pat_|sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|account_id", "--", ":!scripts/publish-check.mjs"], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
})();
check("No home-directory path, token or key in committed files", leaks === "", leaks || "`git grep` for home paths, GitHub and OpenAI tokens, AWS keys, private keys and `account_id` finds nothing");

const outDir = "dist/publish-check";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const bundlePath = join(outDir, manifest.main);
const args = [ENTRY, "--bundle", "--format=cjs", "--platform=browser", "--target=es2020", `--external:${ALLOWED_PACKAGE}`, `--outfile=${bundlePath}`, `--metafile=${join(outDir, "meta.json")}`, "--log-level=info"];
const build = spawnSync("npx", ["--yes", ESBUILD, ...args], { encoding: "utf8" });
const buildLog = `${build.stdout}${build.stderr}`.trim();
if (build.status !== 0) throw new Error(`esbuild failed:\n${buildLog}`);
const bundle = readFileSync(bundlePath, "utf8");
const meta = JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8"));
const metaInputs = Object.keys(meta.inputs);
const bundleImports = Object.values(meta.outputs)[0].imports;

check("Bundle is under 5 MB", bundle.length < 5 * MB, `${Buffer.byteLength(bundle)} bytes`);
const requires = bundle.match(/\brequire\s*\(/g) ?? [];
check("Bundle has no `require()` at runtime", requires.length === 0 && bundleImports.length === 0, `${requires.length} \`require(\` in the bundle, ${bundleImports.length} external imports left by esbuild`);
check("esbuild inputs are all under `src/`", metaInputs.every((p) => p.startsWith("src/")), `${metaInputs.length} inputs in the metafile, all under \`src/\``);

const issued = [];
const ctx = {
    manifest,
    generateId: () => `id-${issued.length}`,
    styling: { theme: "light" },
    issueCommand: async (request) => {
        issued.push(request);
        const value = request.type.startsWith("subscription:") ? { subscriptionId: `sub-${issued.length}` } : { created: true };
        return { ...request, res: { value } };
    },
};
const mod = { exports: {} };
new Function("module", "exports", "require", bundle)(mod, mod.exports, (name) => {
    throw new Error(`bundle called require("${name}")`);
});
const exportsOk = typeof mod.exports.activate === "function" && typeof mod.exports.onEvent === "function";
check("Bundle exports `activate` and `onEvent` as CommonJS", exportsOk, `exports: ${Object.keys(mod.exports).join(", ")}`);
const driverLog = [];
const { log, warn } = console;
console.log = console.warn = (...line) => driverLog.push(line.join(" "));
await mod.exports.activate(ctx);
await new Promise((resolve) => setTimeout(resolve, 100));
Object.assign(console, { log, warn });
const [button, subscription] = issued;
const activateOk =
    issued.length === 2 &&
    button.type === "command:dom:create-action-button" &&
    subscription.type === "subscription:dom:element-clicked" &&
    subscription.req.domElementId === button.req.domElementId &&
    issued.every((r) => r.driverId === manifest.driverId);
check(
    "`activate` issues exactly the action button and its click subscription",
    activateOk,
    issued.map((r) => `\`${r.type}\` (${r.req?.domElementId})`).join(", "),
);
rmSync(outDir, { recursive: true });

const failed = checks.filter((c) => !c.ok);
const cell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", "<br>");
console.log(`# Publish check

Generated by \`node scripts/publish-check.mjs > docs/PUBLISH-CHECK.md\` at commit \`${head}\`. Rules come from section 6 of the [Drawdy quickstart](https://ddp.drawdy.io/quickstart.md). ${failed.length ? `**${failed.length} rules fail.**` : `All ${checks.length} checks pass.`}

| Rule | Status | Evidence |
| - | - | - |
${checks.map((c) => `| ${cell(c.rule)} | ${c.ok ? "pass" : "**FAIL**"} | ${cell(c.evidence)} |`).join("\n")}

## Build simulation

Drawdy bundles \`${ENTRY}\` with esbuild into one CommonJS file targeting ES2020 in the browser. This run used \`${ESBUILD}\` with \`${ALLOWED_PACKAGE}\` external, since that package is types only and every import of it erases. The bundle was then loaded in Node with a fake \`ctx\`, and \`activate\` ran against it.

\`\`\`
$ npx ${ESBUILD} ${args.join(" ")}
${buildLog}
\`\`\`

Driver console during \`activate\` and the 100 ms after it:

\`\`\`
${driverLog.join("\n")}
\`\`\`

Commands \`activate\` issued:

\`\`\`json
${JSON.stringify(issued.map(({ type, driverId, req }) => ({ type, driverId, req: req && { ...req, svg: req.svg && `<${req.svg.length} chars>` } })), null, 2)}
\`\`\``);
process.exitCode = failed.length ? 1 : 0;
