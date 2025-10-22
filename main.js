const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const https = require("https");
const tls = require("tls");
const zlib = require("zlib");
const { execFile } = require("child_process");
const readline = require("readline");
const { Writable } = require("stream");

const DEFAULT_USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const DEFAULT_CONFIG_FILENAME = "config.yaml";
const DEFAULT_IP_CHECK_URL = "https://api.ipify.org?format=json";

const LOG_LEVELS = {
        silent: 0,
        error: 1,
        warn: 2,
        info: 3,
        verbose: 4,
        debug: 5,
};

const LEVEL_TO_CONSOLE_METHOD = {
        error: "error",
        warn: "warn",
        info: "log",
        verbose: "log",
        debug: "log",
};

let currentLogLevel = LOG_LEVELS.info;

function normalizeLogLevel(level, fallback = "info") {
        if (typeof level !== "string") {
                return fallback;
        }

        const normalized = level.trim().toLowerCase();

        if (normalized === "warning") {
                return "warn";
        }

        if (normalized === "errors") {
                return "error";
        }

        if (Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)) {
                return normalized;
        }

        return fallback;
}

function setLogLevel(levelName) {
        const normalized = normalizeLogLevel(levelName, "info");
        currentLogLevel = LOG_LEVELS[normalized] ?? LOG_LEVELS.info;
}

function logAtLevel(levelName, ...args) {
        const normalized = normalizeLogLevel(levelName, "info");
        const levelValue = LOG_LEVELS[normalized];

        if (levelValue > currentLogLevel) {
                return;
        }

        const consoleMethod = LEVEL_TO_CONSOLE_METHOD[normalized] || "log";
        console[consoleMethod](...args);
}

function logDebug(...args) {
        logAtLevel("debug", ...args);
}

function logVerbose(...args) {
        logAtLevel("verbose", ...args);
}

function logInfo(...args) {
        logAtLevel("info", ...args);
}

function logWarn(...args) {
        logAtLevel("warn", ...args);
}

function logError(...args) {
        logAtLevel("error", ...args);
}

function stripYamlComment(line) {
        let result = "";
        let inSingle = false;
        let inDouble = false;
        let escaping = false;

        for (const char of line) {
                if (escaping) {
                        result += char;
                        escaping = false;
                        continue;
                }

                if (char === "'" && !inDouble) {
                        inSingle = !inSingle;
                        result += char;
                        continue;
                }

                if (char === "\"" && !inSingle) {
                        inDouble = !inDouble;
                        result += char;
                        continue;
                }

                if (char === "\\" && inDouble) {
                        escaping = true;
                        result += char;
                        continue;
                }

                if (char === "#" && !inSingle && !inDouble) {
                        break;
                }

                result += char;
        }

        return result;
}

function isNonEmptyString(value) {
        return typeof value === "string" && value.trim().length > 0;
}

function findHeaderKey(headers, name) {
        if (!headers || typeof headers !== "object") {
                return null;
        }

        const target = name.toLowerCase();

        for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === target) {
                        return key;
                }
        }

        return null;
}

function getHeaderValue(headers, name) {
        const key = findHeaderKey(headers, name);

        if (!key) {
                return undefined;
        }

        return headers[key];
}

function setOrReplaceHeader(headers, name, value) {
        const existingKey = findHeaderKey(headers, name);

        if (existingKey) {
                headers[existingKey] = value;
        } else {
                headers[name] = value;
        }
}

function hasHeader(headers, name) {
        return Boolean(findHeaderKey(headers, name));
}

function mergeHeaders(...sources) {
        const result = {};

        for (const source of sources) {
                if (!source || typeof source !== "object") {
                        continue;
                }

                for (const [key, value] of Object.entries(source)) {
                        if (value === undefined || value === null) {
                                const existingKey = findHeaderKey(result, key);

                                if (existingKey) {
                                        delete result[existingKey];
                                }

                                continue;
                        }

                        setOrReplaceHeader(result, key, value);
                }
        }

        return result;
}

function decodeResponseBody(buffer, headers) {
        if (buffer === undefined || buffer === null) {
                return "";
        }

        let workingBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const encodingHeader = getHeaderValue(headers, "Content-Encoding");

        if (typeof encodingHeader === "string" && encodingHeader.trim().length > 0) {
                const encodings = encodingHeader
                        .split(",")
                        .map((part) => part.trim().toLowerCase())
                        .filter(Boolean)
                        .reverse();

                for (const encoding of encodings) {
                        try {
                                if (encoding === "gzip" || encoding === "x-gzip") {
                                        workingBuffer = zlib.gunzipSync(workingBuffer);
                                        continue;
                                }

                                if (encoding === "deflate" || encoding === "x-deflate") {
                                        try {
                                                workingBuffer = zlib.inflateSync(workingBuffer);
                                        } catch (inflateError) {
                                                workingBuffer = zlib.inflateRawSync(workingBuffer);
                                        }
                                        continue;
                                }

                                if (encoding === "br") {
                                        if (typeof zlib.brotliDecompressSync === "function") {
                                                workingBuffer = zlib.brotliDecompressSync(workingBuffer);
                                        } else {
                                                logDebug(
                                                        "Received Brotli-encoded response but brotliDecompressSync is not available; returning undecoded body."
                                                );
                                                return workingBuffer.toString("utf8");
                                        }
                                        continue;
                                }

                                if (encoding === "identity") {
                                        continue;
                                }

                                logDebug(
                                        `Unsupported content-encoding '${encoding}'. Returning body without decoding.`
                                );
                                return workingBuffer.toString("utf8");
                        } catch (error) {
                                logDebug(
                                        `Failed to decode response body for encoding '${encoding}': ${error.message}`
                                );
                                return workingBuffer.toString("utf8");
                        }
                }
        }

        return workingBuffer.toString("utf8");
}

const STATIC_ASSET_EXTENSIONS = new Set([
        "png",
        "jpg",
        "jpeg",
        "gif",
        "svg",
        "webp",
        "ico",
        "bmp",
        "css",
        "scss",
        "sass",
        "less",
        "js",
        "mjs",
        "cjs",
        "ts",
        "tsx",
        "jsx",
        "map",
        "woff",
        "woff2",
        "ttf",
        "otf",
        "eot",
]);

