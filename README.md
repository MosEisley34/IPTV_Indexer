# IPTV M3U Playlist Generator

This Node.js project uses **Axios** and **Cheerio** to scrape IPTV channel links from a webpage and generate an M3U playlist. It extracts and filters valid stream URLs, creating a custom IPTV playlist with channel names and links for easy streaming.

## Features

- Scrapes IPTV channel links from a webpage.
- Filters out invalid stream URLs.
- Generates an M3U playlist file with the extracted data.
- Customizable to work with any webpage containing IPTV links in a structured format.

## Requirements

- Node.js (v14.x or higher)
- NPM (Node Package Manager)

## Installation

1. Clone the repository or download the source code.

   ```bash
   git clone <repository_url>
   cd <project_directory>

    Install the required dependencies:

npm install

Make sure you have the necessary tools (Axios, Cheerio) installed in your project:

    npm install axios cheerio

Usage

    Update the url variable in the script with the webpage URL containing the IPTV links.

    Run the script:

    node index.js

    The script will:
        Make an HTTP request to the specified webpage.
        Parse the page and extract IPTV channel data.
        Clean up invalid URLs (e.g., removing "acestream://" prefix).
        Create an M3U file named playlist.m3u in the project directory.

    The M3U playlist will be saved and ready to use for streaming.

Example Output

The generated M3U playlist will be structured as follows:

#EXTM3U
#EXTINF:-1 group-title="News" tvg-id="CNN", CNN News
http://example.com/stream/cnn
#EXTINF:-1 group-title="Sports" tvg-id="ESPN", ESPN
http://example.com/stream/espn

Error Handling

If an error occurs during the scraping process (e.g., invalid URL, network issues), an error message will be displayed in the console.
Contributing

Feel free to fork this project and submit pull requests for improvements, bug fixes, or new features.
License

This project is open-source and available under the MIT License.


This `README.md` provides a clear overview of your project, setup instructions, and usage details for potential users or contributors.

