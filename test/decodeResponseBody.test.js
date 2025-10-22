const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("zlib");

const { decodeResponseBody } = require("../main");

test("decodeResponseBody returns plain UTF-8 text when no encoding is provided", () => {
        const body = Buffer.from("Sample response body", "utf8");
        const result = decodeResponseBody(body, {});

        assert.equal(result, "Sample response body");
});

test("decodeResponseBody decodes gzip-encoded responses", () => {
        const original = "Streaming manifest content";
        const encoded = zlib.gzipSync(Buffer.from(original, "utf8"));
        const headers = { "Content-Encoding": "gzip" };

        const result = decodeResponseBody(encoded, headers);

        assert.equal(result, original);
});

test("decodeResponseBody decodes deflate-encoded responses", () => {
        const original = "Another manifest payload";
        const encoded = zlib.deflateSync(Buffer.from(original, "utf8"));
        const headers = { "Content-Encoding": "deflate" };

        const result = decodeResponseBody(encoded, headers);

        assert.equal(result, original);
});

if (typeof zlib.brotliCompressSync === "function") {
        test("decodeResponseBody decodes brotli-encoded responses", () => {
                const original = "Brotli encoded manifest";
                const encoded = zlib.brotliCompressSync(Buffer.from(original, "utf8"));
                const headers = { "Content-Encoding": "br" };

                const result = decodeResponseBody(encoded, headers);

                assert.equal(result, original);
        });
}
