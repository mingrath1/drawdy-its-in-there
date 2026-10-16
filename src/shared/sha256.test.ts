import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { sha256Hex } from "./sha256.ts";

describe("sha256Hex", () => {
    it("matches the FIPS 180-4 test vectors", () => {
        assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert.equal(
            sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        );
        assert.equal(
            sha256Hex(
                "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
            ),
            "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
        );
        assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    });

    it("agrees with node:crypto across padding boundaries and non-ASCII text", () => {
        const inputs = Array.from({ length: 200 }, (_, n) => "x".repeat(n));
        inputs.push("ไทย · Thai 🐈", "\u0000\uffff", "iit-room-v1:" + "ab".repeat(32));
        for (const input of inputs) {
            assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf8").digest("hex"), JSON.stringify(input));
        }
    });
});