function isLikelyStaticAssetUrl(url) {
        if (typeof url !== "string" || url.length === 0) {
                return false;
        }

        let parsed;

        try {
                parsed = new URL(url);
        } catch (error) {
                return false;
        }

        const pathname = parsed.pathname || "";

        if (!pathname || pathname.endsWith("/")) {
                return false;
        }

        const lastSegment = pathname.split("/").pop() || "";

        if (!lastSegment) {
                return false;
        }

        const sanitized = lastSegment.split(/[?#]/, 1)[0] || "";

        if (!sanitized) {
                return false;
        }

        if (/^favicon$/i.test(sanitized)) {
                return true;
        }

        const dotIndex = sanitized.lastIndexOf(".");

        if (dotIndex === -1) {
                return false;
        }

        const extension = sanitized.slice(dotIndex + 1).toLowerCase();

        if (!extension) {
                return false;
        }

        if (extension === "m3u8" || extension === "mpd" || extension === "ism") {
                return false;
        }

        return STATIC_ASSET_EXTENSIONS.has(extension);
}

function normalizeContentType(contentTypeHeader) {
        if (typeof contentTypeHeader !== "string") {
                return "";
        }

        const [mimeType] = contentTypeHeader.split(";");

        if (!mimeType) {
                return "";
        }

        return mimeType.trim().toLowerCase();
}

function isHtmlContentType(contentType) {
        if (typeof contentType !== "string" || contentType.length === 0) {
                return false;
        }

        return (
                contentType === "text/html" ||
                contentType === "application/xhtml+xml" ||
                contentType.endsWith("+html")
        );
}

function isJsonContentType(contentType) {
        if (typeof contentType !== "string" || contentType.length === 0) {
                return false;
        }

        return (
                contentType === "application/json" ||
                contentType === "application/ld+json" ||
                contentType.endsWith("+json")
        );
}

function parseCookiesInput(raw) {
        const cookies = [];
        const errors = [];

        if (!raw || typeof raw !== "string") {
                return { cookies, errors };
        }

        const parts = raw.split(/[;\n]/);

        for (const part of parts) {
                const trimmed = part.trim();

                if (!trimmed) {
                        continue;
                }

                const separatorIndex = trimmed.indexOf("=");

                if (separatorIndex === -1) {
                        errors.push(`Ignoring cookie entry without '=': ${trimmed}`);
                        continue;
                }

                const name = trimmed.slice(0, separatorIndex).trim();
                const value = trimmed.slice(separatorIndex + 1).trim();

                if (!name) {
                        errors.push("Ignoring cookie entry with empty name.");
                        continue;
                }

                cookies.push({ name, value });
        }

        return { cookies, errors };
}

function parseHeaderList(raw) {
        const headers = {};
        const cookies = [];
        const errors = [];

        if (!raw || typeof raw !== "string") {
                return { headers, cookies, errors };
        }

        const lines = raw.split(/[\n;]/);

        for (const line of lines) {
                const trimmed = line.trim();

                if (!trimmed) {
                        continue;
                }

                const separatorIndex = trimmed.indexOf(":");

                if (separatorIndex === -1) {
                        errors.push(`Ignoring header without ':' separator: ${trimmed}`);
                        continue;
                }

                const name = trimmed.slice(0, separatorIndex).trim();
                const value = trimmed.slice(separatorIndex + 1).trim();

                if (!name) {
                        errors.push("Ignoring header entry with empty name.");
                        continue;
                }

                if (name.toLowerCase() === "cookie") {
                        const parsed = parseCookiesInput(value);
                        cookies.push(...parsed.cookies);
                        errors.push(...parsed.errors);
                        continue;
                }

                setOrReplaceHeader(headers, name, value);
        }

        return { headers, cookies, errors };
}

function createCookieJar(initialCookies = []) {
        const jar = new Map();

        const api = {
                set(name, value) {
                        if (!name) {
                                return;
                        }
                        jar.set(name, value ?? "");
                },
                loadFromCookieHeader(value) {
                        const parsed = parseCookiesInput(value);
                        parsed.cookies.forEach(({ name, value: cookieValue }) => {
                                api.set(name, cookieValue);
                        });
                        return parsed.errors;
                },
                loadFromSetCookie(setCookieValue) {
                        if (typeof setCookieValue !== "string" || setCookieValue.length === 0) {
                                return;
                        }

                        const [firstPart] = setCookieValue.split(";");

                        if (!firstPart) {
                                return;
                        }

                        const separatorIndex = firstPart.indexOf("=");

                        if (separatorIndex === -1) {
                                return;
                        }

                        const name = firstPart.slice(0, separatorIndex).trim();
                        const value = firstPart.slice(separatorIndex + 1).trim();

                        if (!name) {
                                return;
                        }

                        api.set(name, value);
                },
                getCookieHeader() {
                        if (jar.size === 0) {
                                return "";
                        }

                        return Array.from(jar.entries())
                                .map(([name, value]) => `${name}=${value}`)
                                .join("; ");
                },
                hasCookies() {
                        return jar.size > 0;
                },
        };

        if (Array.isArray(initialCookies)) {
                initialCookies.forEach((cookie) => {
                        if (cookie && typeof cookie.name === "string") {
                                api.set(cookie.name.trim(), cookie.value ?? "");
                        }
                });
        }

        return api;
}

function getHeaderValues(headers, name) {
        if (!headers || typeof headers !== "object") {
                        return [];
        }

        const target = name.toLowerCase();
        const direct = headers[target];
        const fallback = headers[name];
        const value = direct ?? fallback;

        if (!value) {
                const matchingKey = findHeaderKey(headers, name);

                if (!matchingKey) {
                        return [];
                }

                const resolved = headers[matchingKey];

                if (!resolved) {
                        return [];
                }

                if (Array.isArray(resolved)) {
                        return resolved;
                }

                return [resolved];
        }

        if (Array.isArray(value)) {
                return value;
        }

        return [value];
}

function updateCookieJarFromResponse(cookieJar, headers) {
        if (!cookieJar) {
                return;
        }

        const setCookies = getHeaderValues(headers, "set-cookie");

        for (const entry of setCookies) {
                cookieJar.loadFromSetCookie(entry);
        }
}

function resolveMaybeRelativeUrl(candidate, baseUrl) {
        if (!candidate || typeof candidate !== "string") {
                return "";
        }

        try {
                const resolved = new URL(candidate, baseUrl instanceof URL ? baseUrl : new URL(baseUrl));
                return resolved.href;
        } catch (error) {
                try {
                        return new URL(candidate).href;
                } catch (innerError) {
                        return candidate;
                }
        }
}

function findCredentialForHost(credentials, hostname) {
        if (!Array.isArray(credentials) || !hostname) {
                return null;
        }

        const lowerHost = hostname.toLowerCase();

        for (const entry of credentials) {
                if (!entry || typeof entry.site !== "string") {
                        continue;
                }

                const normalizedSite = entry.site.trim().toLowerCase();

                if (!normalizedSite) {
                        continue;
                }

                if (lowerHost === normalizedSite || lowerHost.endsWith(`.${normalizedSite}`)) {
                        return entry;
                }
        }

        return null;
}

function pickFirstNonEmpty(values = []) {
        for (const value of values) {
                if (typeof value === "string") {
                        if (value.trim().length > 0) {
                                return value;
                        }
                }
        }

        return null;
}

function buildLoginInfo({ urlObject, options, credential }) {
        if (!urlObject || !options) {
                return null;
        }

        const directLoginUrl = isNonEmptyString(options.loginUrl)
                ? options.loginUrl
                : '';
        const credentialLoginUrl = credential && isNonEmptyString(credential.loginUrl)
                ? credential.loginUrl
                : '';
        const loginUrlCandidate = directLoginUrl || credentialLoginUrl;

        if (!loginUrlCandidate) {
                return null;
        }

        const resolvedLoginUrl = resolveMaybeRelativeUrl(loginUrlCandidate, urlObject);

        let payload = null;
        let payloadSource = '';

        if (options.loginPayload && typeof options.loginPayload === "object") {
                payload = options.loginPayload;
                payloadSource = "global";
        } else if (credential && credential.payload && typeof credential.payload === "object") {
                payload = credential.payload;
                payloadSource = "credential";
        } else {
                const usernameCandidate = pickFirstNonEmpty([
                        options.loginUsername,
                        credential ? credential.username : null,
                ]);

                let passwordCandidate = null;

                if (typeof options.loginPassword === "string" && options.loginPassword.length > 0) {
                        passwordCandidate = options.loginPassword;
                } else if (
                        credential &&
                        typeof credential.password === "string" &&
                        credential.password.length > 0
                ) {
                        passwordCandidate = credential.password;
                }

                if (usernameCandidate !== null || passwordCandidate !== null) {
                        payload = {
                                username: usernameCandidate !== null ? usernameCandidate.trim() : "",
                                password: passwordCandidate !== null ? passwordCandidate : "",
                        };
                        payloadSource = "credentials";
                }
        }

        return {
                url: resolvedLoginUrl,
                method: "POST",
                payload,
                payloadSource,
        };
}

function buildHeadersForRequest(baseHeaders = {}, cookieJar, extraHeaders = {}) {
        const combined = mergeHeaders(baseHeaders, extraHeaders);

        if (cookieJar && typeof cookieJar.getCookieHeader === "function") {
                const cookieHeader = cookieJar.getCookieHeader();

                if (cookieHeader) {
                        setOrReplaceHeader(combined, "Cookie", cookieHeader);
                } else {
                        const existingCookieKey = findHeaderKey(combined, "Cookie");

                        if (existingCookieKey) {
                                delete combined[existingCookieKey];
                        }
                }
        }

        return combined;
}

async function main() {
        const options = parseCliArgs();

        setLogLevel(options.logLevel);
        logDebug(`Log level set to '${options.logLevel}'.`);
        logVerbose("Runtime options:", summarizeOptionsForLogs(options));

        if (options.help) {
                logHelp();

                if (!options.runSetupWizard) {
                        return;
                }
        }

        if (options.runSetupWizard) {
                await runSetupWizard({
                        configPath: options.configFilePath,
                        existingConfig: isPlainObject(options.rawConfig) ? options.rawConfig : {},
                });
                return;
        }

        if (options.testNordVpn) {
                try {
                        const success = await runNordVpnDiagnostics(options);
                        process.exitCode = success ? 0 : 1;
                } catch (error) {
                        console.error(error.message);
                        process.exitCode = 1;
                }
                return;
        }

        await extractAndExport(options);
}

if (require.main === module) {
        main().catch((error) => {
                console.error("Error inesperado:", error);
                process.exitCode = 1;
        });
}

module.exports = {
        extractLinksDataScripts,
        extractLinksDataFromScript,
        discoverAdditionalUrls,
        collectStreamUrlsFromString,
        decodeResponseBody,
};

function parseYamlScalar(rawValue) {
        const trimmed = rawValue.trim();

        if (trimmed.length === 0) {
                return "";
        }

        if (trimmed === "~" || trimmed.toLowerCase() === "null") {
                return null;
        }

        if (trimmed.toLowerCase() === "true") {
                return true;
        }

        if (trimmed.toLowerCase() === "false") {
                return false;
        }

        if (!Number.isNaN(Number(trimmed)) && trimmed.trim() !== "") {
                return Number(trimmed);
        }

        if (
                (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
                (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ) {
                const isDouble = trimmed.startsWith('"');
                let inner = trimmed.slice(1, -1);

                if (isDouble) {
                        inner = inner
                                .replace(/\\n/g, "\n")
                                .replace(/\\r/g, "\r")
                                .replace(/\\t/g, "\t")
                                .replace(/\\"/g, '"')
                                .replace(/\\\\/g, "\\");
                } else {
                        inner = inner.replace(/''/g, "'");
                }

                return inner;
        }

        return trimmed;
}

function findNextRelevantLine(lines, startIndex) {
        for (let i = startIndex; i < lines.length; i += 1) {
                const withoutComment = stripYamlComment(lines[i]);
                if (!withoutComment || withoutComment.trim().length === 0) {
                        continue;
                }
                const indent = withoutComment.match(/^ */)?.[0].length || 0;
                return {
                        indent,
                        trimmed: withoutComment.trim(),
                };
        }

        return null;
}

function looksLikeKeyValuePair(text) {
        if (typeof text !== "string") {
                return false;
        }

        const colonIndex = text.indexOf(":");

        if (colonIndex === -1) {
                return false;
        }

        const keyPart = text.slice(0, colonIndex).trim();

        if (!keyPart) {
                return false;
        }

        const nextChar = text[colonIndex + 1];

        if (nextChar === undefined) {
                return true;
        }

        return [" ", "\t", "'", '"'].includes(nextChar);
}

function parseSimpleYaml(content) {
        const lines = content.split(/\r?\n/);
        const root = {};
        const stack = [{ indent: -1, container: root }];

        for (let i = 0; i < lines.length; i += 1) {
                const withoutComment = stripYamlComment(lines[i]);

                if (!withoutComment) {
                        continue;
                }

                const indent = withoutComment.match(/^ */)?.[0].length || 0;
                const trimmed = withoutComment.trim();

                if (trimmed.length === 0) {
                        continue;
                }

                while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
                        stack.pop();
                }

                const parent = stack[stack.length - 1].container;

                if (trimmed.startsWith("- ")) {
                        if (!Array.isArray(parent)) {
                                throw new Error(
                                        `Unexpected list item encountered on line ${i + 1}`
                                );
                        }

                        const valuePart = trimmed.slice(2).trim();

                        if (valuePart.length === 0) {
                                const lookAhead = findNextRelevantLine(lines, i + 1);
                                const container =
                                        lookAhead && lookAhead.indent > indent && lookAhead.trimmed.startsWith("- ")
                                                ? []
                                                : {};
                                parent.push(container);
                                stack.push({ indent, container });
                                continue;
                        }

                        if (!looksLikeKeyValuePair(valuePart)) {
                                parent.push(parseYamlScalar(valuePart));
                                continue;
                        }

                        const colonIndex = valuePart.indexOf(":");
                        const key = valuePart.slice(0, colonIndex).trim();
                        const remainder = valuePart.slice(colonIndex + 1).trim();
                        const entry = {};
                        parent.push(entry);
                        stack.push({ indent, container: entry });

                        if (remainder.length === 0) {
                                const lookAhead = findNextRelevantLine(lines, i + 1);
                                entry[key] =
                                        lookAhead && lookAhead.indent > indent && lookAhead.trimmed.startsWith("- ")
                                                ? []
                                                : {};
                                stack.push({ indent: indent + 2, container: entry[key] });
                        } else {
                                entry[key] = parseYamlScalar(remainder);
                                stack.pop();
                        }

                        continue;
                }

                const colonIndex = trimmed.indexOf(":");

                if (colonIndex === -1 || !looksLikeKeyValuePair(trimmed)) {
                        continue;
                }

                const key = trimmed.slice(0, colonIndex).trim();
                const valuePart = trimmed.slice(colonIndex + 1).trim();

                if (valuePart.length === 0) {
                        const lookAhead = findNextRelevantLine(lines, i + 1);
                        const container =
                                lookAhead && lookAhead.indent > indent && lookAhead.trimmed.startsWith("- ")
                                        ? []
                                        : {};
                        parent[key] = container;
                        stack.push({ indent, container });
                        continue;
                }

                parent[key] = parseYamlScalar(valuePart);
        }

        return root;
}

function resolveConfigPath(configPath) {
        if (!configPath) {
                return path.join(__dirname, DEFAULT_CONFIG_FILENAME);
        }

        if (path.isAbsolute(configPath)) {
                return configPath;
        }

        return path.resolve(process.cwd(), configPath);
}

function loadConfigFile(configPath) {
        const resolvedPath = resolveConfigPath(configPath);

        try {
                logDebug(`Attempting to load configuration file from ${resolvedPath}`);

                if (!fs.existsSync(resolvedPath)) {
                        logVerbose(`Configuration file not found at ${resolvedPath}`);
                        return { data: {}, path: resolvedPath, exists: false };
                }

                const raw = fs.readFileSync(resolvedPath, "utf8");

                if (!raw.trim()) {
                        logVerbose(`Configuration file at ${resolvedPath} is empty.`);
                        return { data: {}, path: resolvedPath, exists: true };
                }

                const parsed = parseSimpleYaml(raw);

                if (typeof parsed !== "object" || parsed === null) {
                        logWarn(`Configuration file at ${resolvedPath} did not produce a valid object.`);
                        return { data: {}, path: resolvedPath, exists: true };
                }

                logDebug(`Configuration file at ${resolvedPath} loaded successfully.`);
                return { data: parsed, path: resolvedPath, exists: true };
        } catch (error) {
                logWarn(`Failed to load configuration file (${resolvedPath}): ${error.message}`);
                return { data: {}, path: resolvedPath, exists: false };
        }
}

function isPlainObject(value) {
        return Object.prototype.toString.call(value) === "[object Object]";
}

function stringNeedsQuotes(value) {
        return (
                value === "" ||
                /^\s|\s$/.test(value) ||
                /[:{}\[\],&*#?\-|<>=!%@`]/.test(value) ||
                value.includes("#") ||
                value.includes("\n") ||
                value.includes("\r") ||
                value.includes("\t")
        );
}

function formatYamlKey(key) {
        const stringKey = String(key);

        if (stringNeedsQuotes(stringKey)) {
                return JSON.stringify(stringKey);
        }

        return stringKey;
}

function formatYamlScalar(value) {
        if (value === null) {
                return "null";
        }

        if (value === undefined) {
                return "";
        }

        if (typeof value === "number" && Number.isFinite(value)) {
                return String(value);
        }

        if (typeof value === "boolean") {
                return value ? "true" : "false";
        }

        const stringValue = String(value);

        if (!stringNeedsQuotes(stringValue) && !/^(?:true|false|null)$/i.test(stringValue)) {
                return stringValue;
        }

        return JSON.stringify(stringValue);
}

function yamlSerialize(value, indent = 0, lines = []) {
        const prefix = " ".repeat(indent);

        if (Array.isArray(value)) {
                if (value.length === 0) {
                        lines.push(`${prefix}[]`);
                        return lines;
                }

                for (const item of value) {
                        if (item === undefined) {
                                continue;
                        }

                        if (Array.isArray(item) || isPlainObject(item)) {
                                lines.push(`${prefix}-`);
                                yamlSerialize(item, indent + 2, lines);
                        } else {
                                lines.push(`${prefix}- ${formatYamlScalar(item)}`);
                        }
                }

                return lines;
        }

        if (isPlainObject(value)) {
                        const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);

                        if (entries.length === 0) {
                                lines.push(`${prefix}{}`);
                                return lines;
                        }

                        for (const [key, entryValue] of entries) {
                                if (Array.isArray(entryValue) || isPlainObject(entryValue)) {
                                        lines.push(`${prefix}${formatYamlKey(key)}:`);
                                        yamlSerialize(entryValue, indent + 2, lines);
                                } else {
                                        lines.push(
                                                `${prefix}${formatYamlKey(key)}: ${formatYamlScalar(entryValue)}`
                                        );
                                }
                        }

                        return lines;
        }

        lines.push(`${prefix}${formatYamlScalar(value)}`);
        return lines;
}

function convertToYaml(value) {
        const lines = yamlSerialize(value, 0, []);

        if (lines.length === 0) {
                return "";
        }

        return lines.join("\n") + "\n";
}

function ensureDirectoryExists(filePath) {
        const directory = path.dirname(filePath);

        if (directory && directory !== "." && !fs.existsSync(directory)) {
                fs.mkdirSync(directory, { recursive: true });
        }
}

function buildDiscoveryOutputPath(baseOutputFile) {
        const parsed = path.parse(baseOutputFile || "discovery.json");
        const discoveryFileName = `${parsed.name || "discovery"}-discovered-urls.json`;

        if (parsed.dir && parsed.dir !== ".") {
                return path.join(parsed.dir, discoveryFileName);
        }

        return discoveryFileName;
}

function writeConfigFile(configPath, data) {
        const resolvedPath = resolveConfigPath(configPath);
        ensureDirectoryExists(resolvedPath);
        const yamlContent = convertToYaml(data);

        fs.writeFileSync(resolvedPath, yamlContent, { encoding: "utf8", mode: 0o600 });

        try {
                fs.chmodSync(resolvedPath, 0o600);
        } catch (error) {
                if (error && error.code !== "ENOSYS" && error.code !== "EPERM") {
                        console.warn(
                                `No se pudieron ajustar los permisos de ${resolvedPath}: ${error.message}`
                        );
                }
        }
}

function askQuestion(question, { defaultValue = "", hidden = false, trim = true, showDefault = true } = {}) {
        return new Promise((resolve) => {
                const promptSuffix = defaultValue && showDefault ? ` [${defaultValue}]` : "";
                const finalPrompt = question.endsWith(":") || question.endsWith("?")
                        ? `${question}${promptSuffix} `
                        : `${question}${promptSuffix}: `;

                if (!hidden) {
                        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

                        rl.question(finalPrompt, (answer) => {
                                rl.close();
                                let finalAnswer = trim ? answer.trim() : answer;

                                if (finalAnswer.length === 0 && defaultValue !== undefined) {
                                        finalAnswer = defaultValue;
                                }

                                resolve(finalAnswer);
                        });

                        return;
                }

                const mutableStdout = new Writable({
                        write(chunk, encoding, callback) {
                                const output = chunk.toString();

                                if (!this.muted) {
                                        process.stdout.write(output);
                                } else if (output === "\n" || output === "\r" || output === "\r\n") {
                                        process.stdout.write("\n");
                                } else if (output === "\u0008" || output === "\u007f") {
                                        process.stdout.write("\b \b");
                                } else if (output.startsWith("\u001b")) {
                                        // Ignore escape sequences (arrow keys, etc.)
                                } else {
                                        process.stdout.write("*".repeat(output.length));
                                }

                                callback();
                        },
                });

                const rl = readline.createInterface({
                        input: process.stdin,
                        output: mutableStdout,
                        terminal: true,
                });

                mutableStdout.muted = false;

                rl.question(
                        question.endsWith(":") || question.endsWith("?")
                                ? `${question} `
                                : `${question}: `,
                        (answer) => {
                                rl.close();
                                process.stdout.write("\n");
                                let finalAnswer = trim ? answer.trim() : answer;

                                if (finalAnswer.length === 0 && defaultValue !== undefined) {
                                        finalAnswer = defaultValue;
                                }

                                resolve(finalAnswer);
                        }
                );

                mutableStdout.muted = true;
        });
}

async function askBoolean(question, defaultValue = false) {
        const hint = defaultValue ? "Y/n" : "y/N";

        while (true) {
                const answer = await askQuestion(`${question} (${hint})`, {
                        defaultValue: "",
                        showDefault: false,
                });
                const normalized = answer.trim().toLowerCase();

                if (!normalized) {
                        return defaultValue;
                }

                if (["y", "yes"].includes(normalized)) {
                        return true;
                }

                if (["n", "no"].includes(normalized)) {
                        return false;
                }

                console.log("Invalid response. Please answer with 'y' for yes or 'n' for no.");
        }
}

function splitList(value) {
        if (!value) {
                return [];
        }

        return value
                .split(/[\n,]/)
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
}

async function runSetupWizard({ configPath, existingConfig = {} }) {
        const resolvedPath = resolveConfigPath(configPath || DEFAULT_CONFIG_FILENAME);
        const scraperConfig = isPlainObject(existingConfig.scraper) ? existingConfig.scraper : {};
        const nordConfig = isPlainObject(existingConfig.nordvpn) ? existingConfig.nordvpn : {};

        console.log("===============================================");
        console.log(" IPTV Indexer Setup Wizard");
        console.log("===============================================\n");
        console.log(`The configuration file will be saved to: ${resolvedPath}\n`);

        const existingUrls = Array.isArray(scraperConfig.urls) ? scraperConfig.urls : [];
        const urlsAnswer = await askQuestion("Enter the scraping URLs separated by commas", {
                defaultValue: existingUrls.join(", "),
        });
        const urls = splitList(urlsAnswer);

        const existingCredentials = Array.isArray(scraperConfig.credentials)
                ? scraperConfig.credentials
                : [];
        const credentialsCountAnswer = await askQuestion("How many sites require credentials?", {
                defaultValue: String(existingCredentials.length || 0),
        });
        let credentialsCount = Number(credentialsCountAnswer);

        if (Number.isNaN(credentialsCount) || credentialsCount < 0) {
                credentialsCount = existingCredentials.length;
        }

        const credentials = [];

        for (let i = 0; i < credentialsCount; i += 1) {
                const existingEntry = existingCredentials[i] && isPlainObject(existingCredentials[i])
                        ? existingCredentials[i]
                        : {};
                const site = await askQuestion(`Site #${i + 1} (domain)`, {
                        defaultValue: existingEntry.site || "",
                });
                const loginUrl = await askQuestion(`Login URL for site #${i + 1}`, {
                        defaultValue: existingEntry.loginUrl || "",
                });
                const username = await askQuestion(`Username for ${site || `site #${i + 1}`}`, {
                        defaultValue: existingEntry.username || "",
                });
                console.log(
                        "Enter the password (leave blank to keep the current value, type CLEAR to remove it)."
                );
                const passwordAnswer = await askQuestion("Password", {
                        hidden: true,
                        trim: false,
                });
                let password = existingEntry.password;

                if (passwordAnswer.length > 0) {
                        const normalized = passwordAnswer.trim();
                        if (normalized.toUpperCase() === "CLEAR") {
                                password = "";
                        } else {
                                password = passwordAnswer;
                        }
                }

                const entry = {};

                if (site) {
                        entry.site = site;
                }

                if (loginUrl) {
                        entry.loginUrl = loginUrl;
                }

                if (username) {
                        entry.username = username;
                }

                if (password !== undefined) {
                        entry.password = password;
                }

                if (Object.keys(entry).length > 0) {
                        credentials.push(entry);
                }
        }

        const currentOutput = isPlainObject(scraperConfig.output) ? scraperConfig.output : {};
        let originalOutputFormat = "m3u";

        if (typeof currentOutput.format === "string" && currentOutput.format.trim()) {
                originalOutputFormat = currentOutput.format.trim().toLowerCase();
        } else if (typeof scraperConfig.outputFormat === "string" && scraperConfig.outputFormat.trim()) {
                originalOutputFormat = scraperConfig.outputFormat.trim().toLowerCase();
        }

        const formatAnswer = await askQuestion("Output format (m3u/json)", {
                defaultValue: originalOutputFormat || "m3u",
        });
        let outputFormat = formatAnswer.trim().toLowerCase();

        if (!outputFormat || !["m3u", "json"].includes(outputFormat)) {
                console.log("Unrecognized format. Defaulting to 'm3u'.");
                outputFormat = "m3u";
        }

        const existingOutputFile = (typeof currentOutput.file === "string" && currentOutput.file.trim())
                ? currentOutput.file.trim()
                : (typeof scraperConfig.outputFile === "string" && scraperConfig.outputFile.trim())
                        ? scraperConfig.outputFile.trim()
                        : "";
        const originalFormatDefault =
                originalOutputFormat === "json" ? "playlist.json" : "playlist.m3u";
        let suggestedOutputFile = existingOutputFile;

        if (!suggestedOutputFile) {
                suggestedOutputFile = outputFormat === "json" ? "playlist.json" : "playlist.m3u";
        } else if (outputFormat !== originalOutputFormat && existingOutputFile === originalFormatDefault) {
                suggestedOutputFile = outputFormat === "json" ? "playlist.json" : "playlist.m3u";
        }

        const outputFile = await askQuestion("Output filename", {
                defaultValue: suggestedOutputFile,
        });

        const useProxyDefault = typeof nordConfig.useProxy === "boolean" ? nordConfig.useProxy : false;
        const useProxy = await askBoolean("Do you want to use the NordVPN proxy?", useProxyDefault);
        const proxySource = isPlainObject(nordConfig.proxy) ? nordConfig.proxy : {};
        const proxyHostDefault =
                proxySource.host || proxySource.hostname || nordConfig.host || "";
        const proxyPortDefault = proxySource.port || nordConfig.port || "";
        const proxyUserDefault = proxySource.username || nordConfig.username || "";
        const proxyPasswordDefault =
                proxySource.password !== undefined ? proxySource.password : nordConfig.password;
        const proxyProtocolDefault = proxySource.protocol || nordConfig.protocol || "http";
        let proxySettings;

        if (useProxy) {
                const proxyProtocol = await askQuestion("Proxy protocol (http/https)", {
                        defaultValue: String(proxyProtocolDefault || "http"),
                });
                const proxyHost = await askQuestion("Proxy host", {
                        defaultValue: proxyHostDefault || "",
                });
                const proxyPortAnswer = await askQuestion("Proxy port", {
                        defaultValue: proxyPortDefault ? String(proxyPortDefault) : "",
                });
                const proxyUsername = await askQuestion("Proxy username (optional)", {
                        defaultValue: proxyUserDefault || "",
                });
                console.log(
                        "Enter the proxy password (leave blank to keep it, type CLEAR to remove it)."
                );
                const proxyPasswordAnswer = await askQuestion("Proxy password", {
                        hidden: true,
                        trim: false,
                });
                let proxyPassword = proxyPasswordDefault;

                if (proxyPasswordAnswer.length > 0) {
                        const normalized = proxyPasswordAnswer.trim();
                        if (normalized.toUpperCase() === "CLEAR") {
                                proxyPassword = "";
                        } else {
                                proxyPassword = proxyPasswordAnswer;
                        }
                }

                let proxyPort;
                const parsedPort = Number(proxyPortAnswer);
                if (!Number.isNaN(parsedPort)) {
                        proxyPort = parsedPort;
                }

                proxySettings = {
                        protocol: (proxyProtocol || "http").toLowerCase(),
                        host: proxyHost,
                };

                if (proxyPort !== undefined) {
                        proxySettings.port = proxyPort;
                }

                if (proxyUsername) {
                        proxySettings.username = proxyUsername;
                }

                if (proxyPassword !== undefined) {
                        proxySettings.password = proxyPassword;
                }
        }

        const useCliDefault = typeof nordConfig.useCli === "boolean" ? nordConfig.useCli : false;
        const useCli = await askBoolean(
                "Do you want the script to run the official NordVPN CLI?",
                useCliDefault
        );
        let cliServer = "";
        let cliTimeoutMs;

        if (useCli) {
                const cliServerDefault =
                        nordConfig.cliServer || nordConfig.preferredLocation || "";
                cliServer = await askQuestion("CLI server or location (optional)", {
                        defaultValue: cliServerDefault,
                });
                const cliTimeoutDefault =
                        nordConfig.cliTimeoutMs !== undefined ? String(nordConfig.cliTimeoutMs) : "";
                const timeoutAnswer = await askQuestion("CLI timeout (ms)", {
                        defaultValue: cliTimeoutDefault,
                });
                const parsedTimeout = Number(timeoutAnswer);

                if (!Number.isNaN(parsedTimeout) && parsedTimeout > 0) {
                        cliTimeoutMs = parsedTimeout;
                } else if (timeoutAnswer.trim().length === 0 && nordConfig.cliTimeoutMs !== undefined) {
                        cliTimeoutMs = nordConfig.cliTimeoutMs;
                }
        }

        const finalConfig = isPlainObject(existingConfig) ? { ...existingConfig } : {};
        const preservedScraper = isPlainObject(scraperConfig) ? scraperConfig : {};
        const finalScraper = {};

        for (const [key, value] of Object.entries(preservedScraper)) {
                if (["urls", "credentials", "output", "outputFormat", "outputFile"].includes(key)) {
                        continue;
                }
                finalScraper[key] = value;
        }

        finalScraper.urls = urls;
        finalScraper.credentials = credentials;
        finalScraper.output = {
                format: outputFormat,
                file: outputFile,
        };

        const preservedNord = isPlainObject(nordConfig) ? nordConfig : {};
        const finalNord = {};

        for (const [key, value] of Object.entries(preservedNord)) {
                        if (
                                [
                                        "useProxy",
                                        "proxy",
                                        "host",
                                        "port",
                                        "username",
                                        "password",
                                        "useCli",
                                        "cliServer",
                                        "preferredLocation",
                                        "cliTimeoutMs",
                                ].includes(key)
                        ) {
                                continue;
                        }

                        finalNord[key] = value;
        }

        finalNord.useProxy = useProxy;

        if (useProxy && proxySettings) {
                finalNord.proxy = proxySettings;
        } else {
                delete finalNord.proxy;
        }

        if (useProxy && !proxySettings?.host && nordConfig.host) {
                finalNord.host = nordConfig.host;
                if (nordConfig.port !== undefined) {
                        finalNord.port = nordConfig.port;
                }
                if (nordConfig.username) {
                        finalNord.username = nordConfig.username;
                }
                if (nordConfig.password !== undefined) {
                        finalNord.password = nordConfig.password;
                }
        } else {
                delete finalNord.host;
                delete finalNord.port;
                delete finalNord.username;
                delete finalNord.password;
        }

        finalNord.useCli = useCli;

        if (useCli) {
                if (cliServer) {
                        finalNord.cliServer = cliServer;
                        finalNord.preferredLocation = cliServer;
                } else {
                        delete finalNord.cliServer;
                        delete finalNord.preferredLocation;
                }

                if (cliTimeoutMs !== undefined) {
                        finalNord.cliTimeoutMs = cliTimeoutMs;
                } else if (preservedNord.cliTimeoutMs !== undefined) {
                        finalNord.cliTimeoutMs = preservedNord.cliTimeoutMs;
                } else {
                        delete finalNord.cliTimeoutMs;
                }
        } else {
                delete finalNord.cliServer;
                delete finalNord.preferredLocation;
                delete finalNord.cliTimeoutMs;
        }

        finalConfig.scraper = finalScraper;
        if (Object.keys(finalNord).length > 0) {
                finalConfig.nordvpn = finalNord;
        } else {
                delete finalConfig.nordvpn;
        }

        writeConfigFile(resolvedPath, finalConfig);

        console.log("\nConfiguration saved successfully. Summary:");
        console.log(`- File: ${resolvedPath}`);
        console.log(`- Configured URLs: ${urls.length}`);
        console.log(`- Stored credentials: ${credentials.length}`);
        console.log(`- Output format: ${outputFormat.toUpperCase()} (${outputFile})`);
        console.log(`- NordVPN via proxy: ${useProxy ? 'enabled' : 'disabled'}`);
        console.log(`- NordVPN CLI: ${useCli ? 'enabled' : 'disabled'}`);

        if (urls.length === 0) {
                console.warn("\nWARNING: no URLs were configured. The scraper will not run correctly.");
        }

        return finalConfig;
}

function safeDecodeURIComponent(value) {
        if (typeof value !== "string" || value.length === 0) {
                return "";
        }

        try {
                return decodeURIComponent(value);
        } catch (error) {
                return value;
        }
}

function buildProxyUrlFromParsed(parsedUrl) {
        const hasUser = parsedUrl.username && parsedUrl.username.length > 0;
        const hasPass = parsedUrl.password && parsedUrl.password.length > 0;
        const decodedUser = hasUser ? safeDecodeURIComponent(parsedUrl.username) : "";
        const decodedPass = hasPass ? safeDecodeURIComponent(parsedUrl.password) : "";

        let credentials = "";

        if (hasUser) {
                credentials += encodeURIComponent(decodedUser);
        }

        if (hasPass) {
                credentials += `:${encodeURIComponent(decodedPass)}`;
        }

        if (hasUser || hasPass) {
                credentials += "@";
        }

        const pathname = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;

        return `${parsedUrl.protocol}//${credentials}${parsedUrl.host}${pathname}${parsedUrl.search}${parsedUrl.hash}`;
}

function tryEncodeCredentials(rawUrl) {
        const schemeSeparator = rawUrl.indexOf("://");

        if (schemeSeparator === -1) {
                return null;
        }

        const scheme = rawUrl.slice(0, schemeSeparator + 3);
        const remainder = rawUrl.slice(schemeSeparator + 3);
        const atIndex = remainder.lastIndexOf("@");

        if (atIndex === -1) {
                return null;
        }

        const authPart = remainder.slice(0, atIndex);
        const hostPart = remainder.slice(atIndex + 1);

        if (!hostPart) {
                return null;
        }

        const colonIndex = authPart.indexOf(":");
        const rawUsername = colonIndex === -1 ? authPart : authPart.slice(0, colonIndex);
        const rawPassword = colonIndex === -1 ? "" : authPart.slice(colonIndex + 1);

        const decodedUser = rawUsername ? safeDecodeURIComponent(rawUsername) : "";
        const decodedPass = rawPassword ? safeDecodeURIComponent(rawPassword) : "";

        let credentials = "";

        if (decodedUser) {
                credentials += encodeURIComponent(decodedUser);
        }

        if (rawPassword !== "") {
                credentials += `:${encodeURIComponent(decodedPass)}`;
        }

        if (credentials.length === 0) {
                return null;
        }

        return `${scheme}${credentials}@${hostPart}`;
}

function normalizeProxyUrl(rawUrl) {
        if (!rawUrl) {
                return { url: "" };
        }

        const tryParse = (value) => {
                try {
                        return { parsed: new URL(value) };
                } catch (error) {
                        return { error };
                }
        };

        let { parsed, error } = tryParse(rawUrl);

        if (error) {
                const encodedAttempt = tryEncodeCredentials(rawUrl);

                if (encodedAttempt) {
                        ({ parsed, error } = tryParse(encodedAttempt));
                }

                if (error) {
                        return { error: `Invalid proxy URL: ${error.message}` };
                }
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return { error: "Only HTTP or HTTPS proxies are supported." };
        }

        return { url: buildProxyUrlFromParsed(parsed) };
}

function extractHostnameFromUrl(value) {
        if (!value) {
                return "";
        }

        try {
                return new URL(value).hostname || "";
        } catch (error) {
                return "";
        }
}

function explainNordVpnProxyFailure(error, proxyUrl) {
        if (!error) {
                return null;
        }

        const hostname = extractHostnameFromUrl(proxyUrl) || proxyUrl || "the configured proxy host";

        if (error.code === "ENOTFOUND") {
                return (
                        `[NordVPN Proxy] DNS lookup failed for '${hostname}'. ` +
                        "Update your NordVPN proxy configuration with the exact hostname provided by NordVPN " +
                        "(for example http://user:pass@us1234.nordvpn.com:89) or disable the proxy integration " +
                        "if you only intend to use the CLI tunnel."
                );
        }

        return null;
}

function parseCliArgs() {
        const args = process.argv.slice(2);
        let configPathArg;
        let requestedOutputFormat;
        let requestedOutputFile;
        let runSetupWizard = false;
        let requestedLogLevel;
        let verboseFlagCount = 0;
        let requestedNordVpnTest = false;

        for (const arg of args) {
                if (arg.startsWith('--config=')) {
                        configPathArg = arg.slice('--config='.length);
                } else if (arg === '--setup') {
                        runSetupWizard = true;
                } else if (arg.startsWith('--output-format=')) {
                        requestedOutputFormat = arg.slice('--output-format='.length);
                } else if (arg.startsWith('--output-file=')) {
                        requestedOutputFile = arg.slice('--output-file='.length);
                } else if (arg === '--verbose') {
                        verboseFlagCount += 1;
                } else if (arg === '--debug') {
                        requestedLogLevel = 'debug';
                } else if (arg.startsWith('--log-level=')) {
                        requestedLogLevel = arg.slice('--log-level='.length);
                } else if (arg === '--test-nordvpn') {
                        requestedNordVpnTest = true;
                }
        }

        const envConfigPath = process.env.CONFIG_FILE || process.env.SCRAPER_CONFIG;
        const loadedConfig = loadConfigFile(configPathArg || envConfigPath);
        const fileConfig = isPlainObject(loadedConfig.data) ? loadedConfig.data : {};
        const envOutputFormat = process.env.OUTPUT_FORMAT || process.env.SCRAPER_OUTPUT_FORMAT || '';
        const envOutputFile = process.env.OUTPUT_FILE || process.env.SCRAPER_OUTPUT_FILE || '';
        const envLogLevel = process.env.LOG_LEVEL || process.env.SCRAPER_LOG_LEVEL || '';
        const config = {
                url: process.env.SCRAPER_URL || '',
                urls: [],
                outputFormat: envOutputFormat,
                outputFile: envOutputFile,
                logLevel: envLogLevel,
                testNordVpn:
                        process.env.TEST_NORDVPN === 'true' ||
                        process.env.TEST_NORDVPN === '1',
                useNordVPN:
                        process.env.USE_NORDVPN === 'true' ||
                        process.env.USE_NORDVPN === '1',
                useNordVpnCli:
                        process.env.USE_NORDVPN_CLI === 'true' ||
                        process.env.USE_NORDVPN_CLI === '1',
                nordVpnProxyUrl: process.env.NORDVPN_PROXY_URL || '',
                nordVpnCliServer: process.env.NORDVPN_CLI_SERVER || '',
                nordVpnCliTimeoutMs:
                        process.env.NORDVPN_CLI_TIMEOUT_MS
                                ? Number(process.env.NORDVPN_CLI_TIMEOUT_MS)
                                : undefined,
                loginUrl: process.env.LOGIN_URL || '',
                loginUsername: process.env.LOGIN_USERNAME || '',
                loginPassword: process.env.LOGIN_PASSWORD || '',
                rawLoginPayload: process.env.LOGIN_PAYLOAD || '',
                rawCookies:
                        process.env.SCRAPER_COOKIES ||
                        process.env.COOKIES ||
                        '',
                rawHeaders:
                        process.env.SCRAPER_HEADERS ||
                        process.env.HEADERS ||
                        '',
                savedCredentials: [],
                credentialParseErrors: [],
                loginPayload: null,
                loginPayloadError: '',
                additionalHeaders: {},
                headersParseErrors: [],
                initialCookies: [],
                cookieParseErrors: [],
        };

        config.configFilePath = loadedConfig.path;

        if (loadedConfig.exists) {
                config.loadedConfigPath = loadedConfig.path;
        }

        if (Number.isNaN(config.nordVpnCliTimeoutMs)) {
                config.nordVpnCliTimeoutMs = undefined;
        }

        if (fileConfig && typeof fileConfig === 'object') {
                const scraperConfig = fileConfig.scraper;

                if (scraperConfig && typeof scraperConfig === 'object') {
                        if (!config.url && typeof scraperConfig.url === 'string') {
                                config.url = scraperConfig.url;
                        }

                        if (Array.isArray(scraperConfig.urls)) {
                                config.urls = scraperConfig.urls
                                        .map((item) => (typeof item === 'string' ? item.trim() : ''))
                                        .filter((item) => item.length > 0);
                        }

                        if (!config.loginUrl && typeof scraperConfig.loginUrl === 'string') {
                                config.loginUrl = scraperConfig.loginUrl;
                        }

                        if (!config.loginUsername && typeof scraperConfig.loginUsername === 'string') {
                                config.loginUsername = scraperConfig.loginUsername;
                        }

                        if (!config.loginPassword && typeof scraperConfig.loginPassword === 'string') {
                                config.loginPassword = scraperConfig.loginPassword;
                        }

                        if (!config.rawLoginPayload && typeof scraperConfig.loginPayload === 'string') {
                                config.rawLoginPayload = scraperConfig.loginPayload;
                        }

                        if (!config.rawCookies && typeof scraperConfig.cookies === 'string') {
                                config.rawCookies = scraperConfig.cookies;
                        }

                        if (!config.rawHeaders && typeof scraperConfig.headers === 'string') {
                                config.rawHeaders = scraperConfig.headers;
                        }

                        if (Array.isArray(scraperConfig.credentials)) {
                                const sanitizedCredentials = [];

                                for (const rawEntry of scraperConfig.credentials) {
                                        if (!rawEntry || typeof rawEntry !== 'object') {
                                                continue;
                                        }

                                        const entry = {};

                                        if (typeof rawEntry.site === 'string') {
                                                entry.site = rawEntry.site.trim();
                                        }

                                        if (typeof rawEntry.loginUrl === 'string') {
                                                entry.loginUrl = rawEntry.loginUrl.trim();
                                        }

                                        if (typeof rawEntry.username === 'string') {
                                                const normalizedUsername = rawEntry.username.trim();
                                                if (normalizedUsername) {
                                                        entry.username = normalizedUsername;
                                                }
                                        }

                                        if (typeof rawEntry.password === 'string') {
                                                entry.password = rawEntry.password;
                                        }

                                        if (typeof rawEntry.cookies === 'string') {
                                                entry.cookies = rawEntry.cookies;
                                        }

                                        if (rawEntry.payload !== undefined) {
                                                if (typeof rawEntry.payload === 'string') {
                                                        try {
                                                                entry.payload = JSON.parse(rawEntry.payload);
                                                        } catch (error) {
                                                                config.credentialParseErrors.push(
                                                                        `Invalid JSON payload for credentials entry '${
                                                                                entry.site || entry.loginUrl || 'unknown'
                                                                        }': ${error.message}`
                                                                );
                                                        }
                                                } else if (isPlainObject(rawEntry.payload)) {
                                                        entry.payload = rawEntry.payload;
                                                }
                                        }

                                        if (Object.keys(entry).length > 0) {
                                                sanitizedCredentials.push(entry);
                                        }
                                }

                                config.savedCredentials = sanitizedCredentials;
                        }

                        if (!config.outputFormat && typeof scraperConfig.outputFormat === 'string') {
                                config.outputFormat = scraperConfig.outputFormat;
                        }

                        if (!config.outputFile && typeof scraperConfig.outputFile === 'string') {
                                config.outputFile = scraperConfig.outputFile;
                        }

                        if (isPlainObject(scraperConfig.output)) {
                                if (!config.outputFormat && typeof scraperConfig.output.format === 'string') {
                                        config.outputFormat = scraperConfig.output.format;
                                }

                                if (!config.outputFile && typeof scraperConfig.output.file === 'string') {
                                        config.outputFile = scraperConfig.output.file;
                                }
                        }
                }

                if (!config.logLevel) {
                        const loggingConfig = fileConfig.logging;

                        if (loggingConfig && typeof loggingConfig === 'object') {
                                if (typeof loggingConfig.level === 'string') {
                                        config.logLevel = loggingConfig.level;
                                }
                        }
                }

                const nordConfig = fileConfig.nordvpn;

                if (nordConfig && typeof nordConfig === 'object') {
                        if (typeof nordConfig.useProxy === 'boolean') {
                                config.useNordVPN = nordConfig.useProxy;
                        }

                        if (typeof nordConfig.useCli === 'boolean') {
                                config.useNordVpnCli = nordConfig.useCli;
                        }

                        if (nordConfig.cliTimeoutMs !== undefined) {
                                const parsedTimeout = Number(nordConfig.cliTimeoutMs);
                                if (!Number.isNaN(parsedTimeout)) {
                                        config.nordVpnCliTimeoutMs = parsedTimeout;
                                }
                        }

                        if (!config.nordVpnCliServer) {
                                if (typeof nordConfig.cliServer === 'string' && nordConfig.cliServer.trim()) {
                                        config.nordVpnCliServer = nordConfig.cliServer.trim();
                                } else if (
                                        typeof nordConfig.preferredLocation === 'string' &&
                                        nordConfig.preferredLocation.trim()
                                ) {
                                        config.nordVpnCliServer = nordConfig.preferredLocation.trim();
                                }
                        }

                        if (!config.nordVpnProxyUrl) {
                                if (typeof nordConfig.proxyUrl === 'string' && nordConfig.proxyUrl.trim()) {
                                        config.nordVpnProxyUrl = nordConfig.proxyUrl.trim();
                                } else if (nordConfig.proxy && typeof nordConfig.proxy === 'object') {
                                        const proxy = nordConfig.proxy;
                                        const host = proxy.host || proxy.hostname;
                                        const port = proxy.port;

                                        if (host && port) {
                                                const protocol = proxy.protocol ? String(proxy.protocol) : 'http';
                                                let credentials = '';

                                                if (proxy.username) {
                                                        credentials += encodeURIComponent(String(proxy.username));

                                                        if (proxy.password !== undefined) {
                                                                credentials += `:${encodeURIComponent(
                                                                        String(proxy.password)
                                                                )}`;
                                                        }

                                                        credentials += '@';
                                                }

                                                config.nordVpnProxyUrl = `${protocol}://${credentials}${host}:${port}`;
                                        }
                                }

                                if (!config.nordVpnProxyUrl && nordConfig.host && nordConfig.port) {
                                        const host = nordConfig.host;
                                        const port = nordConfig.port;
                                        let credentials = '';

                                        if (nordConfig.username) {
                                                credentials += encodeURIComponent(String(nordConfig.username));

                                                if (nordConfig.password !== undefined) {
                                                        credentials += `:${encodeURIComponent(
                                                                String(nordConfig.password)
                                                        )}`;
                                                }

                                                credentials += '@';
                                        }

                                        config.nordVpnProxyUrl = `http://${credentials}${host}:${port}`;
                                }
                        }
                }
        }

        const nordVpnHost = process.env.NORDVPN_PROXY_HOST;
        const nordVpnPort = process.env.NORDVPN_PROXY_PORT;
        const nordVpnUser = process.env.NORDVPN_USERNAME;
        const nordVpnPass = process.env.NORDVPN_PASSWORD;

        if (!config.nordVpnProxyUrl && nordVpnHost && nordVpnPort) {
                const credentials =
                        nordVpnUser && nordVpnPass
                                ? `${encodeURIComponent(nordVpnUser)}:${encodeURIComponent(nordVpnPass)}@`
                                : '';
                config.nordVpnProxyUrl = `http://${credentials}${nordVpnHost}:${nordVpnPort}`;
        }

        for (const arg of args) {
                if (arg === '--help') {
                        config.help = true;
                        continue;
                }

                if (arg.startsWith('--config=')) {
                        continue;
                }

                if (arg.startsWith('--url=')) {
                        config.url = arg.slice('--url='.length);
                        continue;
                }

                if (arg === '--use-nordvpn') {
                        config.useNordVPN = true;
                        continue;
                }

                if (arg.startsWith('--nordvpn-proxy=')) {
                        config.nordVpnProxyUrl = arg.slice('--nordvpn-proxy='.length);
                        continue;
                }

                if (arg === '--use-nordvpn-cli') {
                        config.useNordVpnCli = true;
                        continue;
                }

                if (arg.startsWith('--nordvpn-cli=')) {
                        config.useNordVpnCli = true;
                        config.nordVpnCliServer = arg.slice('--nordvpn-cli='.length);
                        continue;
                }

                if (arg === '--test-nordvpn') {
                        config.testNordVpn = true;
                        continue;
                }

                if (arg.startsWith('--nordvpn-cli-timeout=')) {
                        const timeoutMs = Number(arg.slice('--nordvpn-cli-timeout='.length));
                        if (!Number.isNaN(timeoutMs)) {
                                config.nordVpnCliTimeoutMs = timeoutMs;
                        }
                        continue;
                }

                if (arg.startsWith('--login-url=')) {
                        config.loginUrl = arg.slice('--login-url='.length);
                        continue;
                }

                if (arg.startsWith('--login-username=')) {
                        config.loginUsername = arg.slice('--login-username='.length);
                        continue;
                }

                if (arg.startsWith('--login-password=')) {
                        config.loginPassword = arg.slice('--login-password='.length);
                        continue;
                }

                if (arg.startsWith('--login-payload=')) {
                        config.rawLoginPayload = arg.slice('--login-payload='.length);
                        continue;
                }

                if (arg.startsWith('--cookies=')) {
                        config.rawCookies = arg.slice('--cookies='.length);
                        continue;
                }

                if (arg.startsWith('--headers=')) {
                        config.rawHeaders = arg.slice('--headers='.length);
                        continue;
                }

                if (arg === '--setup') {
                        runSetupWizard = true;
                        continue;
                }

                if (arg.startsWith('--output-format=')) {
                        requestedOutputFormat = arg.slice('--output-format='.length);
                        continue;
                }

                if (arg.startsWith('--output-file=')) {
                        requestedOutputFile = arg.slice('--output-file='.length);
                        continue;
                }

                if (arg === '--verbose') {
                        continue;
                }

                if (arg === '--debug') {
                        continue;
                }

                if (arg.startsWith('--log-level=')) {
                        continue;
                }
        }

        if (requestedOutputFormat !== undefined) {
                config.outputFormat = requestedOutputFormat;
        }

        if (requestedOutputFile !== undefined) {
                config.outputFile = requestedOutputFile;
        }

        if (requestedNordVpnTest) {
                config.testNordVpn = true;
        }

        if (typeof config.url === 'string') {
                config.url = config.url.trim();
        }

        if (!Array.isArray(config.urls)) {
                config.urls = [];
        }

        config.urls = config.urls
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter((item) => item.length > 0);

        if (typeof config.outputFormat === 'string') {
                config.outputFormat = config.outputFormat.trim().toLowerCase();
        } else {
                config.outputFormat = '';
        }

        if (!config.outputFormat || !['m3u', 'json'].includes(config.outputFormat)) {
                config.outputFormat = 'm3u';
        }

        if (typeof config.outputFile === 'string') {
                config.outputFile = config.outputFile.trim();
        } else {
                config.outputFile = '';
        }

        if (!config.outputFile) {
                config.outputFile = config.outputFormat === 'json' ? 'playlist.json' : 'playlist.m3u';
        }

        if (typeof config.loginUrl === 'string') {
                config.loginUrl = config.loginUrl.trim();
        } else {
                config.loginUrl = '';
        }

        if (typeof config.loginUsername === 'string') {
                config.loginUsername = config.loginUsername.trim();
        } else {
                config.loginUsername = '';
        }

        if (typeof config.loginPassword === 'string') {
                config.loginPassword = config.loginPassword;
        } else {
                config.loginPassword = '';
        }

        if (typeof config.rawLoginPayload === 'string') {
                config.rawLoginPayload = config.rawLoginPayload.trim();
        } else {
                config.rawLoginPayload = '';
        }

        if (config.rawLoginPayload) {
                try {
                        config.loginPayload = JSON.parse(config.rawLoginPayload);
                        config.loginPayloadError = '';
                } catch (error) {
                        config.loginPayload = null;
                        config.loginPayloadError = error.message;
                }
        } else {
                config.loginPayload = null;
                config.loginPayloadError = '';
        }

        if (typeof config.rawHeaders !== 'string') {
                config.rawHeaders = '';
        }

        if (typeof config.rawCookies !== 'string') {
                config.rawCookies = '';
        }

        const parsedHeaders = parseHeaderList(config.rawHeaders);
        config.additionalHeaders = parsedHeaders.headers;
        config.headersParseErrors = parsedHeaders.errors;

        const parsedCookies = parseCookiesInput(config.rawCookies);
        config.initialCookies = [...parsedHeaders.cookies, ...parsedCookies.cookies];
        config.cookieParseErrors = parsedCookies.errors;

        if (!Array.isArray(config.savedCredentials)) {
                config.savedCredentials = [];
        }

        if (requestedLogLevel) {
                config.logLevel = requestedLogLevel;
        } else if (verboseFlagCount > 0) {
                config.logLevel = verboseFlagCount > 1 ? 'debug' : 'verbose';
        }

        config.logLevel = normalizeLogLevel(config.logLevel || 'info');
        config.runSetupWizard = runSetupWizard;
        config.rawConfig = fileConfig;

        if (config.nordVpnProxyUrl) {
                const normalized = normalizeProxyUrl(config.nordVpnProxyUrl);

                if (normalized.error) {
                        config.proxyValidationError = normalized.error;
                } else {
                        config.nordVpnProxyUrl = normalized.url;
                }
        }

        return config;
}

function logHelp() {
        console.log(`Usage: node main.js --url=<URL> [options]\n\n` +
                `Options:\n` +
                `  --url=<URL>             URL to scrape (also SCRAPER_URL).\n` +
                `  --config=<path>         Path to the YAML configuration file (default ./config.yaml).\n` +
                `  --output-format=<fmt>   Output format (m3u or json).\n` +
                `  --output-file=<path>    Output file for the playlist.\n` +
                `  --verbose               Increase logging verbosity (repeat for more detail).\n` +
                `  --debug                 Enable the most detailed logging output.\n` +
                `  --log-level=<level>     Set log level (silent, error, warn, info, verbose, debug).\n` +
                `  --use-nordvpn           Force the use of the NordVPN proxy.\n` +
                `  --nordvpn-proxy=<URL>   Full proxy URL (e.g. http://user:pass@host:port).\n` +
                `  --use-nordvpn-cli       Start and verify the connection using the NordVPN CLI.\n` +
                `  --nordvpn-cli=<server>  Connect via CLI to the specified server.\n` +
                `  --nordvpn-cli-timeout=<ms> Max time for the CLI to connect (default 60000 ms).\n` +
                `  --login-url=<URL>        Login endpoint to call before scraping.\n` +
                `  --login-username=<user>  Username for the login payload.\n` +
                `  --login-password=<pass>  Password for the login payload.\n` +
                `  --login-payload=<json>   Raw JSON body to send to the login endpoint.\n` +
                `  --cookies="a=b; c=d"     Semicolon-separated cookies to include with every request.\n` +
                `  --headers="Key: Value"  Additional headers separated by semicolons or new lines.\n` +
                `  --test-nordvpn          Run a connectivity test for the configured NordVPN workflow and exit.\n` +
                `  --setup                 Launch the interactive wizard to generate config.yaml.\n` +
                `  --help                  Show this help message.\n\n` +
                `Environment variables:\n` +
                `  CONFIG_FILE             Path to the YAML configuration file.\n` +
                `  SCRAPER_CONFIG          Alias for CONFIG_FILE.\n` +
                `  OUTPUT_FORMAT           Force the output format (m3u/json).\n` +
                `  OUTPUT_FILE             Set the output file.\n` +
                `  LOG_LEVEL               Set the log verbosity (silent/error/warn/info/verbose/debug).\n` +
                `  LOGIN_URL               Authentication endpoint to call before scraping.\n` +
                `  LOGIN_USERNAME          Username for the login payload.\n` +
                `  LOGIN_PASSWORD          Password for the login payload.\n` +
                `  LOGIN_PAYLOAD           Raw JSON body to send to the login endpoint.\n` +
                `  SCRAPER_COOKIES         Semicolon-separated cookies for every request (alias: COOKIES).\n` +
                `  SCRAPER_HEADERS         Additional headers (alias: HEADERS).\n` +
                `  USE_NORDVPN=true        Enable the use of NordVPN.\n` +
                `  NORDVPN_PROXY_URL       HTTP(S) proxy provided by NordVPN.\n` +
                `  NORDVPN_PROXY_HOST      NordVPN proxy host.\n` +
                `  NORDVPN_PROXY_PORT      NordVPN proxy port.\n` +
                `  NORDVPN_USERNAME        Proxy username (if applicable).\n` +
                `  NORDVPN_PASSWORD        Proxy password (if applicable).\n` +
                `  USE_NORDVPN_CLI=true    Run the NordVPN CLI before scraping.\n` +
                `  NORDVPN_CLI_SERVER      Server the CLI should connect to (optional).\n` +
                `  NORDVPN_CLI_TIMEOUT_MS  Max wait time for the CLI connection.\n` +
                `  TEST_NORDVPN=true       Run the NordVPN connectivity diagnostics on startup.\n\n` +
                `The configuration file can define multiple URLs (scraper.urls) and NordVPN credentials, ` +
                `including parameters such as nordvpn.cliServer.\n\n` +
                `Whenever sub-URLs are discovered on a page, they are exported to a '<output>-discovered-urls.json' report.`);
}

function maskProxyUrl(proxyUrl) {
        try {
                const url = new URL(proxyUrl);
                if (url.username || url.password) {
                        url.password = url.password ? "***" : "";
                        url.username = url.username ? "***" : "";
                }
                return url.toString();
        } catch (error) {
                return proxyUrl;
        }
}

function summarizeOptionsForLogs(options) {
        const {
                configFilePath,
                loadedConfigPath,
                url,
                urls,
                outputFormat,
                outputFile,
                logLevel,
                testNordVpn,
                useNordVPN,
                useNordVpnCli,
                nordVpnProxyUrl,
                nordVpnCliServer,
                nordVpnCliTimeoutMs,
                loginUrl,
                loginPayload,
                initialCookies,
                additionalHeaders,
                savedCredentials,
        } = options;

        return {
                configFilePath,
                loadedConfigPath,
                primaryUrl: url || null,
                urlsCount: Array.isArray(urls) ? urls.length : 0,
                outputFormat,
                outputFile,
                logLevel,
                testNordVpn: Boolean(testNordVpn),
                useNordVPN: Boolean(useNordVPN),
                useNordVpnCli: Boolean(useNordVpnCli),
                nordVpnProxyUrl: nordVpnProxyUrl ? maskProxyUrl(nordVpnProxyUrl) : null,
                nordVpnCliServer: nordVpnCliServer || null,
                nordVpnCliTimeoutMs: nordVpnCliTimeoutMs || null,
                loginUrl: loginUrl || null,
                loginPayloadKeys:
                        loginPayload && typeof loginPayload === 'object'
                                ? Object.keys(loginPayload)
                                : null,
                initialCookieCount: Array.isArray(initialCookies) ? initialCookies.length : 0,
                additionalHeaderCount:
                        additionalHeaders && typeof additionalHeaders === 'object'
                                ? Object.keys(additionalHeaders).length
                                : 0,
                savedCredentialsCount: Array.isArray(savedCredentials)
                        ? savedCredentials.length
                        : 0,
        };
}

function execNordVpn(args, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
                logDebug(
                        `[NordVPN CLI] Executing command: nordvpn ${args.join(' ') || '(no arguments)'}`,
                        `with timeout ${timeoutMs}ms`
                );
                execFile("nordvpn", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
                        if (error) {
                                const enrichedError = new Error(
                                        `Error running 'nordvpn ${args.join(" ")}'. ${error.message}`
                                );
                                const trimmedStdout = (stdout || "").trim();
                                const trimmedStderr = (stderr || "").trim();
                                logDebug(
                                        `[NordVPN CLI] Command failed with stdout='${trimmedStdout}' stderr='${trimmedStderr}'`
                                );
                                enrichedError.stdout = stdout;
                                enrichedError.stderr = stderr;
                                enrichedError.code = error.code;
                                enrichedError.killed = error.killed;
                                return reject(enrichedError);
                        }

                        const trimmedStdout = (stdout || "").trim();
                        const trimmedStderr = (stderr || "").trim();
                        logDebug(
                                `[NordVPN CLI] Command succeeded with stdout='${trimmedStdout}' stderr='${trimmedStderr}'`
                        );
                        resolve({ stdout, stderr });
                });
        });
}

