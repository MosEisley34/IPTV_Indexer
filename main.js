const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const vm = require("vm");
const { HttpsProxyAgent } = require("https-proxy-agent");

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
                nordVpnProxyUrl: process.env.NORDVPN_PROXY_URL || "",
        };

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
                `  --help                  Muestra esta ayuda.\n\n` +
                `Variables de entorno:\n` +
                `  USE_NORDVPN=true        Activa el uso de NordVPN.\n` +
                `  NORDVPN_PROXY_URL       Proxy HTTP(S) proporcionado por NordVPN.\n` +
                `  NORDVPN_PROXY_HOST      Host del proxy de NordVPN.\n` +
                `  NORDVPN_PROXY_PORT      Puerto del proxy de NordVPN.\n` +
                `  NORDVPN_USERNAME        Usuario del proxy (si aplica).\n` +
                `  NORDVPN_PASSWORD        Contraseña del proxy (si aplica).`);
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

async function extractAndExport(options) {
        if (options.help) {
                logHelp();
                return;
        }

        const { url, useNordVPN, nordVpnProxyUrl } = options;

        if (!url) {
                console.error(
                        "Debes proporcionar una URL con --url o la variable de entorno SCRAPER_URL."
                );
                process.exitCode = 1;
                return;
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
                        process.exitCode = 1;
                        return;
                }

                console.log("Usando NordVPN mediante el proxy:", maskProxyUrl(nordVpnProxyUrl));

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
                // Realizar una solicitud a la página
                const response = await axios.get(url, requestConfig);

		// Verificar que la respuesta se obtuvo correctamente
		if (response.status === 200) {
			console.log("Página cargada correctamente.");
		} else {
			console.log("Error al cargar la página. Status:", response.status);
			return;
		}

		// Cargar el HTML en cheerio
		const $ = cheerio.load(response.data);

		// Buscar todas las etiquetas <script>
		let found = false;
		$("script").each((index, element) => {
			const scriptContent = $(element).html();

			// Verificar si el script contiene la variable 'linksData'
			if (scriptContent && scriptContent.includes("linksData")) {
				console.log(`Script encontrado en el índice ${index}.`);

				// Buscar el patrón de la variable linksData
				const regex =
					/(?:const|var|let)\s+linksData\s*=\s*({[\s\S]*?});/;
				const match = scriptContent.match(regex);

				if (match) {
					// Extraer el contenido de linksData como una cadena JSON
					const linksDataString = match[1];

                                        try {
                                                // Interpretar la cadena como un literal de objeto de JavaScript.
                                                const linksData = vm.runInNewContext(
                                                        `(${linksDataString})`,
                                                        {}
                                                );
						console.log(
							"Datos originales encontrados:",
							linksData.links.length,
							"enlaces"
						);

						// Limpiar los datos eliminando enlaces vacíos o con solo el prefijo
						const cleanedLinks = linksData.links.filter((link) => {
							const urlWithoutPrefix = link.url.replace(
								"acestream://",
								""
							);
							return urlWithoutPrefix.length > 0;
						});

						// Crear el contenido del archivo M3U
						let m3uContent = "#EXTM3U\n"; // Encabezado del archivo M3U

						// Añadir cada entrada al contenido M3U
						cleanedLinks.forEach((link) => {
							// Crear la línea de información extendida
							m3uContent += `#EXTINF:-1 group-title="${link.name}" tvg-id="${link.name}",${link.name}\n`;
							// Añadir la URL
							m3uContent += `${link.url}\n`;
						});

						// Guardar el archivo M3U
						fs.writeFileSync("playlist.m3u", m3uContent, "utf8");
						console.log(
							"Archivo M3U generado con éxito como 'playlist.m3u'"
						);

						// Mostrar estadísticas
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
