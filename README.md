# IPTV M3U Playlist Generator

This Node.js project uses **Axios** and **Cheerio** to scrape IPTV channel links from a webpage and generate an M3U playlist. It extracts and filters valid stream URLs, creating a custom IPTV playlist with channel names and links for easy streaming.

## Features

- Scrapes IPTV channel links from a webpage.
- Filters out invalid stream URLs.
- Generates an M3U playlist file with the extracted data.
- Customizable to work with any webpage containing IPTV links in a structured format.

## Requirements

- Node.js (v14.x or higher)
- npm (Node Package Manager)

## Installation

1. Clone the repository or download the source code.
2. Install dependencies.

```bash
git clone <repository_url>
cd <project_directory>
npm install
```

## Usage

Provide the target URL through the CLI or the `SCRAPER_URL` environment variable:

```bash
node main.js --url="https://example.com/iptv-page"
# o bien
SCRAPER_URL="https://example.com/iptv-page" node main.js
```

The script will:

- Make an HTTP request to the specified webpage.
- Parse the page and extract IPTV channel data.
- Clean invalid URLs (for example, removing the `acestream://` prefix).
- Create an M3U file named `playlist.m3u` in the project directory.

View all available options with:

```bash
node main.js --help
```

### Using NordVPN

You can route requests through a NordVPN proxy. Enable the option with the `--use-nordvpn` flag or the `USE_NORDVPN=true` environment variable and provide the proxy information supplied by NordVPN:

```bash
USE_NORDVPN=true \
NORDVPN_PROXY_URL="http://usuario:password@proxy.nordvpn.com:89" \
node main.js --url="https://example.com/iptv-page"
```

When your credentials contain reserved characters (such as `@`, `:`, or `/`) you can pass them already encoded, or provide the raw values and let the CLI escape them automatically:

```bash
# Credenciales pre-codificadas
NORDVPN_PROXY_URL="http://usuario:pa%40ssword@proxy.nordvpn.com:89" node main.js --use-nordvpn --url="https://example.com/iptv-page"

# Credenciales sin codificar (la herramienta las escapará por ti)
node main.js \
  --url="https://example.com/iptv-page" \
  --use-nordvpn \
  --nordvpn-proxy="http://usuario:pa@ssword@proxy.nordvpn.com:89"
```

Alternatively, specify the proxy components individually:

```bash
USE_NORDVPN=true \
NORDVPN_PROXY_HOST="proxy.nordvpn.com" \
NORDVPN_PROXY_PORT="89" \
NORDVPN_USERNAME="usuario" \
NORDVPN_PASSWORD="password" \
node main.js --url="https://example.com/iptv-page"
```

If you prefer not to use environment variables, provide everything via CLI arguments:

```bash
node main.js \
  --url="https://example.com/iptv-page" \
  --use-nordvpn \
  --nordvpn-proxy="http://usuario:password@proxy.nordvpn.com:89"
```

> **Note:** The script uses the `https-proxy-agent` module to route HTTP and HTTPS requests. Make sure the NordVPN proxy you configure supports the required protocol.

## Example Output

The generated M3U playlist is structured as follows:

```
#EXTM3U
#EXTINF:-1 group-title="News" tvg-id="CNN", CNN News
http://example.com/stream/cnn
#EXTINF:-1 group-title="Sports" tvg-id="ESPN", ESPN
http://example.com/stream/espn
```

## Error Handling

If an error occurs during the scraping process (e.g., invalid URL or network issues), the script prints an informative message in the console.

## Contributing

Feel free to fork this project and submit pull requests for improvements, bug fixes, or new features.

## License

This project is open-source and available under the MIT License.
