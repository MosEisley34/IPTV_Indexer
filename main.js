const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

async function extractAndExport() {
	try {
		const url = "";
		// Realizar una solicitud a la página
		const response = await axios.get(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
		});

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
						// Parsear el JSON
						const linksData = JSON.parse(linksDataString);
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
						console.error("Error al parsear el JSON:", parseError);
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

extractAndExport();
