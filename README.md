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

### Session-based authentication

If the target site requires authentication, provide login information or raw cookies/headers via CLI flags or environment variables. The script will first call the login endpoint, store the returned cookies, and reuse the authenticated session for the scraping request.

Supported options:

- `--login-url` / `LOGIN_URL`: Authentication endpoint that must be called before scraping.
- `--login-username` / `LOGIN_USERNAME` and `--login-password` / `LOGIN_PASSWORD`: Credentials sent as JSON (`{ "username": "...", "password": "..." }`).
- `--cookies` / `SCRAPER_COOKIES`: Raw cookie string to send with every request (e.g., `session=abc; token=123`). The values are also loaded into the cookie jar.
- `--headers` / `SCRAPER_HEADERS`: Additional headers separated by semicolons or line breaks (e.g., `Authorization: Bearer <token>;X-Custom: value`).

Example:

```bash
LOGIN_URL="https://example.com/api/login" \
LOGIN_USERNAME="usuario" \
LOGIN_PASSWORD="secreto" \
SCRAPER_HEADERS="X-Requested-With: XMLHttpRequest" \
node main.js --url="https://example.com/iptv-page"
```

### Using NordVPN

You can route requests through a NordVPN proxy. Enable the option with the `--use-nordvpn` flag or the `USE_NORDVPN=true` environment variable and provide the proxy information supplied by NordVPN:

```bash
USE_NORDVPN=true \
NORDVPN_PROXY_URL="http://usuario:password@proxy.nordvpn.com:89" \
node main.js --url="https://example.com/iptv-page"
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
