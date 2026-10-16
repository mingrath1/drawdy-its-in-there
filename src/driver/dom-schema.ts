// Drawdy never answers a floating element whose schema is malformed (fontSize: 11 instead of
// [11, "px"]), so every schema is checked here before it is sent.

type Check = (value: unknown) => boolean;

const UNITS = new Set(["px", "%", "em", "rem", "vw", "vh"]);
const isDimension: Check = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && UNITS.has(v[1]);
const isString: Check = (v) => typeof v === "string";
const isNumber: Check = (v) => typeof v === "number" && Number.isFinite(v);
const oneOf = (...values: string[]): Check => (v) => typeof v === "string" && values.includes(v);
const isAlignment = oneOf("between", "around", "start", "center", "end");

const BASE_STYLES: Record<string, Check> = {
    width: isDimension,
    height: isDimension,
    padding: isDimension,
    borderWidth: isDimension,
    borderRadius: isDimension,
    backgroundColor: isString,
    borderColor: isString,
    transform: isString,
    borderType: oneOf("solid", "dotted"),
    overflow: oneOf("visible", "hidden", "clip", "scroll", "auto"),
    pointerEvents: oneOf("auto", "none"),
    cursor: oneOf("auto", "default", "pointer", "grab", "grabbing", "crosshair", "move", "not-allowed", "text"),
};

const EXTRA_STYLES: Record<string, Record<string, Check>> = {
    button: {},
    box: {},
    image: {},
    iframe: {},
    grid: { columns: isNumber, gap: isNumber },
    row: { gap: isNumber, mainAxisAlignment: isAlignment, crossAxisAlignment: isAlignment },
    column: { gap: isNumber, mainAxisAlignment: isAlignment, crossAxisAlignment: isAlignment },
    text: {
        color: isString,
        fontSize: isDimension,
        fontWeight: oneOf("normal", "medium", "semibold", "bold"),
        textAlign: oneOf("start", "center", "end"),
    },
};

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every problem in the schema tree, as `path: message`. Empty means Drawdy can render it. */
export function domSchemaProblems(schema: unknown, path = "root"): string[] {
    if (!record(schema)) return [`${path}: not an object`];
    const type = schema.type;
    if (typeof type !== "string" || !(type in EXTRA_STYLES)) return [`${path}: unknown type ${String(type)}`];

    const problems: string[] = [];
    const allowed = { ...BASE_STYLES, ...EXTRA_STYLES[type] };
    if (schema.styles !== undefined) {
        if (!record(schema.styles)) problems.push(`${path}.styles: not an object`);
        else problems.push(...styleProblems(schema.styles, allowed, `${path}.styles`));
    }
    if (schema.domId !== undefined && !isString(schema.domId)) problems.push(`${path}.domId: not a string`);

    if (type === "text" || type === "image") {
        if (!isString(schema.child)) problems.push(`${path}.child: not a string`);
    } else if (type === "iframe") {
        const child = schema.child;
        if (!record(child) || !(isString(child.src) || isString(child.srcDoc))) problems.push(`${path}.child: needs src or srcDoc`);
    } else if (schema.children !== undefined) {
        if (!Array.isArray(schema.children)) problems.push(`${path}.children: not an array`);
        else schema.children.forEach((c, i) => problems.push(...domSchemaProblems(c, `${path}.children[${i}]`)));
    }
    return problems;
}

function styleProblems(styles: Record<string, unknown>, allowed: Record<string, Check>, path: string): string[] {
    const problems: string[] = [];
    for (const [key, value] of Object.entries(styles)) {
        if (value === undefined) continue;
        if (key === "hover") {
            if (!record(value)) problems.push(`${path}.hover: not an object`);
            else problems.push(...styleProblems(value, BASE_STYLES, `${path}.hover`));
            continue;
        }
        const check = allowed[key];
        if (!check) problems.push(`${path}.${key}: not a style here`);
        else if (!check(value)) problems.push(`${path}.${key}: bad value ${JSON.stringify(value)}`);
    }
    return problems;
}
