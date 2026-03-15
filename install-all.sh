#!/usr/bin/env bash
# Install all dependencies and Playwright Chromium for the Phantom Scraper.
set -e
cd "$(dirname "$0")"
echo "Installing npm dependencies..."
npm install
echo "Installing Playwright Chromium..."
npx playwright install chromium
echo "Done. Run: npm start"