function explainNordVpnCliFailure(error) {
        if (!error) {
                return null;
        }

        const stdout = typeof error.stdout === "string" ? error.stdout : "";
        const stderr = typeof error.stderr === "string" ? error.stderr : "";
        const combinedOutput = `${stdout}\n${stderr}`.toLowerCase();

        if (combinedOutput.includes("you are not logged in")) {
                return (
                        "[NordVPN CLI] Authentication required. Run `nordvpn login` or " +
                        "`nordvpn login --token <TOKEN>` in a separate shell, then retry."
                );
        }

        if (combinedOutput.includes("a new version of nordvpn is available")) {
                return (
                        "[NordVPN CLI] The client reports that an update is required. " +
                        "Follow NordVPN's Linux update instructions (https://support.nordvpn.com/) " +
                        "to install the latest release before retrying."
                );
        }

        return null;
}

function isNordVpnConnected(cliOutput, expectedServer) {
        const normalizedOutput = cliOutput.toLowerCase();

        if (!normalizedOutput.includes("status: connected")) {
                return false;
        }

        if (!expectedServer) {
                return true;
        }

        return normalizedOutput.includes(expectedServer.toLowerCase());
}

async function ensureNordVpnCliConnection({ server, timeoutMs = 60000 }) {
        console.log("[NordVPN CLI] Starting connection verification...");
        logVerbose(
                `[NordVPN CLI] Desired server: ${server || 'default (automatic)'} | Timeout: ${timeoutMs}ms`
        );

        try {
                await execNordVpn(["connect", server].filter(Boolean), timeoutMs);
        } catch (error) {
                const friendlyMessage = explainNordVpnCliFailure(error);

                if (friendlyMessage) {
                        throw new Error(friendlyMessage);
                }

                throw new Error(
                        `[NordVPN CLI] Failed to start the connection: ${error.message}. ` +
                                (error.stderr ? `Details: ${error.stderr}` : "")
                );
        }

        const pollInterval = 2000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
                try {
                        const { stdout } = await execNordVpn(["status"], timeoutMs);
                        if (isNordVpnConnected(stdout, server)) {
                                console.log("[NordVPN CLI] Connection established successfully.");
                                return;
                        }
                        const trimmedStatus = (stdout || "").trim();
                        console.log("[NordVPN CLI] Still connecting...", trimmedStatus);
                        logDebug(
                                `[NordVPN CLI] Status poll output (length ${trimmedStatus.length}): ${trimmedStatus}`
                        );
                } catch (error) {
                        console.warn(
                                `[NordVPN CLI] Error checking status (${error.message}). Will keep trying...`
                        );
                        logDebug(
                                `[NordVPN CLI] Status poll failed with code ${error.code ?? 'N/A'} and stderr '${
                                        (error.stderr || '').trim()
                                }'`
                        );
                }

                await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        throw new Error(
                `[NordVPN CLI] Timed out after ${timeoutMs} ms while waiting for the connection.`
        );
}

