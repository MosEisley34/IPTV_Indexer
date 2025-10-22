const test = require("node:test");
const assert = require("node:assert/strict");

const { discoverAdditionalUrls } = require("../main.js");

test("discoverAdditionalUrls decodes escaped anchor href values", () => {
        const html = '<a href="\\u0022https:\\/\\/foo.example.com\\/playlist.m3u8">Stream</a>';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://foo.example.com/index.html",
        });

        assert.deepEqual(urls, ["https://foo.example.com/playlist.m3u8"]);
});

test("discoverAdditionalUrls decodes escaped JSON url entries", () => {
        const html =
                '<script type="application/json">{"url":"\\u0022https://bar.example.com/stream.m3u8"}</script>';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://bar.example.com/page",
        });

        assert.deepEqual(urls, ["https://bar.example.com/stream.m3u8"]);
});
