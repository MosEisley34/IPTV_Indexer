const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { execFile } = require("child_process");

const DEFAULT_USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

const DEFAULT_CONFIG_FILENAME = "config.yaml";

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
                                        `Se encontró un elemento de lista inesperado en la línea ${i + 1}`
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

                        if (!valuePart.includes(":") || valuePart.startsWith('"') || valuePart.startsWith("'")) {
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

                if (colonIndex === -1) {
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
                if (!fs.existsSync(resolvedPath)) {
                        return { data: {}, path: resolvedPath, exists: false };
                }

                const raw = fs.readFileSync(resolvedPath, "utf8");

                if (!raw.trim()) {
                        return { data: {}, path: resolvedPath, exists: true };
                }

                const parsed = parseSimpleYaml(raw);

                if (typeof parsed !== "object" || parsed === null) {
                        return { data: {}, path: resolvedPath, exists: true };
                }

                return { data: parsed, path: resolvedPath, exists: true };
        } catch (error) {
                console.warn(
                        `No se pudo cargar el archivo de configuración (${resolvedPath}): ${error.message}`
                );
                return { data: {}, path: resolvedPath, exists: false };
        }
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
                        return { error: `Proxy URL inválida: ${error.message}` };
                }
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                return { error: "Solo se admiten proxies HTTP o HTTPS." };
        }

        return { url: buildProxyUrlFromParsed(parsed) };
}

