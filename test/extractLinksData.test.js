const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractLinksDataScripts, extractLinksDataFromScript } = require("../main.js");

function readFixture(name) {
        const fixturePath = path.join(__dirname, "fixtures", name);
        return fs.readFileSync(fixturePath, "utf8");
}

test("extractLinksDataFromScript parses legacy linksData assignments", () => {
        const html = readFixture("legacy_linksData.html");
        const scripts = extractLinksDataScripts(html);

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

test("extractLinksDataFromScript parses window.__NUXT__ channel payloads", () => {
        const html = readFixture("tennischannel_pluslive.html");
        const scripts = extractLinksDataScripts(html);

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
