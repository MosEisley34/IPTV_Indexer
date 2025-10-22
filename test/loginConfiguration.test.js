const test = require("node:test");
const assert = require("node:assert/strict");

const main = require("../main.js");

const { buildLoginInfo } = main.__testables;

test("buildLoginInfo honours global login headers and method", () => {
        const options = {
                loginUrl: "https://auth.example.com/api/login",
                loginMethod: "post",
                loginPayload: { email: "user@example.com", password: "secret" },
                loginHeaders: {
                        "X-Requested-With": "XMLHttpRequest",
                        "Content-Type": "application/json",
                },
        };
        const urlObject = new URL("https://www.tennischannel.com/live");

        const info = buildLoginInfo({ urlObject, options, credential: null });

        assert.equal(info.url, "https://auth.example.com/api/login");
        assert.equal(info.method, "POST");
        assert.equal(info.methodSource, "global");
        assert.deepEqual(info.headers, {
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/json",
        });
        assert.equal(info.headersSource, "global");
});

test("buildLoginInfo falls back to credential-specified metadata", () => {
        const credential = {
                loginUrl: "https://capture.example.com/login",
                payload: { grant_type: "password" },
                method: "post",
                headers: {
                        Authorization: "Bearer sample",
                        Accept: "application/json",
                },
        };
        const options = {
                loginUrl: "",
                loginMethod: "",
                loginPayload: null,
                loginHeaders: null,
        };
        const urlObject = new URL("https://www.tennischannel.com/plus");

        const info = buildLoginInfo({ urlObject, options, credential });

        assert.equal(info.url, "https://capture.example.com/login");
        assert.equal(info.method, "POST");
        assert.equal(info.methodSource, "credential");
        assert.deepEqual(info.payload, { grant_type: "password" });
        assert.equal(info.payloadSource, "credential");
        assert.deepEqual(info.headers, {
                Authorization: "Bearer sample",
                Accept: "application/json",
        });
        assert.equal(info.headersSource, "credential");
});
