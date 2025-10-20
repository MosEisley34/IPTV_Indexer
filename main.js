const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const fs = require("fs");
const vm = require("vm");
const { execFile } = require("child_process");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { CookieJar } = require("tough-cookie");

const DEFAULT_USER_AGENT =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

function parseHeaderString(rawHeaders) {
        if (!rawHeaders) {
                return {};
        }

        const headers = {};
        const segments = rawHeaders
                .split(/\r?\n|;(?![^\"]*\")(?=[^:;]+:)/)
                .map((segment) => segment.trim())
                .filter(Boolean);

        for (const segment of segments) {
                const separatorIndex = segment.indexOf(":");
                if (separatorIndex === -1) {
                        continue;
                }

                const key = segment.slice(0, separatorIndex).trim();
                const value = segment.slice(separatorIndex + 1).trim();
                if (key) {
                        headers[key] = value;
                }
        }

        return headers;
}

function seedCookies(jar, cookieString, targets) {
        if (!cookieString) {
                return;
        }

        const cookies = cookieString
                .split(";")
                .map((cookie) => cookie.trim())
                .filter(Boolean);

        for (const target of targets) {
                if (!target) {
                        continue;
                }

                for (const cookie of cookies) {
                        try {
                                jar.setCookieSync(cookie, target);
                        } catch (error) {
                                console.warn(
                                        `No se pudo registrar la cookie '${cookie}' para ${target}:`,
                                        error.message
                                );
                        }
                }
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

        return { url: buildProxyUrlFromParsed(parsed) };
}

function parseCliArgs() {
        const args = process.argv.slice(2);
        const config = {
                url: process.env.SCRAPER_URL || "",
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

        if (Number.isNaN(config.nordVpnCliTimeoutMs)) {
                config.nordVpnCliTimeoutMs = undefined;
        }

        const nordVpnHost = process.env.NORDVPN_PROXY_HOST;
        const nordVpnPort = process.env.NORDVPN_PROXY_PORT;
        const nordVpnUser = process.env.NORDVPN_USERNAME;
        const nordVpnPass = process.env.NORDVPN_PASSWORD;

        if (!config.nordVpnProxyUrl && nordVpnHost && nordVpnPort) {
                const credentials =
                        nordVpnUser && nordVpnPass
                                ? `${encodeURIComponent(nordVpnUser)}:${encodeURIComponent(
                                          nordVpnPass
                                  )}@`
                                : "";
                config.nordVpnProxyUrl = `http://${credentials}${nordVpnHost}:${nordVpnPort}`;
        }

        for (const arg of args) {
                if (arg === "--help") {
                        return { help: true };
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
                `  --use-nordvpn           Fuerza el uso del proxy de NordVPN.\n` +
                `  --nordvpn-proxy=<URL>   URL completa del proxy (p. ej. http://usuario:pass@host:puerto).\n` +
                `  --use-nordvpn-cli       Inicia y verifica la conexión usando el CLI oficial de NordVPN.\n` +
                `  --nordvpn-cli=<server>  Conecta mediante CLI al servidor especificado.\n` +
                `  --nordvpn-cli-timeout=<ms> Tiempo máximo para que el CLI conecte (por defecto 60000 ms).\n` +
                `  --help                  Muestra esta ayuda.\n\n` +
                `Variables de entorno:\n` +
                `  USE_NORDVPN=true        Activa el uso de NordVPN.\n` +
                `  NORDVPN_PROXY_URL       Proxy HTTP(S) proporcionado por NordVPN.\n` +
                `  NORDVPN_PROXY_HOST      Host del proxy de NordVPN.\n` +
                `  NORDVPN_PROXY_PORT      Puerto del proxy de NordVPN.\n` +
                `  NORDVPN_USERNAME        Usuario del proxy (si aplica).\n` +
                `  NORDVPN_PASSWORD        Contraseña del proxy (si aplica).\n` +
                `  USE_NORDVPN_CLI=true    Ejecuta el CLI de NordVPN antes de iniciar el scraping.\n` +
                `  NORDVPN_CLI_SERVER      Servidor al que se conectará el CLI (opcional).\n` +
                `  NORDVPN_CLI_TIMEOUT_MS  Tiempo máximo de espera para la conexión del CLI.`);
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

function isNordVpnConnected(statusOutput, server) {
        const normalizedOutput = statusOutput.toLowerCase();
        if (!normalizedOutput.includes("status")) {
                return false;
        }

        if (!normalizedOutput.includes("connected")) {
                return false;
        }

        if (server) {
                const normalizedServer = server.toLowerCase();
                return (
                        normalizedOutput.includes(normalizedServer) ||
                        normalizedOutput.includes(`country: ${normalizedServer}`)
                );
        }

        return true;
}

async function ensureNordVpnCliConnection({ server, timeoutMs = 60000 }) {
        console.log("[NordVPN CLI] Verificando estado actual...");

        try {
                const { stdout } = await execNordVpn(["status"], timeoutMs);
                if (isNordVpnConnected(stdout, server)) {
                        console.log("[NordVPN CLI] Ya existe una conexión activa.");
                        return;
                }
        } catch (error) {
                if (error.code === "ENOENT") {
                        throw new Error(
                                "No se encontró el binario 'nordvpn'. Asegúrate de tener el CLI instalado y en el PATH."
                        );
                }
                console.warn(
                        `[NordVPN CLI] No se pudo obtener el estado inicial (${error.message}). Se intentará conectar...`
                );
        }

        console.log(
                `[NordVPN CLI] Conectando${server ? ` al servidor '${server}'` : ""}...`
        );

        const connectArgs = ["connect"];
        if (server) {
                connectArgs.push(server);
        }

        try {
                const { stdout, stderr } = await execNordVpn(connectArgs, timeoutMs);
                if (stdout.trim()) {
                        console.log("[NordVPN CLI]", stdout.trim());
                }
                if (stderr.trim()) {
                        console.warn("[NordVPN CLI]", stderr.trim());
                }
        } catch (error) {
                if (error.stdout) {
                        console.error("[NordVPN CLI] STDOUT:", error.stdout.trim());
                }
                if (error.stderr) {
                        console.error("[NordVPN CLI] STDERR:", error.stderr.trim());
                }
                throw new Error(
                        `[NordVPN CLI] Error al ejecutar el comando de conexión: ${error.message}`
                );
        }

        const start = Date.now();
        const pollInterval = 3000;

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

async function extractAndExport(options) {
        if (options.help) {
                logHelp();
                return;
        }

        const {
                url,
                useNordVPN,
                useNordVpnCli,
                nordVpnProxyUrl,
                nordVpnCliServer,
                nordVpnCliTimeoutMs,
        } = options;

        if (!url) {
                console.error(
                        "Debes proporcionar una URL con --url o la variable de entorno SCRAPER_URL."
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

        const requestConfig = {
                headers: {
                        "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                },
        };

        if (useNordVPN) {
                if (options.proxyValidationError) {
                        console.error(options.proxyValidationError);
                        process.exitCode = 1;
                        return;
                }

                if (!nordVpnProxyUrl) {
                        console.error(
                                "El uso de NordVPN está habilitado, pero no se proporcionó un proxy válido."
                        );
                        console.error(
                                "Configura NORDVPN_PROXY_URL o usa --nordvpn-proxy=http://usuario:pass@host:puerto"
                        );
                }
                process.exitCode = 1;
                return;
        }

        if (useNordVPN) {
                console.log("Usando NordVPN mediante el proxy:", maskProxyUrl(nordVpnProxyUrl));
        }

                let proxyAgent;

                try {
                        proxyAgent = new HttpsProxyAgent(nordVpnProxyUrl);
                } catch (error) {
                        console.error(
                                `Proxy URL inválida: ${error.message}. Revisa tus credenciales o el formato del proxy.`
                        );
                        process.exitCode = 1;
                        return;
                }

                requestConfig.httpAgent = proxyAgent;
                requestConfig.httpsAgent = proxyAgent;
                requestConfig.proxy = false;
        }

        try {
                const response = await axiosInstance.get(url, baseRequestConfig);

                if (response.status === 200) {
                        console.log("Página cargada correctamente.");
                } else {
                        console.log("Error al cargar la página. Status:", response.status);
                        return;
                }

                const $ = cheerio.load(response.data);

                let found = false;
                $("script").each((index, element) => {
                        const scriptContent = $(element).html();

                        if (scriptContent && scriptContent.includes("linksData")) {
                                console.log(`Script encontrado en el índice ${index}.`);

                                const regex =
                                        /(?:const|var|let)\s+linksData\s*=\s*({[\s\S]*?});/;
                                const match = scriptContent.match(regex);

                                if (match) {
                                        const linksDataString = match[1];

                                        try {
                                                const linksData = vm.runInNewContext(
                                                        `(${linksDataString})`,
                                                        {}
                                                );
                                                console.log(
                                                        "Datos originales encontrados:",
                                                        linksData.links.length,
                                                        "enlaces"
                                                );

                                                const cleanedLinks = linksData.links.filter((link) => {
                                                        const urlWithoutPrefix = link.url.replace(
                                                                "acestream://",
                                                                ""
                                                        );
                                                        return urlWithoutPrefix.length > 0;
                                                });

                                                let m3uContent = "#EXTM3U\n";

                                                cleanedLinks.forEach((link) => {
                                                        m3uContent += `#EXTINF:-1 group-title="${link.name}" tvg-id="${link.name}",${link.name}\n`;
                                                        m3uContent += `${link.url}\n`;
                                                });

                                                fs.writeFileSync("playlist.m3u", m3uContent, "utf8");
                                                console.log(
                                                        "Archivo M3U generado con éxito como 'playlist.m3u'"
                                                );

                                                console.log("\nEstadísticas de exportación:");
                                                console.log(
                                                        `- Total de enlaces exportados: ${cleanedLinks.length}`
                                                );
                                                console.log("- Estructura del archivo M3U generado:");
                                                console.log("  - Encabezado: #EXTM3U");
                                                console.log("  - Por cada canal:");
                                                console.log(
                                                        "    - Línea de información con group-title, tvg-id y nombre"
                                                );
                                                console.log("    - URL del stream");

                                                found = true;
                                        } catch (parseError) {
                                                console.error(
                                                        "Error al interpretar la estructura linksData:",
                                                        parseError
                                                );
                                        }
                                }
                        }
                });

                if (!found) {
                        console.log(
                                "No se encontró la variable 'linksData' en los scripts."
                        );
                }
        } catch (error) {
                console.error("Error al obtener la página:", error.message);
                if (error.response) {
                        console.error("Detalles de la respuesta:", {
                                status: error.response.status,
                                headers: error.response.headers,
                                data: error.response.data,
                        });
                }
        }
}

const options = parseCliArgs();
extractAndExport(options);
