const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { execFile } = require("child_process");
const readline = require("readline");
const { Writable } = require("stream");

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

async function main() {
        const options = parseCliArgs();

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

        await extractAndExport(options);
}

main().catch((error) => {
        console.error("Error inesperado:", error);
        process.exitCode = 1;
});

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
                                        process.stdout.write(output, encoding);
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
        const hint = defaultValue ? "S/n" : "s/N";

        while (true) {
                const answer = await askQuestion(`${question} (${hint})`, {
                        defaultValue: "",
                        showDefault: false,
                });
                const normalized = answer.trim().toLowerCase();

                if (!normalized) {
                        return defaultValue;
                }

                if (["s", "si", "sí", "y", "yes"].includes(normalized)) {
                        return true;
                }

                if (["n", "no"].includes(normalized)) {
                        return false;
                }

                console.log("Respuesta no válida. Responde con 's' para sí o 'n' para no.");
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
        console.log(" Asistente de configuración de IPTV Indexer");
        console.log("===============================================\n");
        console.log(`El archivo de configuración se guardará en: ${resolvedPath}\n`);

        const existingUrls = Array.isArray(scraperConfig.urls) ? scraperConfig.urls : [];
        const urlsAnswer = await askQuestion("Introduce las URLs de scraping separadas por coma", {
                defaultValue: existingUrls.join(", "),
        });
        const urls = splitList(urlsAnswer);

        const existingCredentials = Array.isArray(scraperConfig.credentials)
                ? scraperConfig.credentials
                : [];
        const credentialsCountAnswer = await askQuestion("¿Cuántos sitios requieren credenciales?", {
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
                const site = await askQuestion(`Sitio #${i + 1} (dominio)`, {
                        defaultValue: existingEntry.site || "",
                });
                const loginUrl = await askQuestion(`URL de inicio de sesión para el sitio #${i + 1}`, {
                        defaultValue: existingEntry.loginUrl || "",
                });
                const username = await askQuestion(`Usuario para ${site || `el sitio #${i + 1}`}`, {
                        defaultValue: existingEntry.username || "",
                });
                console.log(
                        "Introduce la contraseña (deja vacío para mantener la actual, escribe CLEAR para eliminarla)."
                );
                const passwordAnswer = await askQuestion("Contraseña", {
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

        const formatAnswer = await askQuestion("Formato de salida (m3u/json)", {
                defaultValue: originalOutputFormat || "m3u",
        });
        let outputFormat = formatAnswer.trim().toLowerCase();

        if (!outputFormat || !["m3u", "json"].includes(outputFormat)) {
                console.log("Formato no reconocido. Se utilizará 'm3u'.");
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

        const outputFile = await askQuestion("Nombre del archivo de salida", {
                defaultValue: suggestedOutputFile,
        });

        const useProxyDefault = typeof nordConfig.useProxy === "boolean" ? nordConfig.useProxy : false;
        const useProxy = await askBoolean("¿Deseas usar el proxy de NordVPN?", useProxyDefault);
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
                const proxyProtocol = await askQuestion("Protocolo del proxy (http/https)", {
                        defaultValue: String(proxyProtocolDefault || "http"),
                });
                const proxyHost = await askQuestion("Host del proxy", {
                        defaultValue: proxyHostDefault || "",
                });
                const proxyPortAnswer = await askQuestion("Puerto del proxy", {
                        defaultValue: proxyPortDefault ? String(proxyPortDefault) : "",
                });
                const proxyUsername = await askQuestion("Usuario del proxy (opcional)", {
                        defaultValue: proxyUserDefault || "",
                });
                console.log(
                        "Introduce la contraseña del proxy (deja vacío para mantenerla, escribe CLEAR para eliminarla)."
                );
                const proxyPasswordAnswer = await askQuestion("Contraseña del proxy", {
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
                "¿Deseas que el script ejecute el CLI oficial de NordVPN?",
                useCliDefault
        );
        let cliServer = "";
        let cliTimeoutMs;

        if (useCli) {
                const cliServerDefault =
                        nordConfig.cliServer || nordConfig.preferredLocation || "";
                cliServer = await askQuestion("Servidor o localización para el CLI (opcional)", {
                        defaultValue: cliServerDefault,
                });
                const cliTimeoutDefault =
                        nordConfig.cliTimeoutMs !== undefined ? String(nordConfig.cliTimeoutMs) : "";
                const timeoutAnswer = await askQuestion("Tiempo máximo de espera del CLI (ms)", {
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

        console.log("\nConfiguración guardada correctamente. Resumen:");
        console.log(`- Archivo: ${resolvedPath}`);
        console.log(`- URLs configuradas: ${urls.length}`);
        console.log(`- Credenciales almacenadas: ${credentials.length}`);
        console.log(`- Formato de salida: ${outputFormat.toUpperCase()} (${outputFile})`);
        console.log(`- NordVPN via proxy: ${useProxy ? 'habilitado' : 'deshabilitado'}`);
        console.log(`- NordVPN CLI: ${useCli ? 'habilitado' : 'deshabilitado'}`);

        if (urls.length === 0) {
                console.warn("\nADVERTENCIA: no se configuraron URLs. El scraper no podrá ejecutarse correctamente.");
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
        let requestedOutputFormat;
        let requestedOutputFile;
        let runSetupWizard = false;

        for (const arg of args) {
                if (arg.startsWith('--config=')) {
                        configPathArg = arg.slice('--config='.length);
                } else if (arg === '--setup') {
                        runSetupWizard = true;
                } else if (arg.startsWith('--output-format=')) {
                        requestedOutputFormat = arg.slice('--output-format='.length);
                } else if (arg.startsWith('--output-file=')) {
                        requestedOutputFile = arg.slice('--output-file='.length);
                }
        }

        const envConfigPath = process.env.CONFIG_FILE || process.env.SCRAPER_CONFIG;
        const loadedConfig = loadConfigFile(configPathArg || envConfigPath);
        const fileConfig = isPlainObject(loadedConfig.data) ? loadedConfig.data : {};
        const envOutputFormat = process.env.OUTPUT_FORMAT || process.env.SCRAPER_OUTPUT_FORMAT || '';
        const envOutputFile = process.env.OUTPUT_FILE || process.env.SCRAPER_OUTPUT_FILE || '';
        const config = {
                url: process.env.SCRAPER_URL || '',
                urls: [],
                outputFormat: envOutputFormat,
                outputFile: envOutputFile,
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

                if (arg.startsWith('--nordvpn-cli-timeout=')) {
                        const timeoutMs = Number(arg.slice('--nordvpn-cli-timeout='.length));
                        if (!Number.isNaN(timeoutMs)) {
                                config.nordVpnCliTimeoutMs = timeoutMs;
                        }
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
                }
        }

        if (requestedOutputFormat !== undefined) {
                config.outputFormat = requestedOutputFormat;
        }

        if (requestedOutputFile !== undefined) {
                config.outputFile = requestedOutputFile;
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
        console.log(`Uso: node main.js --url=<URL> [opciones]\n\n` +
                `Opciones:\n` +
                `  --url=<URL>             URL que se desea analizar (también SCRAPER_URL).\n` +
                `  --config=<ruta>         Ruta al archivo YAML de configuración (por defecto ./config.yaml).\n` +
                `  --output-format=<fmt>   Formato de salida (m3u o json).\n` +
                `  --output-file=<ruta>    Archivo de salida para la playlist.\n` +
                `  --use-nordvpn           Fuerza el uso del proxy de NordVPN.\n` +
                `  --nordvpn-proxy=<URL>   URL completa del proxy (p. ej. http://usuario:pass@host:puerto).\n` +
                `  --use-nordvpn-cli       Inicia y verifica la conexión usando el CLI oficial de NordVPN.\n` +
                `  --nordvpn-cli=<server>  Conecta mediante CLI al servidor especificado.\n` +
                `  --nordvpn-cli-timeout=<ms> Tiempo máximo para que el CLI conecte (por defecto 60000 ms).\n` +
                `  --setup                 Inicia el asistente interactivo para generar config.yaml.\n` +
                `  --help                  Muestra esta ayuda.\n\n` +
                `Variables de entorno:\n` +
                `  CONFIG_FILE             Ruta al archivo YAML de configuración.\n` +
                `  SCRAPER_CONFIG          Alias de CONFIG_FILE.\n` +
                `  OUTPUT_FORMAT           Forzar el formato de salida (m3u/json).\n` +
                `  OUTPUT_FILE             Definir el archivo de salida.\n` +
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
                `de NordVPN, incluyendo parámetros como nordvpn.cliServer.`);
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
                outputFormat,
                outputFile,
        } = options;

        if (loadedConfigPath) {
                console.log(`Configuración cargada desde: ${loadedConfigPath}`);
        }

        const normalizedOutputFormat = (outputFormat || "m3u").toLowerCase();
        const normalizedOutputFile = outputFile ||
                (normalizedOutputFormat === "json" ? "playlist.json" : "playlist.m3u");
        console.log(
                `Formato de salida seleccionado: ${normalizedOutputFormat.toUpperCase()} (${normalizedOutputFile})`
        );

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
                        "No se pudo generar el archivo de salida porque no se encontraron enlaces válidos."
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

        const outputPath = path.resolve(normalizedOutputFile);
        ensureDirectoryExists(outputPath);

        if (normalizedOutputFormat === "json") {
                const payload = { channels: uniqueLinks };
                const jsonContent = JSON.stringify(payload, null, 2);
                fs.writeFileSync(outputPath, `${jsonContent}\n`, "utf8");
                console.log(`\nArchivo JSON generado con éxito como '${normalizedOutputFile}'`);
        } else {
                let m3uContent = "#EXTM3U\n";

                uniqueLinks.forEach((link) => {
                        const name = link.name || "Canal";
                        m3uContent += `#EXTINF:-1 group-title="${name}" tvg-id="${name}",${name}\n`;
                        m3uContent += `${link.url}\n`;
                });

                if (!m3uContent.endsWith("\n")) {
                        m3uContent += "\n";
                }

                fs.writeFileSync(outputPath, m3uContent, "utf8");
                console.log(`\nArchivo M3U generado con éxito como '${normalizedOutputFile}'`);
        }

        console.log("\nEstadísticas de exportación:");
        console.log(`- Total de enlaces exportados: ${uniqueLinks.length}`);

        for (const stat of perUrlStats) {
                console.log(`- ${stat.url}: ${stat.count} enlaces encontrados`);
        }

        if (normalizedOutputFormat === "json") {
                console.log("- Estructura del archivo JSON generado:");
                console.log("  {");
                console.log("    \"channels\": [");
                console.log("      { \"name\": \"Canal\", \"url\": \"acestream://...\" }");
                console.log("    ]");
                console.log("  }");
        } else {
                console.log("- Estructura del archivo M3U generado:");
                console.log("  - Encabezado: #EXTM3U");
                console.log("  - Por cada canal:");
                console.log("    - Línea de información con group-title, tvg-id y nombre");
                console.log("    - URL del stream");
        }
}