async function verifyNordVpnProxyConnection(proxyUrl) {
        if (!proxyUrl) {
                throw new Error("NordVPN proxy URL is not configured.");
        }

        console.log(
                `[NordVPN Proxy] Testing connectivity using ${maskProxyUrl(proxyUrl)} against ${DEFAULT_IP_CHECK_URL}`
        );

        try {
                const response = await fetchWithOptionalProxy(DEFAULT_IP_CHECK_URL, {
                        proxyUrl,
                });

                if (response.statusCode !== 200) {
                        throw new Error(
                                `Unexpected response status ${response.statusCode} from IP check service.`
                        );
                }

                let reportedIp = "unknown";

                try {
                        const data = JSON.parse(response.body || "{}");
                        if (data && typeof data.ip === "string" && data.ip.trim()) {
                                reportedIp = data.ip.trim();
                        }
                } catch (parseError) {
                        throw new Error(
                                `Failed to parse response from IP check service: ${parseError.message}`
                        );
                }

                console.log(
                        `[NordVPN Proxy] Connectivity verified successfully. Reported exit IP: ${reportedIp}`
                );
        } catch (error) {
                const friendlyMessage = explainNordVpnProxyFailure(error, proxyUrl);

                if (friendlyMessage) {
                        throw new Error(friendlyMessage);
                }

                throw new Error(`[NordVPN Proxy] Connectivity test failed: ${error.message}`);
        }
}

