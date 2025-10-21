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
                `  --test-nordvpn          Run a connectivity test for the configured NordVPN workflow and exit.\n` +
                `  --setup                 Launch the interactive wizard to generate config.yaml.\n` +
                `  --help                  Show this help message.\n\n` +
                `Environment variables:\n` +
                `  CONFIG_FILE             Path to the YAML configuration file.\n` +
                `  SCRAPER_CONFIG          Alias for CONFIG_FILE.\n` +
                `  OUTPUT_FORMAT           Force the output format (m3u/json).\n` +
                `  OUTPUT_FILE             Set the output file.\n` +
                `  LOG_LEVEL               Set the log verbosity (silent/error/warn/info/verbose/debug).\n` +
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
                `including parameters such as nordvpn.cliServer.`);
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

        logVerbose(
                `Preparing request for ${urlObject.href} via ${proxyUrl ? 'proxy' : 'direct connection'}.`
        );
        logDebug(
                `Request headers for ${urlObject.href}: ${JSON.stringify(requestHeaders, null, 2)}`
        );

        if (!requestHeaders["User-Agent"]) {
                requestHeaders["User-Agent"] = DEFAULT_USER_AGENT;
        }

        if (!proxyUrl) {
                logVerbose(`Performing direct request to ${urlObject.href}`);
                return performDirectRequest(urlObject, requestHeaders);
        }

        const proxyObject = new URL(proxyUrl);
        logVerbose(`Performing proxied request to ${urlObject.href} via ${maskProxyUrl(proxyUrl)}`);

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

        const requestHeaders = {
                "User-Agent": DEFAULT_USER_AGENT,
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

        for (const targetUrl of urlsToProcess) {
                console.log(`\nProcessing: ${targetUrl}`);

                try {
                        logVerbose(`Fetching content from ${targetUrl}`);
                        const response = await fetchWithOptionalProxy(targetUrl, {
                                headers: requestHeaders,
                                proxyUrl: proxyUrlToUse || undefined,
                        });

                        logDebug(
                                `Response metadata for ${targetUrl}: ${JSON.stringify(
                                        { statusCode: response.statusCode, headers: response.headers },
                                        null,
                                        2
                                )}`
                        );

                        if (response.statusCode === 200) {
                                console.log("Page loaded successfully.");
                        } else {
                                console.log(
                                        `Error loading page (${targetUrl}). Status: ${response.statusCode}`
                                );
                                continue;
                        }

                        const scripts = extractLinksDataScripts(response.body);
                        logDebug(`Found ${scripts.length} scripts containing 'linksData' markers.`);

                        if (scripts.length === 0) {
                                console.log(
                                        "Could not find the 'linksData' variable in any scripts for this URL."
                                );
                                continue;
                        }

                        let exportedForUrl = 0;

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
                                                        `Script index ${script.index} did not return a valid linksData array.`
                                                );
                                                continue;
                                        }

                                        console.log(
                                                "Original data contains:",
                                                linksData.links.length,
                                                "links"
                                        );
                                        logDebug(
                                                `Sample of parsed linksData keys: ${Object.keys(linksData).join(', ')}`
                                        );

                                        const cleanedLinks = linksData.links
                                                .filter((link) => {
                                                        if (!link || typeof link.url !== "string") {
                                                                logDebug(
                                                                        `Discarding invalid link entry from script index ${script.index}.`
                                                                );
                                                                return false;
                                                        }
                                                        const urlWithoutPrefix = link.url.replace(
                                                                "acestream://",
                                                                ""
                                                        );
                                                        return urlWithoutPrefix.length > 0;
                                                })
                                                .map((link) => ({
                                                        name: link.name || "Channel",
                                                        url: link.url,
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
                                                "Error parsing the linksData structure:",
                                                parseError
                                        );
                                        logDebug(`Problematic script content: ${script.content.slice(0, 500)}...`);
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
                                console.log(
                                        "No script containing 'linksData' could be processed for this URL."
                                );
                                logVerbose(
                                        `No exportable data found for ${targetUrl}; continuing with next target if available.`
                                );
                        }
                } catch (error) {
                        console.error(`Error fetching page (${targetUrl}):`, error.message);
                        logDebug(
                                `Detailed error for ${targetUrl}: ${error.stack || error.message}`
                        );
                }
        }

        if (aggregatedLinks.length === 0) {
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
}
