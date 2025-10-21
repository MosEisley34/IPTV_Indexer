const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractLinksDataScripts, extractLinksDataFromScript } = require("../main.js");

function readFixture(name) {
        const fixturePath = path.join(__dirname, "fixtures", name);
        return fs.readFileSync(fixturePath, "utf8");
}

test("extractLinksDataFromScript parses legacy linksData assignments", async () => {
        const html = readFixture("legacy_linksData.html");
        const scripts = await extractLinksDataScripts(html);

        assert.equal(scripts.length, 1, "expected one script to match the legacy marker");

        const linksData = extractLinksDataFromScript(scripts[0].content);

        assert.ok(linksData, "expected linksData to be parsed");
        assert.ok(Array.isArray(linksData.links), "expected linksData.links to be an array");
        assert.equal(linksData.links.length, 2, "expected two legacy channel entries");
        assert.deepEqual(
                Array.from(linksData.links, (link) => link.name),
                ["Legacy Channel One", "Legacy Channel Two"],
                "expected legacy channel names to be preserved"
        );
});

test("extractLinksDataFromScript parses window.__NUXT__ channel payloads", async () => {
        const html = readFixture("tennischannel_pluslive.html");
        const scripts = await extractLinksDataScripts(html);

        assert.equal(scripts.length, 1, "expected one script with Nuxt state to be detected");

        const linksData = extractLinksDataFromScript(scripts[0].content);

        assert.ok(linksData, "expected Nuxt state to produce channel data");
        assert.ok(Array.isArray(linksData.links), "expected links array from Nuxt data");
        assert.equal(linksData.links.length, 3, "expected three channels extracted from Nuxt state");
        assert.deepEqual(
                linksData.links,
                [
                        {
                                name: "Tennis Channel Plus 1",
                                url: "acestream://tennis-channel-plus-1",
                        },
                        {
                                name: "Tennis Channel Plus 2",
                                url: "acestream://tennis-channel-plus-2",
                        },
                        {
                                name: "Tennis Channel Extra",
                                url: "acestream://tennis-channel-extra",
                        },
                ]
        );
});

test("extractLinksDataFromScript parses __NUXT_DATA__ JSON payloads", async () => {
        const html = readFixture("tennischannel_pluslive_payload.html");
        const scripts = await extractLinksDataScripts(html);

        assert.equal(scripts.length, 1, "expected the Nuxt payload script to be detected");

        const linksData = extractLinksDataFromScript(scripts[0].content);

        assert.ok(linksData, "expected Nuxt payload JSON to produce channel data");
        assert.ok(Array.isArray(linksData.links), "expected links array from Nuxt payload");
        assert.equal(linksData.links.length, 3, "expected three channels extracted from Nuxt payload");
        assert.deepEqual(
                linksData.links,
                [
                        {
                                name: "Tennis Channel Plus 1",
                                url: "acestream://tennis-channel-plus-1",
                        },
                        {
                                name: "Tennis Channel Plus 2",
                                url: "acestream://tennis-channel-plus-2",
                        },
                        {
                                name: "Tennis Channel Extra",
                                url: "acestream://tennis-channel-extra",
                        },
                ]
        );
});

test("extractLinksDataScripts fetches external chunk scripts when needed", async () => {
        const html = "<!doctype html><html><body><script src=\"/_nuxt/ChunkData/example.js\"></script></body></html>";
        const expectedUrl = "https://www.example.com/_nuxt/ChunkData/example.js";
        let fetchCount = 0;

        const scripts = await extractLinksDataScripts(html, {
                baseUrl: "https://www.example.com/page",
                fetchExternalScript: async (scriptUrl) => {
                        fetchCount += 1;
                        assert.equal(scriptUrl, expectedUrl);
                        return {
                                statusCode: 200,
                                body: "window.__NUXT__ = { state: { data: 'ok' } };",
                        };
                },
        });

        assert.equal(fetchCount, 1, "expected one external fetch call");
        assert.equal(scripts.length, 1, "expected fetched script to be returned");
        assert.equal(
                scripts[0].content,
                "window.__NUXT__ = { state: { data: 'ok' } };",
                "expected external script body to be preserved"
        );
});