async function runNordVpnDiagnostics(options) {
        console.log("Starting NordVPN connectivity diagnostics...\n");

        const {
                useNordVpnCli,
                useNordVPN,
                nordVpnCliServer,
                nordVpnCliTimeoutMs,
                nordVpnProxyUrl,
                proxyValidationError,
        } = options;

        if (!useNordVpnCli && !useNordVPN) {
                console.log(
                        "NordVPN usage is disabled. Enable --use-nordvpn or --use-nordvpn-cli to run diagnostics."
                );
                return false;
        }

        let cliVerified = !useNordVpnCli;
        let proxyVerified = !useNordVPN;

        if (useNordVpnCli) {
                console.log("[NordVPN CLI] Checking current connection status...");

                try {
                        const { stdout } = await execNordVpn(["status"], nordVpnCliTimeoutMs || 15000);

                        if (isNordVpnConnected(stdout, nordVpnCliServer)) {
                                console.log("[NordVPN CLI] Status indicates an active VPN connection.");
                                cliVerified = true;
                        }

                        if (!cliVerified) {
                                console.log(
                                        "[NordVPN CLI] No active connection detected. Attempting to establish a new session..."
                                );

                                await ensureNordVpnCliConnection({
                                        server: nordVpnCliServer,
                                        timeoutMs: nordVpnCliTimeoutMs || 60000,
                                });

                                console.log("[NordVPN CLI] Connection established and verified successfully.");
                                cliVerified = true;
                        }
                } catch (error) {
                        if (error && error.code === "ENOENT") {
                                throw new Error(
                                        "[NordVPN CLI] Diagnostics failed: The 'nordvpn' command is not available in PATH."
                                );
                        }

                        const friendlyMessage = explainNordVpnCliFailure(error);

                        if (friendlyMessage) {
                                throw new Error(friendlyMessage);
                        }

                        throw new Error(`[NordVPN CLI] Diagnostics failed: ${error.message}`);
                }
        }

        if (useNordVPN) {
                if (proxyValidationError) {
                        throw new Error(proxyValidationError);
                }

                await verifyNordVpnProxyConnection(nordVpnProxyUrl);
                proxyVerified = true;
        }

        return cliVerified && proxyVerified;
}

function collectStream(stream) {
        return new Promise((resolve, reject) => {
                const chunks = [];
                stream.on("data", (chunk) => {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                stream.on("end", () => {
                        resolve(Buffer.concat(chunks));
                });
                stream.on("error", (error) => {
                        reject(error);
                });
        });
}

function parseRawHeaders(headerText) {
        const headers = {};
        const lines = headerText.split(/\r?\n/).filter(Boolean);

        for (const line of lines) {
                const separatorIndex = line.indexOf(":");

                if (separatorIndex === -1) {
                        continue;
                }

                const key = line.slice(0, separatorIndex).trim().toLowerCase();
                const value = line.slice(separatorIndex + 1).trim();

                if (headers[key]) {
                        if (Array.isArray(headers[key])) {
                                headers[key].push(value);
                        } else {
                                headers[key] = [headers[key], value];
                        }
                } else {
                        headers[key] = value;
                }
        }

        return headers;
}

function performDirectRequest(urlObject, headers, method = "GET", body) {
        return new Promise((resolve, reject) => {
                const isHttps = urlObject.protocol === "https:";
                const transport = isHttps ? https : http;
                const finalHeaders = mergeHeaders(headers, {
                        Host: urlObject.host,
                        Connection: "close",
                });
                const request = transport.request(
                        {
                                protocol: urlObject.protocol,
                                hostname: urlObject.hostname,
                                port: urlObject.port || (isHttps ? 443 : 80),
                                path: `${urlObject.pathname || "/"}${urlObject.search || ""}`,
                                method,
                                headers: finalHeaders,
                        },
                        (response) => {
                                collectStream(response)
                                        .then((buffer) => {
                                                resolve({
                                                        statusCode: response.statusCode || 0,
                                                        headers: response.headers,
                                                        body: decodeResponseBody(buffer, response.headers),
                                                });
                                        })
                                        .catch(reject);
                        }
                );

                request.on("error", reject);
                if (body && body.length > 0) {
                        request.end(body);
                } else {
                        request.end();
                }
        });
}

function getProxyAuthorizationHeader(proxyObject) {
        if (!proxyObject.username && !proxyObject.password) {
                return null;
        }

        const user = proxyObject.username ? safeDecodeURIComponent(proxyObject.username) : "";
        const pass = proxyObject.password ? safeDecodeURIComponent(proxyObject.password) : "";
        const token = Buffer.from(`${user}:${pass}`).toString("base64");
        return `Basic ${token}`;
}

function performHttpRequestThroughProxy(urlObject, proxyObject, headers, method = "GET", body) {
        return new Promise((resolve, reject) => {
                const proxyTransport = proxyObject.protocol === "https:" ? https : http;
                const authorization = getProxyAuthorizationHeader(proxyObject);
                const requestHeaders = mergeHeaders(headers, {
                        Host: urlObject.host,
                        Connection: "close",
                });

                if (authorization) {
                        requestHeaders["Proxy-Authorization"] = authorization;
                }

                const request = proxyTransport.request(
                        {
                                protocol: proxyObject.protocol,
                                hostname: proxyObject.hostname,
                                port: proxyObject.port || (proxyObject.protocol === "https:" ? 443 : 80),
                                method,
                                path: urlObject.toString(),
                                headers: requestHeaders,
                        },
                        (response) => {
                                collectStream(response)
                                        .then((buffer) => {
                                                resolve({
                                                        statusCode: response.statusCode || 0,
                                                        headers: response.headers,
                                                        body: decodeResponseBody(buffer, response.headers),
                                                });
                                        })
                                        .catch(reject);
                        }
                );

                request.on("error", reject);
                if (body && body.length > 0) {
                        request.end(body);
                } else {
                        request.end();
                }
        });
}

function performHttpsRequestThroughProxy(urlObject, proxyObject, headers, method = "GET", body) {
        return new Promise((resolve, reject) => {
                const proxyTransport = proxyObject.protocol === "https:" ? https : http;
                const authorization = getProxyAuthorizationHeader(proxyObject);
                const connectHeaders = {};

                if (authorization) {
                        connectHeaders["Proxy-Authorization"] = authorization;
                }

                const connectRequest = proxyTransport.request({
                        protocol: proxyObject.protocol,
                        hostname: proxyObject.hostname,
                        port: proxyObject.port || (proxyObject.protocol === "https:" ? 443 : 80),
                        method: "CONNECT",
                        path: `${urlObject.hostname}:${urlObject.port || 443}`,
                        headers: connectHeaders,
                });

                connectRequest.once("connect", (response, socket) => {
                        if (response.statusCode !== 200) {
                                socket.destroy();
                                reject(
                                        new Error(
                                                `Proxy CONNECT failed with status code ${response.statusCode}`
                                        )
                                );
                                return;
                        }

                        const tlsSocket = tls.connect({
                                socket,
                                servername: urlObject.hostname,
                        });

                        tlsSocket.once("error", reject);

                        tlsSocket.once("secureConnect", () => {
                                const finalHeaders = mergeHeaders(headers, {
                                        Host: urlObject.host,
                                        Connection: "close",
                                });
                                const headerLines = [
                                        `${method} ${urlObject.pathname || "/"}${urlObject.search || ""} HTTP/1.1`,
                                ];

                                for (const [key, value] of Object.entries(finalHeaders)) {
                                        headerLines.push(`${key}: ${value}`);
                                }

                                headerLines.push("", "");
                                const headerPayload = headerLines.join("\r\n");
                                tlsSocket.write(headerPayload);

                                if (body && body.length > 0) {
                                        tlsSocket.write(body);
                                }
                        });

                        collectStream(tlsSocket)
                                .then((buffer) => {
                                        const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));

                                        if (separator === -1) {
                                                throw new Error("Invalid response from HTTPS server.");
                                        }

                                        const headerText = buffer
                                                .slice(0, separator)
                                                .toString("utf8");
                                        const bodyBuffer = buffer.slice(separator + 4);
                                        const statusLine = headerText.split(/\r?\n/, 1)[0] || "";
                                        const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/i);
                                        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
                                        const headersObject = parseRawHeaders(
                                                headerText.replace(/^.*?\r?\n/, "")
                                        );

                                        resolve({
                                                statusCode,
                                                headers: headersObject,
                                                body: decodeResponseBody(bodyBuffer, headersObject),
                                        });
                                })
                                .catch(reject)
                                .finally(() => {
                                        tlsSocket.end();
                                });
                });

                connectRequest.on("error", reject);
                connectRequest.end();
        });
}

