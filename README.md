# IPTV Indexer

Utility for indexing IPTV playlists.

## Tennis Channel login capture helper

To collect the login API payload locally (since the development environment cannot reach external sites), run the interactive helper script on a machine with browser access:

1. Install Playwright dependencies:
   ```bash
   npm install --save-dev playwright
   npx playwright install chromium
   ```
2. Launch the capture script:
   ```bash
   node tools/tennischannel_login_capture.js
   ```
3. A Chromium window opens. Sign in with your own Tennis Channel credentials inside that browser window. The script listens for the first POST request that looks like an authentication call and prints the URL, headers, and payload. A JSON copy is also saved under `captures/` for reuse.
4. Use the captured payload (and any required headers such as `x-requested-with` or `authorization`) to fill in `config.yaml` or environment variables as needed and rerun the main scraper with your credentials locally. Both the login payload and headers can now be copied directly from the saved JSON.

The repository itself never stores credentials. Everything happens on your machine.
