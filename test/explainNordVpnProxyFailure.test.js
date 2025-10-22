const assert = require("node:assert");
const { test } = require("node:test");

const { explainNordVpnProxyFailure } = require("../main");

const proxyUrl = "http://user:pass@us1234.nordvpn.com:89";

test("explainNordVpnProxyFailure provides guidance when the proxy connection is reset", () => {
        const error = new Error("socket hang up");
        error.code = "ECONNRESET";

        const message = explainNordVpnProxyFailure(error, proxyUrl);

        assert.match(message, /NordVPN Proxy/);
        assert.match(message, /closed unexpectedly/);
        assert.match(message, /us1234.nordvpn.com/);
});

test("explainNordVpnProxyFailure returns a default explanation for unknown errors", () => {
        const error = new Error("custom failure");

        const message = explainNordVpnProxyFailure(error, proxyUrl);

        assert.match(message, /NordVPN Proxy/);
        assert.match(message, /custom failure/);
});
