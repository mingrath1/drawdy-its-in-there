import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { domSchemaProblems } from "./dom-schema.ts";

describe("domSchemaProblems", () => {
    it("accepts a well-formed tree", () => {
        const schema = {
            type: "column",
            styles: { gap: 6, padding: [12, "px"], hover: { backgroundColor: "#111" } },
            children: [
                { type: "text", child: "Hi", styles: { fontSize: [12, "px"], fontWeight: "semibold" } },
                { type: "button", domId: "b", styles: { pointerEvents: "auto" }, children: [{ type: "text", child: "Go" }] },
            ],
        };
        assert.deepEqual(domSchemaProblems(schema), []);
    });

    it("catches a bare number where a CSS dimension belongs, the case that hangs Drawdy", () => {
        const problems = domSchemaProblems({ type: "text", child: "x", styles: { fontSize: 11 } });
        assert.deepEqual(problems, ["root.styles.fontSize: bad value 11"]);
    });

    it("catches NaN sizes, unknown units, misplaced styles, and missing text deep in the tree", () => {
        const problems = domSchemaProblems({
            type: "row",
            children: [
                { type: "box", styles: { width: [Number.NaN, "px"] } },
                { type: "box", styles: { height: [10, "furlong"] } },
                { type: "box", styles: { gap: 4 } },
                { type: "text" },
            ],
        });
        assert.equal(problems.length, 4);
        assert.ok(problems[0].startsWith("root.children[0].styles.width"));
        assert.ok(problems[1].startsWith("root.children[1].styles.height"));
        assert.ok(problems[2].startsWith("root.children[2].styles.gap"));
        assert.ok(problems[3].startsWith("root.children[3].child"));
    });
});