function parseCliArgs() {
        const args = process.argv.slice(2);
        let configPathArg;

        for (const arg of args) {
                if (arg.startsWith("--config=")) {
                        configPathArg = arg.slice("--config=".length);
                }
        }

        const envConfigPath = process.env.CONFIG_FILE || process.env.SCRAPER_CONFIG;
        const loadedConfig = loadConfigFile(configPathArg || envConfigPath);
        const fileConfig = loadedConfig.data || {};
        const config = {
                url: process.env.SCRAPER_URL || "",
                urls: [],
                useNordVPN:
                        process.env.USE_NORDVPN === "true" ||
                        process.env.USE_NORDVPN === "1",
                useNordVpnCli:
                        process.env.USE_NORDVPN_CLI === "true" ||
                        process.env.USE_NORDVPN_CLI === "1",
                nordVpnProxyUrl: process.env.NORDVPN_PROXY_URL || "",
                nordVpnCliServer: process.env.NORDVPN_CLI_SERVER || "",
                nordVpnCliTimeoutMs:
                        process.env.NORDVPN_CLI_TIMEOUT_MS
                                ? Number(process.env.NORDVPN_CLI_TIMEOUT_MS)
                                : undefined,
        };

        if (loadedConfig.exists) {
                config.loadedConfigPath = loadedConfig.path;
        }

        if (Number.isNaN(config.nordVpnCliTimeoutMs)) {
                config.nordVpnCliTimeoutMs = undefined;
        }

        if (fileConfig && typeof fileConfig === "object") {
                const scraperConfig = fileConfig.scraper;

                if (scraperConfig && typeof scraperConfig === "object") {
                        if (!config.url && typeof scraperConfig.url === "string") {
                                config.url = scraperConfig.url;
                        }

                        if (Array.isArray(scraperConfig.urls)) {
                                config.urls = scraperConfig.urls
                                        .map((item) => (typeof item === "string" ? item.trim() : ""))
                                        .filter((item) => item.length > 0);
                        }
                }

                const nordConfig = fileConfig.nordvpn;

                if (nordConfig && typeof nordConfig === "object") {
                        if (typeof nordConfig.useProxy === "boolean") {
                                config.useNordVPN = nordConfig.useProxy;
                        }

                        if (typeof nordConfig.useCli === "boolean") {
                                config.useNordVpnCli = nordConfig.useCli;
                        }

                        if (nordConfig.cliTimeoutMs !== undefined) {
                                const parsedTimeout = Number(nordConfig.cliTimeoutMs);
                                if (!Number.isNaN(parsedTimeout)) {
                                        config.nordVpnCliTimeoutMs = parsedTimeout;
                                }
                        }

                        if (!config.nordVpnCliServer) {
                                if (typeof nordConfig.cliServer === "string" && nordConfig.cliServer.trim()) {
                                        config.nordVpnCliServer = nordConfig.cliServer.trim();
                                } else if (
                                        typeof nordConfig.preferredLocation === "string" &&
                                        nordConfig.preferredLocation.trim()
                                ) {
                                        config.nordVpnCliServer = nordConfig.preferredLocation.trim();
                                }
                        }

                        if (!config.nordVpnProxyUrl) {
                                if (typeof nordConfig.proxyUrl === "string" && nordConfig.proxyUrl.trim()) {
                                        config.nordVpnProxyUrl = nordConfig.proxyUrl.trim();
                                } else if (nordConfig.proxy && typeof nordConfig.proxy === "object") {
                                        const proxy = nordConfig.proxy;
                                        const host = proxy.host || proxy.hostname;
                                        const port = proxy.port;

                                        if (host && port) {
                                                const protocol = proxy.protocol ? String(proxy.protocol) : "http";
                                                let credentials = "";

                                                if (proxy.username) {
                                                        credentials += encodeURIComponent(String(proxy.username));

                                                        if (proxy.password !== undefined) {
                                                                credentials += `:${encodeURIComponent(
                                                                        String(proxy.password)
                                                                )}`;
                                                        }

                                                        credentials += "@";
                                                }

                                                config.nordVpnProxyUrl = `${protocol}://${credentials}${host}:${port}`;
                                        }
                                }

                                if (!config.nordVpnProxyUrl && nordConfig.host && nordConfig.port) {
                                        const host = nordConfig.host;
                                        const port = nordConfig.port;
                                        let credentials = "";

                                        if (nordConfig.username) {
                                                credentials += encodeURIComponent(String(nordConfig.username));

                                                if (nordConfig.password !== undefined) {
                                                        credentials += `:${encodeURIComponent(
                                                                String(nordConfig.password)
                                                        )}`;
                                                }

                                                credentials += "@";
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
                                        : "";
                        config.nordVpnProxyUrl = `http://${credentials}${nordVpnHost}:${nordVpnPort}`;
        }

        for (const arg of args) {
                if (arg === "--help") {
                        return { help: true };
                }

                if (arg.startsWith("--config=")) {
                        continue;
                }

                if (arg.startsWith("--url=")) {
                        config.url = arg.slice("--url=".length);
                        continue;
                }

                if (arg === "--use-nordvpn") {
                        config.useNordVPN = true;
                        continue;
                }

                if (arg.startsWith("--nordvpn-proxy=")) {
                        config.nordVpnProxyUrl = arg.slice("--nordvpn-proxy=".length);
                        continue;
                }

                if (arg === "--use-nordvpn-cli") {
                        config.useNordVpnCli = true;
                        continue;
                }

                if (arg.startsWith("--nordvpn-cli=")) {
                        config.useNordVpnCli = true;
                        config.nordVpnCliServer = arg.slice("--nordvpn-cli=".length);
                        continue;
                }

                if (arg.startsWith("--nordvpn-cli-timeout=")) {
                        const timeoutMs = Number(
                                arg.slice("--nordvpn-cli-timeout=".length)
                        );
                        if (!Number.isNaN(timeoutMs)) {
                                config.nordVpnCliTimeoutMs = timeoutMs;
                        }
                        continue;
                }
        }

        if (typeof config.url === "string") {
                config.url = config.url.trim();
        }

        if (!Array.isArray(config.urls)) {
                config.urls = [];
        } else {
                config.urls = config.urls
                        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
                        .filter((entry) => entry.length > 0);
        }

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
        console.log(`Uso: node main.js --url=<URL> [opciones]\n\n` +
                `Opciones:\n` +
                `  --url=<URL>             URL que se desea analizar (también SCRAPER_URL).\n` +
                `  --config=<ruta>         Ruta al archivo YAML de configuración (por defecto ./config.yaml).\n` +
                `  --use-nordvpn           Fuerza el uso del proxy de NordVPN.\n` +
                `  --nordvpn-proxy=<URL>   URL completa del proxy (p. ej. http://usuario:pass@host:puerto).\n` +
                `  --use-nordvpn-cli       Inicia y verifica la conexión usando el CLI oficial de NordVPN.\n` +
                `  --nordvpn-cli=<server>  Conecta mediante CLI al servidor especificado.\n` +
                `  --nordvpn-cli-timeout=<ms> Tiempo máximo para que el CLI conecte (por defecto 60000 ms).\n` +
                `  --help                  Muestra esta ayuda.\n\n` +
                `Variables de entorno:\n` +
                `  CONFIG_FILE             Ruta al archivo YAML de configuración.\n` +
                `  SCRAPER_CONFIG          Alias de CONFIG_FILE.\n` +
                `  USE_NORDVPN=true        Activa el uso de NordVPN.\n` +
                `  NORDVPN_PROXY_URL       Proxy HTTP(S) proporcionado por NordVPN.\n` +
                `  NORDVPN_PROXY_HOST      Host del proxy de NordVPN.\n` +
                `  NORDVPN_PROXY_PORT      Puerto del proxy de NordVPN.\n` +
                `  NORDVPN_USERNAME        Usuario del proxy (si aplica).\n` +
                `  NORDVPN_PASSWORD        Contraseña del proxy (si aplica).\n` +
                `  USE_NORDVPN_CLI=true    Ejecuta el CLI de NordVPN antes de iniciar el scraping.\n` +
                `  NORDVPN_CLI_SERVER      Servidor al que se conectará el CLI (opcional).\n` +
                `  NORDVPN_CLI_TIMEOUT_MS  Tiempo máximo de espera para la conexión del CLI.\n\n` +
                `El archivo de configuración permite definir múltiples URLs (scraper.urls) y credenciales ` +
                `de NordVPN, incluyendo el campo nordvpn.preferredLocation.`);
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

function execNordVpn(args, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
                execFile("nordvpn", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
                        if (error) {
                                const enrichedError = new Error(
                                        `Error ejecutando 'nordvpn ${args.join(" ")}'. ${error.message}`
                                );
                                enrichedError.stdout = stdout;
                                enrichedError.stderr = stderr;
                                enrichedError.code = error.code;
                                enrichedError.killed = error.killed;
                                return reject(enrichedError);
                        }
                        resolve({ stdout, stderr });
                });
        });
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
        console.log("[NordVPN CLI] Iniciando verificación de conexión...");

        try {
                await execNordVpn(["connect", server].filter(Boolean), timeoutMs);
        } catch (error) {
                throw new Error(
                        `[NordVPN CLI] No se pudo iniciar la conexión: ${error.message}. ` +
                                (error.stderr ? `Detalles: ${error.stderr}` : "")
                );
        }

        const pollInterval = 2000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
                try {
                        const { stdout } = await execNordVpn(["status"], timeoutMs);
                        if (isNordVpnConnected(stdout, server)) {
                                console.log("[NordVPN CLI] Conexión establecida correctamente.");
                                return;
                        }
                        console.log("[NordVPN CLI] Aún conectando...", stdout.trim());
                } catch (error) {
                        console.warn(
                                `[NordVPN CLI] Error al verificar el estado (${error.message}). Se seguirá intentando...`
                        );
                }

                await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        throw new Error(
                `[NordVPN CLI] Tiempo de espera agotado tras ${timeoutMs} ms esperando la conexión.`
        );
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

function performDirectRequest(urlObject, headers) {
        return new Promise((resolve, reject) => {
                const isHttps = urlObject.protocol === "https:";
                const transport = isHttps ? https : http;
                const request = transport.request(
                        {
                                protocol: urlObject.protocol,
                                hostname: urlObject.hostname,
                                port: urlObject.port || (isHttps ? 443 : 80),
                                path: `${urlObject.pathname || "/"}${urlObject.search || ""}`,
                                method: "GET",
                                headers: {
                                        ...headers,
                                        Host: urlObject.host,
                                        Connection: "close",
                                },
                        },
                        (response) => {
                                collectStream(response)
                                        .then((buffer) => {
                                                resolve({
                                                        statusCode: response.statusCode || 0,
                                                        headers: response.headers,
                                                        body: buffer.toString("utf8"),
                                                });
                                        })
                                        .catch(reject);
                        }
                );

                request.on("error", reject);
                request.end();
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

function performHttpRequestThroughProxy(urlObject, proxyObject, headers) {
        return new Promise((resolve, reject) => {
                const proxyTransport = proxyObject.protocol === "https:" ? https : http;
                const authorization = getProxyAuthorizationHeader(proxyObject);
                const requestHeaders = {
                        ...headers,
                        Host: urlObject.host,
                        Connection: "close",
                };

                if (authorization) {
                        requestHeaders["Proxy-Authorization"] = authorization;
                }

                const request = proxyTransport.request(
                        {
                                protocol: proxyObject.protocol,
                                hostname: proxyObject.hostname,
                                port: proxyObject.port || (proxyObject.protocol === "https:" ? 443 : 80),
                                method: "GET",
                                path: urlObject.toString(),
                                headers: requestHeaders,
                        },
                        (response) => {
                                collectStream(response)
                                        .then((buffer) => {
                                                resolve({
                                                        statusCode: response.statusCode || 0,
                                                        headers: response.headers,
                                                        body: buffer.toString("utf8"),
                                                });
                                        })
                                        .catch(reject);
                        }
                );

                request.on("error", reject);
                request.end();
        });
}

function performHttpsRequestThroughProxy(urlObject, proxyObject, headers) {
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
                                                `Proxy CONNECT falló con código ${response.statusCode}`
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
                                const requestLines = [
                                        `GET ${urlObject.pathname || "/"}${urlObject.search || ""} HTTP/1.1`,
                                        `Host: ${urlObject.host}`,
                                        "Connection: close",
                                ];

                                for (const [key, value] of Object.entries(headers)) {
                                        requestLines.push(`${key}: ${value}`);
                                }

                                requestLines.push("", "");
                                tlsSocket.write(requestLines.join("\r\n"));
                        });

                        collectStream(tlsSocket)
                                .then((buffer) => {
                                        const separator = buffer.indexOf(Buffer.from("\r\n\r\n"));

                                        if (separator === -1) {
                                                throw new Error("Respuesta inválida del servidor HTTPS.");
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
                                                body: bodyBuffer.toString("utf8"),
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

async function fetchWithOptionalProxy(url, { headers = {}, proxyUrl } = {}) {
        const urlObject = new URL(url);
        const requestHeaders = {
                ...headers,
        };

        if (!requestHeaders["User-Agent"]) {
                requestHeaders["User-Agent"] = DEFAULT_USER_AGENT;
        }

        if (!proxyUrl) {
                return performDirectRequest(urlObject, requestHeaders);
        }

        const proxyObject = new URL(proxyUrl);

        if (urlObject.protocol === "http:") {
                return performHttpRequestThroughProxy(urlObject, proxyObject, requestHeaders);
        }

        return performHttpsRequestThroughProxy(urlObject, proxyObject, requestHeaders);
}

function extractLinksDataScripts(html) {
        const results = [];
        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        let index = 0;

        while ((match = scriptRegex.exec(html)) !== null) {
                const content = match[1];
                if (content && content.includes("linksData")) {
                        results.push({ index, content });
                }
                index += 1;
        }

        return results;
}

function extractLinksDataFromScript(scriptContent) {
        const regex = /(?:const|var|let)\s+linksData\s*=\s*({[\s\S]*?});/;
        const match = scriptContent.match(regex);

        if (!match) {
                return null;
        }

        const linksDataString = match[1];

        return vm.runInNewContext(`(${linksDataString})`, {});
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
        } = options;

        if (loadedConfigPath) {
                console.log(`Configuración cargada desde: ${loadedConfigPath}`);
        }

        const urlSet = new Set();
        const urlsToProcess = [];

        const pushUrl = (candidate) => {
                if (typeof candidate !== "string") {
                        return;
                }
                const trimmed = candidate.trim();
                if (!trimmed || urlSet.has(trimmed)) {
                        return;
                }
                urlSet.add(trimmed);
                urlsToProcess.push(trimmed);
        };

        pushUrl(url);

        if (Array.isArray(urls)) {
                for (const item of urls) {
                        pushUrl(item);
                }
        }

        if (urlsToProcess.length === 0) {
                console.error(
                        "Debes proporcionar al menos una URL mediante --url, SCRAPER_URL o el archivo de configuración."
                );
                process.exitCode = 1;
                return;
        }

        if (useNordVpnCli) {
                try {
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

        const requestHeaders = {
                "User-Agent": DEFAULT_USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        };

        let proxyUrlToUse = "";

        if (useNordVPN) {
                if (proxyValidationError) {
                        console.error(proxyValidationError);
                        process.exitCode = 1;
                        return;
                }

                if (!nordVpnProxyUrl) {
                        console.error(
                                "El uso de NordVPN está habilitado, pero no se proporcionó un proxy válido."
                        );
                        console.error(
                                "Configura NORDVPN_PROXY_URL, el archivo de configuración o usa --nordvpn-proxy=http://usuario:pass@host:puerto"
                        );
                        process.exitCode = 1;
                        return;
                }

                proxyUrlToUse = nordVpnProxyUrl;
                console.log("Usando NordVPN mediante el proxy:", maskProxyUrl(nordVpnProxyUrl));
        }

        const aggregatedLinks = [];
        const perUrlStats = [];

        for (const targetUrl of urlsToProcess) {
                console.log(`\nProcesando: ${targetUrl}`);

                try {
                        const response = await fetchWithOptionalProxy(targetUrl, {
                                headers: requestHeaders,
                                proxyUrl: proxyUrlToUse || undefined,
                        });

                        if (response.statusCode === 200) {
                                console.log("Página cargada correctamente.");
                        } else {
                                console.log(
                                        `Error al cargar la página (${targetUrl}). Status: ${response.statusCode}`
                                );
                                continue;
                        }

                        const scripts = extractLinksDataScripts(response.body);

                        if (scripts.length === 0) {
                                console.log(
                                        "No se encontró la variable 'linksData' en los scripts para esta URL."
                                );
                                continue;
                        }

                        let exportedForUrl = 0;

                        for (const script of scripts) {
                                console.log(`Script encontrado en el índice ${script.index}.`);
                                try {
                                        const linksData = extractLinksDataFromScript(script.content);

                                        if (!linksData || !Array.isArray(linksData.links)) {
                                                continue;
                                        }

                                        console.log(
                                                "Datos originales encontrados:",
                                                linksData.links.length,
                                                "enlaces"
                                        );

                                        const cleanedLinks = linksData.links
                                                .filter((link) => {
                                                        if (!link || typeof link.url !== "string") {
                                                                return false;
                                                        }
                                                        const urlWithoutPrefix = link.url.replace(
                                                                "acestream://",
                                                                ""
                                                        );
                                                        return urlWithoutPrefix.length > 0;
                                                })
                                                .map((link) => ({
                                                        name: link.name || "Canal",
                                                        url: link.url,
                                                }));

                                        if (cleanedLinks.length === 0) {
                                                continue;
                                        }

                                        aggregatedLinks.push(...cleanedLinks);
                                        exportedForUrl += cleanedLinks.length;
                                } catch (parseError) {
                                        console.error(
                                                "Error al interpretar la estructura linksData:",
                                                parseError
                                        );
                                }
                        }

                        if (exportedForUrl > 0) {
                                perUrlStats.push({ url: targetUrl, count: exportedForUrl });
                                console.log(
                                        `Total de enlaces exportados para esta URL: ${exportedForUrl}`
                                );
                        } else {
                                console.log(
                                        "No se pudo procesar ningún script con 'linksData' para esta URL."
                                );
                        }
                } catch (error) {
                        console.error(`Error al obtener la página (${targetUrl}):`, error.message);
                }
        }

        if (aggregatedLinks.length === 0) {
                console.log(
                        "No se pudo generar el archivo M3U porque no se encontraron enlaces válidos."
                );
                return;
        }

        const uniqueLinks = [];
        const seenUrls = new Set();

        for (const link of aggregatedLinks) {
                if (!link.url || seenUrls.has(link.url)) {
                        continue;
                }
                seenUrls.add(link.url);
                uniqueLinks.push(link);
        }

        let m3uContent = "#EXTM3U\n";

        uniqueLinks.forEach((link) => {
                const name = link.name || "Canal";
                m3uContent += `#EXTINF:-1 group-title="${name}" tvg-id="${name}",${name}\n`;
                m3uContent += `${link.url}\n`;
        });

        if (!m3uContent.endsWith("\n")) {
                m3uContent += "\n";
        }

        fs.writeFileSync("playlist.m3u", m3uContent, "utf8");
        console.log("\nArchivo M3U generado con éxito como 'playlist.m3u'");

        console.log("\nEstadísticas de exportación:");
        console.log(`- Total de enlaces exportados: ${uniqueLinks.length}`);

        for (const stat of perUrlStats) {
                console.log(`- ${stat.url}: ${stat.count} enlaces encontrados`);
        }

        console.log("- Estructura del archivo M3U generado:");
        console.log("  - Encabezado: #EXTM3U");
        console.log("  - Por cada canal:");
        console.log("    - Línea de información con group-title, tvg-id y nombre");
        console.log("    - URL del stream");
}

const options = parseCliArgs();
extractAndExport(options);
