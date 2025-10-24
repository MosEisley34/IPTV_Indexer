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

test("discoverAdditionalUrls trims encoded trailing attribute noise", () => {
        const html =
                '<a data-url="/en-us/page/pluslive">Live</a>' +
                '<a href="/en-us/page/mps?method=mvpd%22%3EProfile">Profile</a>';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://www.tennischannel.com/en-us/page/pluslive",
        });

        assert.deepEqual(urls, [
                "https://www.tennischannel.com/en-us/page/pluslive",
                "https://www.tennischannel.com/en-us/page/mps?method=mvpd",
        ]);
});

test("discoverAdditionalUrls allows cross-host iframe embeds", () => {
        const html =
                '<iframe src="https://player.example.net/embed/channel123"></iframe>' +
                '<div data-stream-src="https://player.example.net/player.php?stream=demo"></div>';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://origin.example.com/view/page",
        });

        assert.deepEqual(urls, [
                "https://player.example.net/embed/channel123",
                "https://player.example.net/player.php?stream=demo",
        ]);
});

test("discoverAdditionalUrls includes cross-host direct stream links", () => {
        const html =
                '<a href="https://cdn.example.net/channel/master.m3u8">Watch now</a>';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://origin.example.com/page",
        });

        assert.deepEqual(urls, ["https://cdn.example.net/channel/master.m3u8"]);
});

test("discoverAdditionalUrls ignores cross-host static assets", () => {
        const html = '<img src="https://cdn.example.net/logo.png" />';
        const urls = discoverAdditionalUrls(html, {
                baseUrl: "https://origin.example.com/page",
        });

        assert.deepEqual(urls, []);
});