async function fetchWithOptionalProxy(
        url,
        { headers = {}, proxyUrl, method = "GET", body } = {}
) {
        const urlObject = new URL(url);
        const requestHeaders = mergeHeaders({}, headers);
        const normalizedMethod = typeof method === "string" && method ? method.toUpperCase() : "GET";
        let requestBody;

        if (body !== undefined && body !== null) {
                if (Buffer.isBuffer(body)) {
                        requestBody = body;
                } else if (body instanceof Uint8Array) {
                        requestBody = Buffer.from(body);
                } else if (typeof body === "string") {
                        requestBody = Buffer.from(body, "utf8");
                } else {
                        requestBody = Buffer.from(String(body));
                }
        }

        logVerbose(
                `Preparing request for ${urlObject.href} via ${proxyUrl ? 'proxy' : 'direct connection'}.`
        );
        logDebug(
                `Request headers for ${urlObject.href}: ${JSON.stringify(requestHeaders, null, 2)}`
        );

        if (!hasHeader(requestHeaders, "User-Agent")) {
                setOrReplaceHeader(requestHeaders, "User-Agent", DEFAULT_USER_AGENT);
        }

        if (requestBody && !hasHeader(requestHeaders, "Content-Length")) {
                setOrReplaceHeader(requestHeaders, "Content-Length", String(requestBody.length));
        }

        if (!proxyUrl) {
                logVerbose(`Performing direct request to ${urlObject.href}`);
                return performDirectRequest(urlObject, requestHeaders, normalizedMethod, requestBody);
        }

        const proxyObject = new URL(proxyUrl);
        logVerbose(`Performing proxied request to ${urlObject.href} via ${maskProxyUrl(proxyUrl)}`);

        if (urlObject.protocol === "http:") {
                return performHttpRequestThroughProxy(
                        urlObject,
                        proxyObject,
                        requestHeaders,
                        normalizedMethod,
                        requestBody
                );
        }

        return performHttpsRequestThroughProxy(
                urlObject,
                proxyObject,
                requestHeaders,
                normalizedMethod,
                requestBody
        );
}

const MAX_EXTERNAL_SCRIPT_FETCHES = 10;
const STREAM_URL_MARKER_REGEX =
        /https?:\/\/[^\s"'<>]+(?:\.m3u8|\.mpd|\/manifest(?:\.m3u8|\.mpd)?|\/master\.m3u8)/i;
const MAX_DISCOVERED_PER_PAGE = 10;
const MAX_TOTAL_DISCOVERED_URLS = 50;

async function extractLinksDataScripts(
        html,
        { baseUrl, fetchExternalScript } = {}
) {
        const results = [];
        const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let match;
        let index = 0;
        const externalScripts = [];
        const seenExternalUrls = new Set();

        while ((match = scriptRegex.exec(html)) !== null) {
                const attributes = match[1] || "";
                const content = match[2] || "";
                const isNuxtDataPayload = isNuxtDataPayloadScript(attributes);

                if (hasLinkDataMarker(content) || isNuxtDataPayload) {
                        const normalizedContent = isNuxtDataPayload ? content.trim() : content;

                        if (normalizedContent.length > 0) {
                                results.push({ index, content: normalizedContent });
                        }
                        index += 1;
                        continue;
                }

                const srcValue = extractAttributeValue(attributes, "src");

                if (
                        !srcValue ||
                        typeof baseUrl !== "string" ||
                        typeof fetchExternalScript !== "function"
                ) {
                        index += 1;
                        continue;
                }

                if (!shouldFetchExternalScript(srcValue)) {
                        index += 1;
                        continue;
                }

                const resolvedUrl = resolveScriptUrl(srcValue, baseUrl);

                if (!resolvedUrl || seenExternalUrls.has(resolvedUrl)) {
                        index += 1;
                        continue;
                }

                externalScripts.push({ index, url: resolvedUrl, originalSrc: srcValue });
                seenExternalUrls.add(resolvedUrl);
                index += 1;
        }

        if (externalScripts.length === 0) {
                return results;
        }

        if (externalScripts.length > MAX_EXTERNAL_SCRIPT_FETCHES) {
                logWarn(
                        `Detected ${externalScripts.length} external scripts with potential channel data. ` +
                                `Only the first ${MAX_EXTERNAL_SCRIPT_FETCHES} will be inspected.`
                );
        }

        const scriptsToFetch = externalScripts.slice(0, MAX_EXTERNAL_SCRIPT_FETCHES);

        for (const scriptInfo of scriptsToFetch) {
                try {
                        logDebug(
                                `Fetching external script ${scriptInfo.url} (discovered at index ${scriptInfo.index}).`
                        );
                        const response = await fetchExternalScript(scriptInfo.url);

                        if (!response || response.statusCode !== 200) {
                                logDebug(
                                        `External script ${scriptInfo.url} returned status ${
                                                response ? response.statusCode : "<no response>"
                                        }.`
                                );
                                continue;
                        }

                        const body = response.body || "";

                        if (!hasLinkDataMarker(body)) {
                                logDebug(
                                        `External script ${scriptInfo.url} did not contain recognizable channel markers.`
                                );
                                continue;
                        }

                        results.push({
                                index: scriptInfo.index,
                                content: body,
                        });
                } catch (error) {
                        logDebug(
                                `Failed to inspect external script ${scriptInfo.url}: ${error.message}`
                        );
                }
        }

        return results;
}

function extractAttributeValue(attributes, attributeName) {
        if (!attributes || typeof attributes !== "string") {
                return null;
        }

        const regex = new RegExp(
                `${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
                "i"
        );
        const match = attributes.match(regex);

        if (!match) {
                return null;
        }

        return match[1] ?? match[2] ?? match[3] ?? null;
}

function shouldFetchExternalScript(srcValue) {
        if (typeof srcValue !== "string") {
                return false;
        }

        const trimmed = srcValue.trim();

        if (trimmed.length === 0) {
                return false;
        }

        if (trimmed.startsWith("javascript:")) {
                return false;
        }

        if (trimmed.startsWith("data:")) {
                return false;
        }

        return true;
}

function resolveScriptUrl(srcValue, baseUrl) {
        try {
                const resolved = new URL(srcValue, baseUrl);
                return resolved.href;
        } catch (error) {
                logDebug(
                        `Could not resolve external script URL '${srcValue}' against base '${baseUrl}': ${
                                error.message
                        }`
                );
                return null;
        }
}

function isNuxtDataPayloadScript(attributes) {
        if (typeof attributes !== "string" || attributes.length === 0) {
                return false;
        }

        if (!/__nuxt_data__/i.test(attributes)) {
                return false;
        }

        return true;
}

function hasLinkDataMarker(scriptContent) {
        if (typeof scriptContent !== "string" || scriptContent.length === 0) {
                return false;
        }

        const normalized = scriptContent.toLowerCase();

        return (
                normalized.includes("linksdata") ||
                normalized.includes("__nuxt__") ||
                normalized.includes("acestream://") ||
                STREAM_URL_MARKER_REGEX.test(scriptContent) ||
                normalized.includes("streamingurl") ||
                normalized.includes("playbackurl")
        );
}

function decodeEscapedLinkValue(value) {
        if (typeof value !== "string") {
                return "";
        }

        let result = value.trim();

        if (result.length === 0) {
                return "";
        }

        result = result
                .replace(/&quot;/gi, '"')
                .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => {
                        const code = Number.parseInt(hex, 16);
                        return Number.isNaN(code) ? match : String.fromCharCode(code);
                })
                .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
                        const code = Number.parseInt(hex, 16);
                        return Number.isNaN(code) ? match : String.fromCharCode(code);
                })
                .replace(/\\\//g, "/")
                .replace(/https?:\/\/{2,}/gi, (match) => match.replace(/\/+/g, "//"));

        result = result.trim().replace(/^["']+/, "").replace(/["']+$/, "");

        return result.trim();
}

function sanitizeRawString(value) {
        const decoded = decodeEscapedLinkValue(value);

        if (decoded.length === 0) {
                return "";
        }

        return decoded
                .replace(/\\u0026/gi, "&")
                .replace(/&amp;/gi, "&")
                .replace(/\s+/g, " ")
                .trim();
}

function normalizeStreamUrl(rawUrl) {
        if (typeof rawUrl !== "string") {
                return null;
        }

        let normalized = sanitizeRawString(rawUrl)
                .replace(/^"+|"+$/g, "")
                .replace(/^'+|'+$/g, "")
                .replace(/[),;]+$/g, "")
                .replace(/[\])}]+$/g, "");

        if (!/^https?:\/\//i.test(normalized)) {
                return null;
        }

        if (normalized.toLowerCase().startsWith("acestream://")) {
                return null;
        }

        return normalized;
}

function isSupportedStreamUrl(url) {
        if (typeof url !== "string") {
                return false;
        }

        const lower = url.toLowerCase();

        if (!/^https?:\/\//.test(url)) {
                return false;
        }

        if (lower.includes("acestream://")) {
                return false;
        }

        if (/(?:\.m3u8|\.mpd)/.test(lower)) {
                return true;
        }

        if (/\.ism\/manifest/.test(lower)) {
                return true;
        }

        if (/\/manifest\.(?:m3u8|mpd)/.test(lower)) {
                return true;
        }

        if (/(?:format|type|protocol)=(?:hls|dash|m3u8|mpd)/.test(lower)) {
                return true;
        }

        if (/mime(?:type|)=application%2fx-mpegurl/.test(lower)) {
                return true;
        }

        return false;
}

function collectStreamUrlsFromString(rawValue) {
        if (typeof rawValue !== "string") {
                return [];
        }

        const sanitized = sanitizeRawString(rawValue);

        if (sanitized.length === 0) {
                return [];
        }

        const matches = [];
        const regex = /https?:\/\/[^\s"'<>\\)]+/gi;
        let match;

        while ((match = regex.exec(sanitized)) !== null) {
                const candidate = normalizeStreamUrl(match[0]);

                if (candidate && isSupportedStreamUrl(candidate)) {
                        matches.push(candidate);
                }
        }

        if (matches.length > 0) {
                return matches;
        }

        const fallback = normalizeStreamUrl(sanitized);

        if (fallback && isSupportedStreamUrl(fallback)) {
                return [fallback];
        }

        return [];
}

function extractLinksDataFromScript(scriptContent) {
        if (typeof scriptContent !== "string" || scriptContent.length === 0) {
                return null;
        }

        const legacyLinksData = parseLegacyLinksData(scriptContent);
        if (legacyLinksData) {
                return legacyLinksData;
        }

        const nuxtLinksData = parseNuxtLinksData(scriptContent);
        if (nuxtLinksData) {
                return nuxtLinksData;
        }

        return null;
}

function parseLegacyLinksData(scriptContent) {
        const regex = /(?:const|var|let)\s+linksData\s*=\s*({[\s\S]*?});/;
        const match = scriptContent.match(regex);

        if (!match) {
                return null;
        }

        const linksDataString = match[1];

        try {
                return vm.runInNewContext(`(${linksDataString})`, {});
        } catch (error) {
                logDebug("Failed to evaluate legacy linksData script:", error.message);
                return null;
        }
}

function parseNuxtLinksData(scriptContent) {
        const nuxtState = extractNuxtState(scriptContent) || parseNuxtPayloadScript(scriptContent);

        if (!nuxtState) {
                return null;
        }

        const links = extractLinksFromNuxtState(nuxtState);

        if (links.length === 0) {
                return null;
        }

        return { links };
}

function extractNuxtState(scriptContent) {
        const sandboxWindow = {};
        sandboxWindow.window = sandboxWindow;
        sandboxWindow.self = sandboxWindow;
        sandboxWindow.globalThis = sandboxWindow;

        const sandbox = {
                window: sandboxWindow,
                self: sandboxWindow,
                globalThis: sandboxWindow,
                console: {
                        log: () => {},
                        info: () => {},
                        warn: () => {},
                        error: () => {},
                        debug: () => {},
                },
        };

        try {
                vm.runInNewContext(scriptContent, sandbox, { timeout: 100 });
        } catch (error) {
                logDebug("Failed to evaluate Nuxt state script directly:", error.message);
                const literal = extractObjectLiteralAfterAssignment(scriptContent, /window\.__NUXT__\s*=\s*/);

                if (!literal) {
                        return null;
                }

                try {
                        return vm.runInNewContext(`(${literal})`, {});
                } catch (innerError) {
                        logDebug("Failed to evaluate extracted Nuxt literal:", innerError.message);
                        return null;
                }
        }

        return sandboxWindow.__NUXT__ ?? sandbox.__NUXT__ ?? null;
}

function parseNuxtPayloadScript(scriptContent) {
        if (typeof scriptContent !== "string") {
                return null;
        }

        const trimmed = scriptContent.trim();

        if (trimmed.length === 0) {
                return null;
        }

        const startsWithJsonToken = trimmed.startsWith("{") || trimmed.startsWith("[");

        if (!startsWithJsonToken) {
                return null;
        }

        try {
                const parsed = JSON.parse(trimmed);

                if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
                        return null;
                }

                return parsed;
        } catch (error) {
                logDebug("Failed to parse potential Nuxt payload script:", error.message);
                return null;
        }
}

function extractObjectLiteralAfterAssignment(scriptContent, assignmentRegex) {
        const match = assignmentRegex.exec(scriptContent);

        if (!match) {
                return null;
        }

        let startIndex = match.index + match[0].length;

        while (startIndex < scriptContent.length && /[\s;]/.test(scriptContent[startIndex])) {
                startIndex += 1;
        }

        if (scriptContent[startIndex] !== "{") {
                return null;
        }

        let depth = 0;
        let inString = false;
        let stringDelimiter = "";
        let escaped = false;

        for (let position = startIndex; position < scriptContent.length; position += 1) {
                const char = scriptContent[position];

                if (escaped) {
                        escaped = false;
                        continue;
                }

                if (char === "\\") {
                        escaped = true;
                        continue;
                }

                if (inString) {
                        if (char === stringDelimiter) {
                                inString = false;
                        }
                        continue;
                }

                if (char === '"' || char === "'" || char === "`") {
                        inString = true;
                        stringDelimiter = char;
                        continue;
                }

                if (char === "{") {
                        depth += 1;
                        continue;
                }

                if (char === "}") {
                        depth -= 1;
                        if (depth === 0) {
                                return scriptContent.slice(startIndex, position + 1);
                        }
                        continue;
                }
        }

        return null;
}

function extractLinksFromNuxtState(nuxtState) {
        const results = [];
        const seenUrls = new Set();
        const visited = new WeakSet();

        function findNameInObject(object) {
                if (!object || typeof object !== "object") {
                        return null;
                }

                const preferredKeys = [
                        "title",
                        "name",
                        "channelName",
                        "channel",
                        "label",
                        "displayName",
                        "heading",
                ];

                for (const key of preferredKeys) {
                        const value = object[key];
                        if (typeof value === "string" && value.trim().length > 0) {
                                return value.trim();
                        }
                }

                const nestedKeys = ["attributes", "content", "details", "fields", "meta", "data"];

                for (const key of nestedKeys) {
                        const nestedValue = object[key];
                        if (nestedValue && typeof nestedValue === "object") {
                                const nestedName = findNameInObject(nestedValue);
                                if (nestedName) {
                                        return nestedName;
                                }
                        }
                }

                return null;
        }

        function findNameInParents(parents) {
                for (let idx = parents.length - 1; idx >= 0; idx -= 1) {
                        const candidate = findNameInObject(parents[idx]);
                        if (candidate) {
                                return candidate;
                        }
                }
                return null;
        }

        function recordLink(url, parents, sourceObject) {
                if (!url || seenUrls.has(url)) {
                        return;
                }

                const nameFromSource = findNameInObject(sourceObject);
                const name = nameFromSource || findNameInParents(parents) || "Channel";

                results.push({ name, url });
                seenUrls.add(url);
        }

        function traverse(value, parents) {
                if (value && typeof value === "object") {
                        if (visited.has(value)) {
                                return;
                        }
                        visited.add(value);
                }

                if (Array.isArray(value)) {
                        for (const item of value) {
                                if (typeof item === "string") {
                                        const urls = collectStreamUrlsFromString(item);
                                        if (urls.length > 0) {
                                                for (const url of urls) {
                                                        recordLink(url, parents, {});
                                                }
                                        }
                                } else {
                                        traverse(item, parents);
                                }
                        }
                        return;
                }

                if (!value || typeof value !== "object") {
                        if (typeof value === "string") {
                                const urls = collectStreamUrlsFromString(value);
                                if (urls.length > 0) {
                                        const source = parents.length > 0 ? parents[parents.length - 1] : {};
                                        for (const url of urls) {
                                                recordLink(url, parents, source);
                                        }
                                }
                        }
                        return;
                }

                const nextParents = parents.concat(value);

                for (const child of Object.values(value)) {
                        if (typeof child === "string") {
                                const urls = collectStreamUrlsFromString(child);
                                if (urls.length > 0) {
                                        for (const url of urls) {
                                                recordLink(url, nextParents, value);
                                        }
                                        continue;
                                }
                        }
                        traverse(child, nextParents);
                }
        }

        traverse(nuxtState, []);

        return results;
}

