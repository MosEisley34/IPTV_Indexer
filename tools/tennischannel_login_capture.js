#!/usr/bin/env node

/**
 * Tennis Channel login capture helper.
 *
 * This script launches a local Chromium browser (via Playwright) so that you can
 * sign into https://www.tennischannel.com manually. It listens for outbound
 * network requests and prints the first request that looks like a login attempt.
 *
 * Requirements:
 *   npm install playwright
 *   (The Playwright install step also downloads a browser build.)
 *
 * Usage:
 *   node tools/tennischannel_login_capture.js
 *
 * The script is intentionally verbose so you can follow every step and capture
 * the JSON payload that establishes a session. No credentials are stored in this
 * repository – everything happens locally in your browser session.
 */

const fs = require('fs');
const path = require('path');

let playwright;
try {
  playwright = require('playwright');
} catch (error) {
  console.error('\n[Setup] Unable to load Playwright.');
  console.error('[Setup] Run "npm install playwright" (or yarn/pnpm) on your machine and retry.');
  process.exit(1);
}

const OUTPUT_DIR = path.join(process.cwd(), 'captures');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `tennischannel-login-${Date.now()}.json`);

function looksLikeLoginRequest(request) {
  if (request.method() !== 'POST') {
    return false;
  }

  const url = request.url().toLowerCase();
  if (url.includes('login') || url.includes('signin') || url.includes('authenticate')) {
    return true;
  }

  const headers = request.headers();
  if (headers['x-requested-with'] === 'XMLHttpRequest' && headers['content-type'] && headers['content-type'].includes('application/json')) {
    const postData = request.postData();
    if (!postData) return false;
    try {
      const payload = JSON.parse(postData);
      const keys = Object.keys(payload).map((key) => key.toLowerCase());
      return keys.some((key) => key.includes('user') || key.includes('email')) && keys.some((key) => key.includes('pass'));
    } catch (error) {
      return false;
    }
  }

  return false;
}

async function run() {
  console.log('[Init] Launching Chromium via Playwright...');
  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('[Guide] A browser window should appear shortly.');
  console.log('[Guide] Steps to follow:');
  console.log('  1. Navigate the page if necessary until the login modal/form appears.');
  console.log('  2. Enter your own Tennis Channel credentials inside the browser window.');
  console.log('  3. Submit the form to trigger the login request.');
  console.log('  4. Return to this terminal after submitting the form.');
  console.log('[Guide] The script will automatically watch for the first POST request that looks like a login attempt.');
  console.log('[Guide] Once captured, the request details will be printed and saved locally to help with ongoing development.');

  await page.goto('https://www.tennischannel.com', { waitUntil: 'domcontentloaded' });

  const loginRequest = await new Promise((resolve) => {
    const listener = async (request) => {
      if (!looksLikeLoginRequest(request)) {
        return;
      }

      context.off('request', listener);

      const details = {
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        payload: undefined,
      };

      const postData = request.postData();
      if (postData) {
        try {
          details.payload = JSON.parse(postData);
        } catch (error) {
          details.payload = postData;
        }
      }

      resolve(details);
    };

    context.on('request', listener);
  });

  console.log('\n[Result] Captured Tennis Channel login request!');
  console.log('[Result] URL:', loginRequest.url);
  console.log('[Result] Method:', loginRequest.method);
  console.log('[Result] Headers:', JSON.stringify(loginRequest.headers, null, 2));
  if (typeof loginRequest.payload === 'string') {
    console.log('[Result] Payload (raw):', loginRequest.payload);
  } else {
    console.log('[Result] Payload (JSON):', JSON.stringify(loginRequest.payload, null, 2));
  }

  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(loginRequest, null, 2));
    console.log(`[Result] Saved a copy to ${OUTPUT_FILE}`);
  } catch (error) {
    console.warn('[Result] Unable to persist capture to disk:', error.message);
  }

  console.log('\n[Next] Use the captured payload to update config.yaml or environment variables as needed.');
  console.log('[Next] Press Ctrl+C to exit the browser once you are done inspecting the site.');

  // Leave the browser open so the user can continue experimenting if desired.
}

run().catch((error) => {
  console.error('\n[Error] Something went wrong:', error);
  process.exit(1);
});
