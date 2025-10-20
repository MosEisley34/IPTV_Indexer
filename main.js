const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const fs = require("fs");
const vm = require("vm");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { CookieJar } = require("tough-cookie");

function parseHeaderString(rawHeaders) {
        if (!rawHeaders) {
                return {};
        }

        const headers = {};
        const segments = rawHeaders
                .split(/\r?\n|;/)
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

function parseCliArgs() {
        const args = process.argv.slice(2);
        const config = {
                url: process.env.SCRAPER_URL || "",
                useNordVPN:
                        process.env.USE_NORDVPN === "true" ||
                        process.env.USE_NORDVPN === "1",
                nordVpnProxyUrl: process.env.NORDVPN_PROXY_URL || "",
                loginUrl: process.env.LOGIN_URL || "",
                loginUsername: process.env.LOGIN_USERNAME || "",
                loginPassword: process.env.LOGIN_PASSWORD || "",
                rawCookies: process.env.SCRAPER_COOKIES || "",
                rawHeaders: process.env.SCRAPER_HEADERS || "",
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

                if (arg.startsWith("--login-url=")) {
                        config.loginUrl = arg.slice("--login-url=".length);
                        continue;
                }

                if (arg.startsWith("--login-username=")) {
                        config.loginUsername = arg.slice("--login-username=".length);
                        continue;
                }

                if (arg.startsWith("--login-password=")) {
                        config.loginPassword = arg.slice("--login-password=".length);
                        continue;
                }

                if (arg.startsWith("--cookies=")) {
                        config.rawCookies = arg.slice("--cookies=".length);
                        continue;
                }

                if (arg.startsWith("--headers=")) {
                        config.rawHeaders = arg.slice("--headers=".length);
                        continue;
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
                `  --login-url=<URL>       URL del endpoint de autenticación.\n` +
                `  --login-username=<USR>  Usuario para autenticarse.\n` +
                `  --login-password=<PWD>  Contraseña para autenticarse.\n` +
                `  --cookies="..."         Cadena cruda de cookies a enviar.\n` +
                `  --headers="..."         Cabeceras adicionales (formato Clave: Valor;...).\n` +
                `  --help                  Muestra esta ayuda.\n\n` +
                `Variables de entorno:\n` +
                `  USE_NORDVPN=true        Activa el uso de NordVPN.\n` +
                `  NORDVPN_PROXY_URL       Proxy HTTP(S) proporcionado por NordVPN.\n` +
                `  NORDVPN_PROXY_HOST      Host del proxy de NordVPN.\n` +
                `  NORDVPN_PROXY_PORT      Puerto del proxy de NordVPN.\n` +
                `  NORDVPN_USERNAME        Usuario del proxy (si aplica).\n` +
                `  NORDVPN_PASSWORD        Contraseña del proxy (si aplica).\n` +
                `  LOGIN_URL               Endpoint para iniciar sesión.\n` +
                `  LOGIN_USERNAME          Usuario para iniciar sesión.\n` +
                `  LOGIN_PASSWORD          Contraseña para iniciar sesión.\n` +
                `  SCRAPER_COOKIES         Cookies crudas a incluir en las peticiones.\n` +
                `  SCRAPER_HEADERS         Cabeceras extra (formato Clave: Valor;...).`);
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

        const {
                url,
                useNordVPN,
                nordVpnProxyUrl,
                loginUrl,
                loginUsername,
                loginPassword,
                rawCookies,
                rawHeaders,
        } = options;

        if (!url) {
                console.error(
                        "Debes proporcionar una URL con --url o la variable de entorno SCRAPER_URL."
                );
                process.exitCode = 1;
                return;
        }

        const jar = new CookieJar();
        const axiosInstance = wrapper(
                axios.create({
                        jar,
                        withCredentials: true,
                })
        );

        const extraHeaders = parseHeaderString(rawHeaders);
        const requestHeaders = {
                "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                ...extraHeaders,
        };

        if (rawCookies) {
                requestHeaders.Cookie = rawCookies;
        }

        const requestConfig = {
                headers: requestHeaders,
        };

        if (useNordVPN) {
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

                const proxyAgent = new HttpsProxyAgent(nordVpnProxyUrl);
                requestConfig.httpAgent = proxyAgent;
                requestConfig.httpsAgent = proxyAgent;
                requestConfig.proxy = false;
        }

        seedCookies(jar, rawCookies, [loginUrl, url]);

        if (loginUrl) {
                if (!loginUsername || !loginPassword) {
                        console.error(
                                "Se indicó un endpoint de autenticación, pero faltan LOGIN_USERNAME o LOGIN_PASSWORD."
                        );
                        process.exitCode = 1;
                        return;
                }

                try {
                        const loginPayload = {
                                username: loginUsername,
                                password: loginPassword,
                        };

                        const loginConfig = {
                                ...requestConfig,
                                headers: {
                                        ...requestConfig.headers,
                                        "Content-Type":
                                                requestConfig.headers["Content-Type"] ||
                                                "application/json",
                                },
                        };

                        const loginResponse = await axiosInstance.post(
                                loginUrl,
                                loginPayload,
                                loginConfig
                        );

                        console.log(
                                "Autenticación completada. Estado:",
                                loginResponse.status
                        );
                } catch (error) {
                        console.error("Error durante la autenticación:", error.message);
                        if (error.response) {
                                console.error("Detalles de la respuesta de login:", {
                                        status: error.response.status,
                                        headers: error.response.headers,
                                        data: error.response.data,
                                });
                        }
                        process.exitCode = 1;
                        return;
                }
        }

        try {
                // Realizar una solicitud a la página
                const response = await axiosInstance.get(url, requestConfig);

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