function extractStreamUrlsFromHtml(html) {
        if (typeof html !== "string" || html.length === 0) {
                return [];
        }

        const discovered = new Set();
        const attributeRegex =
                /\b(?:src|data-src|data-hls|data-stream-url|data-url|data-href|data-path|data-link)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'\s>]+))/gi;
        let match;

        while ((match = attributeRegex.exec(html)) !== null) {
                const candidate = match[1] || match[2] || match[3] || "";

                if (!candidate) {
                        continue;
                }

                for (const url of collectStreamUrlsFromString(candidate)) {
                        discovered.add(url);
                }
        }

        for (const url of collectStreamUrlsFromString(html)) {
                discovered.add(url);
        }

        return Array.from(discovered);
}

function deriveNameFromStreamUrl(url) {
        try {
                const parsed = new URL(url);
                const segments = parsed.pathname.split("/").filter(Boolean);
                const lastSegment = segments[segments.length - 1] || parsed.hostname || "";
                const withoutExtension = lastSegment.replace(/\.(?:m3u8|mpd|ism)/i, "");
                const decoded = decodeURIComponent(withoutExtension).replace(/[-_]+/g, " ").trim();

                if (decoded.length === 0) {
                        return parsed.hostname || "Discovered Stream";
                }

                return decoded
                        .split(" ")
                        .filter(Boolean)
                        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                        .join(" ");
        } catch (error) {
                return "Discovered Stream";
        }
}

function discoverAdditionalUrls(html, { baseUrl, maxUrls = 10, existingUrls } = {}) {
        if (typeof html !== "string" || html.length === 0) {
                return [];
        }

        let base;

        try {
                base = new URL(baseUrl);
        } catch (error) {
                return [];
        }

        const results = [];
        const seen = new Set();
        const attributeRegex =
                /\b(?:href|data-url|data-href|data-link|data-path|data-target-url|data-permalink)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'\s>]+))/gi;
        let match;

        while ((match = attributeRegex.exec(html)) !== null) {
                if (results.length >= maxUrls) {
                        break;
                }

                const rawCandidate = match[1] || match[2] || match[3] || "";

                if (!rawCandidate) {
                        continue;
                }

                const decodedCandidate = decodeEscapedLinkValue(rawCandidate);

                if (!decodedCandidate) {
                        continue;
                }

                const trimmed = decodedCandidate.trim();

                if (!trimmed || trimmed.startsWith("#") || /^javascript:/i.test(trimmed)) {
                        continue;
                }

                let resolved;

                try {
                        resolved = new URL(trimmed, base).href;
                } catch (error) {
                        continue;
                }

                if (!/^https?:\/\//i.test(resolved)) {
                        continue;
                }

                if (new URL(resolved).hostname !== base.hostname) {
                        continue;
                }

                if (existingUrls && existingUrls.has(resolved)) {
                        continue;
                }

                if (isLikelyStaticAssetUrl(resolved)) {
                        continue;
                }

                if (seen.has(resolved)) {
                        continue;
                }

                seen.add(resolved);
                results.push(resolved);
        }

        if (results.length >= maxUrls) {
                return results;
        }

        const jsonRegex = /"(?:url|href|permalink|path)"\s*:\s*"([^"]+)"/gi;

        while ((match = jsonRegex.exec(html)) !== null) {
                if (results.length >= maxUrls) {
                        break;
                }

                const rawCandidate = match[1] || "";

                if (!rawCandidate) {
                        continue;
                }

                const decodedCandidate = decodeEscapedLinkValue(rawCandidate);

                if (!decodedCandidate) {
                        continue;
                }

                let resolved;

                try {
                        resolved = new URL(decodedCandidate, base).href;
                } catch (error) {
                        continue;
                }

                if (!/^https?:\/\//i.test(resolved)) {
                        continue;
                }

                if (new URL(resolved).hostname !== base.hostname) {
                        continue;
                }

                if (existingUrls && existingUrls.has(resolved)) {
                        continue;
                }

                if (isLikelyStaticAssetUrl(resolved)) {
                        continue;
                }

                if (seen.has(resolved)) {
                        continue;
                }

                seen.add(resolved);
                results.push(resolved);
        }

        return results;
}

async function extractAndExport(options) {
        if (options.help) {
                logHelp();
                return;
        }

        const {
                url,
                urls = [],
                useNordVPN,
                useNordVpnCli,
                nordVpnProxyUrl,
                nordVpnCliServer,
                nordVpnCliTimeoutMs,
                loadedConfigPath,
                proxyValidationError,
                outputFormat,
                outputFile,
        } = options;

        if (loadedConfigPath) {
                console.log(`Configuration loaded from: ${loadedConfigPath}`);
        }

        const normalizedOutputFormat = (outputFormat || "m3u").toLowerCase();
        const normalizedOutputFile = outputFile ||
                (normalizedOutputFormat === "json" ? "playlist.json" : "playlist.m3u");
        console.log(
                `Selected output format: ${normalizedOutputFormat.toUpperCase()} (${normalizedOutputFile})`
        );

        logDebug(
                "Extractor configuration:",
                JSON.stringify(
                        {
                                normalizedOutputFormat,
                                normalizedOutputFile,
                                useNordVPN: Boolean(useNordVPN),
                                useNordVpnCli: Boolean(useNordVpnCli),
                                nordVpnCliServer: nordVpnCliServer || null,
                                nordVpnCliTimeoutMs: nordVpnCliTimeoutMs || null,
                        },
                        null,
                        2
                )
        );

        const urlSet = new Set();
        const urlsToProcess = [];
        const discoveredSubUrlMap = new Map();
        const discoveredSubUrlOrder = [];

        const recordDiscoveredSubUrl = (candidateUrl, sourceUrl) => {
                if (typeof candidateUrl !== "string" || candidateUrl.trim().length === 0) {
                        return;
                }

                let entry = discoveredSubUrlMap.get(candidateUrl);

                if (!entry) {
                        entry = {
                                url: candidateUrl,
                                sources: new Set(),
                        };
                        discoveredSubUrlMap.set(candidateUrl, entry);
                        discoveredSubUrlOrder.push(entry);
                }

                if (typeof sourceUrl === "string" && sourceUrl.trim().length > 0) {
                        entry.sources.add(sourceUrl);
                }
        };

        const emitDiscoveryReport = () => {
                if (discoveredSubUrlOrder.length === 0) {
                        return null;
                }

                console.log("\nDiscovered sub-URLs:");

                const printableEntries = discoveredSubUrlOrder.map((entry, index) => {
                        const sources = Array.from(entry.sources);
                        const displayIndex = index + 1;

                        console.log(`- [${displayIndex}] ${entry.url}`);

                        if (sources.length > 0) {
                                console.log(`    Found on: ${sources.join(", ")}`);
                        }

                        return {
                                url: entry.url,
                                sources,
                        };
                });

                const discoveryOutputFile = buildDiscoveryOutputPath(normalizedOutputFile);
                const discoveryOutputPath = path.resolve(discoveryOutputFile);
                ensureDirectoryExists(discoveryOutputPath);

                const reportPayload = {
                        generatedAt: new Date().toISOString(),
                        total: printableEntries.length,
                        entries: printableEntries,
                };

                fs.writeFileSync(
                        discoveryOutputPath,
                        `${JSON.stringify(reportPayload, null, 2)}\n`,
                        "utf8"
                );

                console.log(`\nDiscovery report saved to '${discoveryOutputFile}'.`);

                return discoveryOutputFile;
        };

        const pushUrl = (candidate) => {
                if (typeof candidate !== "string") {
                        logDebug("Ignoring non-string URL candidate from configuration or CLI input.");
                        return;
                }
                const trimmed = candidate.trim();
                if (!trimmed) {
                        logDebug("Skipping empty URL entry from configuration file or CLI.");
                        return;
                }
                if (urlSet.has(trimmed)) {
                        logVerbose(`Skipping duplicate URL: ${trimmed}`);
                        return;
                }
                urlSet.add(trimmed);
                logDebug(`Queued URL for processing: ${trimmed}`);
                urlsToProcess.push(trimmed);
        };

        pushUrl(url);

        if (Array.isArray(urls)) {
                for (const item of urls) {
                        pushUrl(item);
                }
        }

        logVerbose(
                `Total URLs queued for scraping: ${urlsToProcess.length}`
        );

        if (urlsToProcess.length === 0) {
                console.error(
                        "You must provide at least one URL via --url, SCRAPER_URL, or the configuration file."
                );
                process.exitCode = 1;
                return;
        }

        if (useNordVpnCli) {
                try {
                        logVerbose(
                                "NordVPN CLI workflow enabled. Attempting to establish VPN session before scraping."
                        );
                        await ensureNordVpnCliConnection({
                                server: nordVpnCliServer,
                                timeoutMs: nordVpnCliTimeoutMs || 60000,
                        });
                } catch (error) {
                        console.error(error.message);
                        process.exitCode = 1;
                        return;
                }
        }

        if (options.loginPayloadError) {
                console.error(`Invalid login payload JSON: ${options.loginPayloadError}`);
                process.exitCode = 1;
                return;
        }

        const headerWarnings = Array.isArray(options.headersParseErrors)
                ? options.headersParseErrors
                : [];

        for (const warning of headerWarnings) {
                if (warning) {
                        console.warn(`[Headers] ${warning}`);
                }
        }

        const cookieWarnings = Array.isArray(options.cookieParseErrors)
                ? options.cookieParseErrors
                : [];

        for (const warning of cookieWarnings) {
                if (warning) {
                        console.warn(`[Cookies] ${warning}`);
                }
        }

        const credentialWarnings = Array.isArray(options.credentialParseErrors)
                ? options.credentialParseErrors
                : [];

        for (const warning of credentialWarnings) {
                if (warning) {
                        console.warn(`[Credentials] ${warning}`);
                }
        }

        const defaultRequestHeaders = {
                "User-Agent": DEFAULT_USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        };

        const baseRequestHeaders = mergeHeaders(defaultRequestHeaders, options.additionalHeaders || {});
        const initialCookies = Array.isArray(options.initialCookies) ? options.initialCookies : [];
        const sessionCache = new Map();

        const getSessionForUrl = (urlObject) => {
                const hostKey = (urlObject.hostname || urlObject.host || urlObject.href || "").toLowerCase();

                if (sessionCache.has(hostKey)) {
                        return sessionCache.get(hostKey);
                }

                const credential = findCredentialForHost(
                        options.savedCredentials,
                        urlObject.hostname || urlObject.host || ''
                );
                const cookieJar = createCookieJar(initialCookies);

                if (credential && typeof credential.cookies === "string") {
                        cookieJar.loadFromCookieHeader(credential.cookies);
                }

                const loginInfo = buildLoginInfo({ urlObject, options, credential });
                const session = {
                        hostKey,
                        credential,
                        loginInfo,
                        cookieJar,
                        loginAttempted: false,
                        loginSuccessful: false,
                };

                sessionCache.set(hostKey, session);
                return session;
        };

        let proxyUrlToUse = "";

        if (useNordVPN) {
                if (proxyValidationError) {
                        logDebug("Proxy validation error detail:", proxyValidationError);
                        console.error(proxyValidationError);
                        process.exitCode = 1;
                        return;
                }

                if (!nordVpnProxyUrl) {
                        console.error(
                                "NordVPN usage is enabled, but no valid proxy was provided."
                        );
                        console.error(
                                "Set NORDVPN_PROXY_URL, update the configuration file, or use --nordvpn-proxy=http://user:pass@host:port"
                        );
                        process.exitCode = 1;
                        return;
                }

                proxyUrlToUse = nordVpnProxyUrl;
                console.log("Using NordVPN via proxy:", maskProxyUrl(nordVpnProxyUrl));
                logDebug("Effective NordVPN proxy URL:", maskProxyUrl(nordVpnProxyUrl));
        }

        const aggregatedLinks = [];
        const perUrlStats = [];
        let proxyDisabledForSession = false;
        let totalDiscoveredUrls = 0;

        for (let urlIndex = 0; urlIndex < urlsToProcess.length; urlIndex += 1) {
                const targetUrl = urlsToProcess[urlIndex];
                console.log(`\nProcessing: ${targetUrl}`);

                try {
                        let urlObject;
                        try {
                                urlObject = new URL(targetUrl);
                        } catch (error) {
                                console.error(`Invalid URL provided: ${targetUrl}. ${error.message}`);
                                continue;
                        }

                        const session = getSessionForUrl(urlObject);

                        if (session.credential && session.credential.site) {
                                logDebug(
                                        `[Login] Using credential entry '${session.credential.site}' for host ${urlObject.hostname}.`
                                );
                        }

                        if (session.loginInfo && !session.loginAttempted) {
                                session.loginAttempted = true;
                                const loginInfo = session.loginInfo;

                                if (loginInfo.payloadSource) {
                                        logDebug(
                                                `[Login] Using ${loginInfo.payloadSource} payload for ${loginInfo.url}.`
                                        );
                                }

                                if (!loginInfo.payload || typeof loginInfo.payload !== "object") {
                                        console.warn(
                                                `[Login] Skipping authentication for ${loginInfo.url} because no login payload was provided.`
                                        );
                                } else {
                                        console.log(`[Login] Authenticating via ${loginInfo.url}`);
                                        const payloadKeys = Object.keys(loginInfo.payload || {});
                                        if (payloadKeys.length > 0) {
                                                logDebug(
                                                        `[Login] Payload keys for ${loginInfo.url}: ${payloadKeys.join(", ")}`
                                                );
                                        } else {
                                                logDebug(`[Login] Payload for ${loginInfo.url} is empty JSON.`);
                                        }
                                        const loginBody = JSON.stringify(loginInfo.payload);

                                        const performLoginRequest = async (proxyUrlValue) => {
                                                const loginHeaders = buildHeadersForRequest(
                                                        baseRequestHeaders,
                                                        session.cookieJar,
                                                        {
                                                                Accept: "application/json,text/plain,*/*;q=0.8",
                                                        }
                                                );

                                                if (!hasHeader(loginHeaders, "Content-Type")) {
                                                        setOrReplaceHeader(loginHeaders, "Content-Type", "application/json");
                                                }

                                                return fetchWithOptionalProxy(loginInfo.url, {
                                                        method: loginInfo.method || "POST",
                                                        headers: loginHeaders,
                                                        body: loginBody,
                                                        proxyUrl: proxyUrlValue,
                                                });
                                        };

                                        try {
                                                const loginResponse = await performLoginRequest(proxyUrlToUse || undefined);
                                                logDebug(
                                                        `Login response status for ${loginInfo.url}: ${loginResponse.statusCode}`
                                                );
                                                updateCookieJarFromResponse(session.cookieJar, loginResponse.headers);

                                                if (loginResponse.statusCode >= 200 && loginResponse.statusCode < 400) {
                                                        console.log(
                                                                `[Login] Authentication successful (status ${loginResponse.statusCode}).`
                                                        );
                                                        session.loginSuccessful = true;
                                                        const cookieHeader = session.cookieJar.getCookieHeader();
                                                        if (cookieHeader) {
                                                                logDebug(
                                                                        `[Login] Stored cookies for ${urlObject.hostname}: ${cookieHeader}`
                                                                );
                                                        }
                                                } else {
                                                        console.warn(
                                                                `[Login] Authentication endpoint returned status ${loginResponse.statusCode}.`
                                                        );
                                                }
                                        } catch (error) {
                                                const friendlyProxyError = proxyUrlToUse
                                                        ? explainNordVpnProxyFailure(error, proxyUrlToUse)
                                                        : null;

                                                if (friendlyProxyError && useNordVpnCli) {
                                                        console.error(
                                                                `[Login] ${friendlyProxyError} (while requesting ${loginInfo.url})`
                                                        );
                                                        logDebug(
                                                                `[Login] Detailed proxy error: ${error.stack || error.message}`
                                                        );
                                                        console.log(
                                                                "[Login] Retrying authentication without the proxy because the NordVPN CLI tunnel is active."
                                                        );

                                                        try {
                                                                const fallbackResponse = await performLoginRequest(undefined);
                                                                updateCookieJarFromResponse(
                                                                        session.cookieJar,
                                                                        fallbackResponse.headers
                                                                );

                                                                if (!proxyDisabledForSession) {
                                                                        proxyDisabledForSession = true;
                                                                        proxyUrlToUse = "";
                                                                        console.log(
                                                                                "[NordVPN Proxy] Proxy usage has been disabled for the remaining URLs in this session."
                                                                        );
                                                                }

                                                                if (
                                                                        fallbackResponse.statusCode >= 200 &&
                                                                        fallbackResponse.statusCode < 400
                                                                ) {
                                                                        console.log(
                                                                                `[Login] Authentication successful after retry (status ${fallbackResponse.statusCode}).`
                                                                        );
                                                                        session.loginSuccessful = true;
                                                                        const cookieHeader = session.cookieJar.getCookieHeader();
                                                                        if (cookieHeader) {
                                                                                logDebug(
                                                                                        `[Login] Stored cookies for ${urlObject.hostname}: ${cookieHeader}`
                                                                                );
                                                                        }
                                                                } else {
                                                                        console.warn(
                                                                                `[Login] Authentication endpoint returned status ${fallbackResponse.statusCode} after retry.`
                                                                        );
                                                                }
                                                        } catch (fallbackError) {
                                                                console.error(
                                                                        `[Login] Authentication failed after fallback: ${fallbackError.message}`
                                                                );
                                                                logDebug(
                                                                        `[Login] Detailed fallback authentication error: ${
                                                                                fallbackError.stack || fallbackError.message
                                                                        }`
                                                                );
                                                        }
                                                } else {
                                                        console.error(`[Login] Authentication failed: ${error.message}`);
                                                        logDebug(
                                                                `[Login] Detailed authentication error: ${
                                                                        error.stack || error.message
                                                                }`
                                                        );
                                                }
                                        }
                                }
                        }

                        logVerbose(`Fetching content from ${targetUrl}`);

                        const usingProxyForThisRequest = Boolean(proxyUrlToUse);
                        let response;

                        const pageHeaders = buildHeadersForRequest(baseRequestHeaders, session.cookieJar);

                        try {
                                response = await fetchWithOptionalProxy(targetUrl, {
                                        headers: pageHeaders,
                                        proxyUrl: proxyUrlToUse || undefined,
                                });
                        } catch (error) {
                                const friendlyProxyError = usingProxyForThisRequest
                                        ? explainNordVpnProxyFailure(error, proxyUrlToUse)
                                        : null;

                                if (friendlyProxyError && useNordVpnCli) {
                                        console.error(`${friendlyProxyError} (while requesting ${targetUrl})`);
                                        logDebug(
                                                `Detailed proxy error for ${targetUrl}: ${
                                                        error.stack || error.message
                                                }`
                                        );
                                        console.log(
                                                "[NordVPN Proxy] Attempting the request again without the proxy because the NordVPN CLI tunnel is active."
                                        );

                                        try {
                                                const fallbackHeaders = buildHeadersForRequest(
                                                        baseRequestHeaders,
                                                        session.cookieJar
                                                );
                                                response = await fetchWithOptionalProxy(targetUrl, {
                                                        headers: fallbackHeaders,
                                                });

                                                if (!proxyDisabledForSession) {
                                                        proxyDisabledForSession = true;
                                                        proxyUrlToUse = "";
                                                        console.log(
                                                                "[NordVPN Proxy] Proxy usage has been disabled for the remaining URLs in this session."
                                                        );
                                                }
                                        } catch (fallbackError) {
                                                console.error(`Error fetching page (${targetUrl}):`, fallbackError.message);
                                                logDebug(
                                                        `Detailed error for ${targetUrl} after proxy fallback: ${
                                                                fallbackError.stack || fallbackError.message
                                                        }`
                                                );
                                                continue;
                                        }
                                } else {
                                        if (friendlyProxyError) {
                                                console.error(`${friendlyProxyError} (while requesting ${targetUrl})`);
                                        } else {
                                                console.error(`Error fetching page (${targetUrl}):`, error.message);
                                        }

                                        logDebug(
                                                `Detailed error for ${targetUrl}: ${
                                                        error.stack || error.message
                                                }`
                                        );
                                        continue;
                                }
                        }

                        logDebug(
                                `Response metadata for ${targetUrl}: ${JSON.stringify(
                                        { statusCode: response.statusCode, headers: response.headers },
                                        null,
                                        2
                                )}`
                        );

                        if (response && response.headers) {
                                updateCookieJarFromResponse(session.cookieJar, response.headers);
                        }

                        if (response.statusCode === 200) {
                                console.log("Page loaded successfully.");
                        } else {
                                console.log(
                                        `Error loading page (${targetUrl}). Status: ${response.statusCode}`
                                );
                                continue;
                        }

                        const contentTypeHeader = getHeaderValue(response.headers, "Content-Type");
                        const normalizedContentType = normalizeContentType(contentTypeHeader);
                        const isHtmlResponse = isHtmlContentType(normalizedContentType);
                        const isJsonResponse = isJsonContentType(normalizedContentType);
                        let exportedForUrl = 0;

                        if (isHtmlResponse) {
                                const scripts = await extractLinksDataScripts(response.body, {
                                        baseUrl: targetUrl,
                                        fetchExternalScript: async (scriptUrl) => {
                                                const scriptHeaders = buildHeadersForRequest(
                                                        baseRequestHeaders,
                                                        session.cookieJar,
                                                        {
                                                                Accept: "application/javascript,text/javascript,*/*;q=0.8",
                                                                Referer: targetUrl,
                                                        }
                                                );

                                                const proxyUrlForScripts = proxyUrlToUse ? proxyUrlToUse : undefined;

                                                const scriptResponse = await fetchWithOptionalProxy(scriptUrl, {
                                                        headers: scriptHeaders,
                                                        proxyUrl: proxyUrlForScripts,
                                                });

                                                if (scriptResponse && scriptResponse.headers) {
                                                        updateCookieJarFromResponse(
                                                                session.cookieJar,
                                                                scriptResponse.headers
                                                        );
                                                }

                                                return scriptResponse;
                                        },
                                });
                                logDebug(
                                        `Found ${scripts.length} scripts containing potential channel data markers.`
                                );

                                if (scripts.length === 0) {
                                        console.log(
                                                "Could not find any scripts containing recognizable channel data markers for this URL. Running fallback discovery strategies."
                                        );
                                } else {
                                        for (const script of scripts) {
                                                console.log(`Script found at index ${script.index}.`);
                                                logDebug(
                                                        `Analyzing script index ${script.index} (length: ${
                                                                script.content.length
                                                        } characters).`
                                                );
                                                try {
                                                        const linksData = extractLinksDataFromScript(script.content);

                                                        if (!linksData || !Array.isArray(linksData.links)) {
                                                                logDebug(
                                                                        `Script index ${script.index} did not return valid channel data.`
                                                                );
                                                                continue;
                                                        }

                                                        console.log(
                                                                "Original data contains:",
                                                                linksData.links.length,
                                                                "links"
                                                        );
                                                        logDebug(
                                                                `Sample of parsed channel data keys: ${Object.keys(linksData).join(', ')}`
                                                        );

                                                        const cleanedLinks = linksData.links
                                                                .filter((link) => {
                                                                        if (!link || typeof link.url !== "string") {
                                                                                logDebug(
                                                                                        `Discarding invalid link entry from script index ${script.index}.`
                                                                                );
                                                                                return false;
                                                                        }

                                                                        const trimmedUrl = link.url.trim();

                                                                        if (!/^https?:\/\//i.test(trimmedUrl)) {
                                                                                logDebug(
                                                                                        `Discarding non-HTTP stream URL from script index ${script.index}.`
                                                                                );
                                                                                return false;
                                                                        }

                                                                        if (!isSupportedStreamUrl(trimmedUrl)) {
                                                                                logDebug(
                                                                                        `Discarding unsupported stream URL from script index ${script.index}: ${trimmedUrl}`
                                                                                );
                                                                                return false;
                                                                        }

                                                                        return true;
                                                                })
                                                                .map((link) => ({
                                                                        name: link.name || "Channel",
                                                                        url: link.url
                                                                                .trim()
                                                                                .replace(/\\u0026/gi, "&")
                                                                                .replace(/&amp;/gi, "&"),
                                                                }));

                                                        if (cleanedLinks.length === 0) {
                                                                logDebug(
                                                                        `All links discarded after cleanup for script index ${script.index}.`
                                                                );
                                                                continue;
                                                        }

                                                        aggregatedLinks.push(...cleanedLinks);
                                                        exportedForUrl += cleanedLinks.length;
                                                        logDebug(
                                                                `Exported ${cleanedLinks.length} links from script index ${script.index}.`
                                                        );
                                                } catch (parseError) {
                                                        console.error(
                                                                "Error parsing the channel data structure:",
                                                                parseError
                                                        );
                                                        logDebug(
                                                                `Problematic script content: ${script.content.slice(0, 500)}...`
                                                        );
                                                }
                                        }
                                }

                                const directStreamUrls = extractStreamUrlsFromHtml(response.body);

                                if (directStreamUrls.length > 0) {
                                        console.log(
                                                `Discovered ${directStreamUrls.length} direct stream URL(s) within page markup.`
                                        );
                                        logDebug(
                                                `Direct stream URLs discovered: ${directStreamUrls.join(', ')}`
                                        );
                                        const directLinks = directStreamUrls.map((streamUrl) => ({
                                                name: deriveNameFromStreamUrl(streamUrl),
                                                url: streamUrl,
                                        }));
                                        aggregatedLinks.push(...directLinks);
                                        exportedForUrl += directLinks.length;
                                }

                                if (totalDiscoveredUrls < MAX_TOTAL_DISCOVERED_URLS) {
                                        const remainingCapacity = Math.max(
                                                0,
                                                MAX_TOTAL_DISCOVERED_URLS - totalDiscoveredUrls
                                        );

                                        if (remainingCapacity > 0) {
                                                const additionalUrls = discoverAdditionalUrls(response.body, {
                                                        baseUrl: targetUrl,
                                                        maxUrls: Math.min(
                                                                MAX_DISCOVERED_PER_PAGE,
                                                                remainingCapacity
                                                        ),
                                                        existingUrls: urlSet,
                                                });

                                                if (additionalUrls.length > 0) {
                                                        console.log(
                                                                `[Discovery] Queued ${additionalUrls.length} additional URL(s) found on the page.`
                                                        );

                                                        for (const discoveredUrl of additionalUrls) {
                                                                recordDiscoveredSubUrl(discoveredUrl, targetUrl);

                                                                if (urlSet.has(discoveredUrl)) {
                                                                        continue;
                                                                }

                                                                urlSet.add(discoveredUrl);
                                                                urlsToProcess.push(discoveredUrl);
                                                                totalDiscoveredUrls += 1;
                                                                logDebug(
                                                                        `[Discovery] Added ${discoveredUrl} to the processing queue.`
                                                                );

                                                                if (
                                                                        totalDiscoveredUrls >=
                                                                        MAX_TOTAL_DISCOVERED_URLS
                                                                ) {
                                                                        logWarn(
                                                                                `[Discovery] Maximum total discovered URL limit (${MAX_TOTAL_DISCOVERED_URLS}) reached.`
                                                                        );
                                                                        break;
                                                                }
                                                        }
                                                }
                                        }
                                } else {
                                        logVerbose(
                                                `[Discovery] Maximum total discovered URL limit (${MAX_TOTAL_DISCOVERED_URLS}) already reached.`
                                        );
                                }
                        } else {
                                logVerbose(
                                        `Skipping HTML-specific parsing for ${targetUrl} due to content type: ${
                                                normalizedContentType || "<unknown>"
                                        }.`
                                );

                                let fallbackBody = "";

                                if (typeof response.body === "string") {
                                        fallbackBody = response.body;
                                }

                                if (isJsonResponse && typeof response.body === "string") {
                                        try {
                                                const parsedJson = JSON.parse(response.body);
                                                fallbackBody = JSON.stringify(parsedJson);
                                        } catch (jsonError) {
                                                logDebug(
                                                        `Failed to parse JSON response from ${targetUrl}: ${jsonError.message}`
                                                );
                                        }
                                }

                                const fallbackUrls = collectStreamUrlsFromString(fallbackBody);

                                if (fallbackUrls.length > 0) {
                                        const fallbackLinks = fallbackUrls.map((streamUrl) => ({
                                                name: deriveNameFromStreamUrl(streamUrl),
                                                url: streamUrl,
                                        }));
                                        aggregatedLinks.push(...fallbackLinks);
                                        exportedForUrl += fallbackLinks.length;
                                        console.log(
                                                `Extracted ${fallbackLinks.length} stream URL(s) from non-HTML response body.`
                                        );
                                }
                        }

                        if (exportedForUrl > 0) {
                                perUrlStats.push({ url: targetUrl, count: exportedForUrl });
                                console.log(
                                        `Total links exported for this URL: ${exportedForUrl}`
                                );
                                logVerbose(
                                        `Accumulated exported links count is now ${aggregatedLinks.length}.`
                                );
                        } else {
                                console.log("No stream links could be exported for this URL.");
                                logVerbose(
                                        `No exportable data found for ${targetUrl}; continuing with next target if available.`
                                );
                        }
                } catch (error) {
                        console.error(`Unexpected error while processing ${targetUrl}:`, error.message);
                        logDebug(
                                `Detailed unexpected error for ${targetUrl}: ${error.stack || error.message}`
                        );
                }
        }

        if (aggregatedLinks.length === 0) {
                emitDiscoveryReport();
                console.log(
                        "Could not generate the output file because no valid links were found."
                );
                return;
        }

        const uniqueLinks = [];
        const seenUrls = new Set();

        for (const link of aggregatedLinks) {
                if (!link.url || seenUrls.has(link.url)) {
                        if (link && link.url) {
                                logVerbose(`Skipping duplicated link URL: ${link.url}`);
                        }
                        continue;
                }
                seenUrls.add(link.url);
                uniqueLinks.push(link);
        }

        logDebug(`Unique links total after deduplication: ${uniqueLinks.length}`);

        const outputPath = path.resolve(normalizedOutputFile);
        ensureDirectoryExists(outputPath);

        if (normalizedOutputFormat === "json") {
                const payload = { channels: uniqueLinks };
                const jsonContent = JSON.stringify(payload, null, 2);
                fs.writeFileSync(outputPath, `${jsonContent}\n`, "utf8");
                console.log(`\nJSON file generated successfully as '${normalizedOutputFile}'`);
        } else {
                let m3uContent = "#EXTM3U\n";

                uniqueLinks.forEach((link) => {
                        const name = link.name || "Channel";
                        m3uContent += `#EXTINF:-1 group-title="${name}" tvg-id="${name}",${name}\n`;
                        m3uContent += `${link.url}\n`;
                });

                if (!m3uContent.endsWith("\n")) {
                        m3uContent += "\n";
                }

                fs.writeFileSync(outputPath, m3uContent, "utf8");
                console.log(`\nM3U file generated successfully as '${normalizedOutputFile}'`);
        }

        console.log("\nExport statistics:");
        console.log(`- Total links exported: ${uniqueLinks.length}`);

        for (const stat of perUrlStats) {
                console.log(`- ${stat.url}: ${stat.count} links found`);
        }

        if (normalizedOutputFormat === "json") {
                console.log("- Structure of the generated JSON file:");
                console.log("  {");
                console.log("    \"channels\": [");
                console.log("      { \"name\": \"Channel\", \"url\": \"acestream://...\" }");
                console.log("    ]");
                console.log("  }");
        } else {
                console.log("- Structure of the generated M3U file:");
                console.log("  - Header: #EXTM3U");
                console.log("  - For each channel:");
                console.log("    - Info line with group-title, tvg-id, and name");
                console.log("    - Stream URL");
        }

        emitDiscoveryReport();
}
