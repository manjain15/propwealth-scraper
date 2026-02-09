const { chromium } = require("playwright");

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

async function getPage() {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // Block images/fonts/media to speed up scraping
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "media"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return { page, context };
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

module.exports = { getBrowser, getPage, closeBrowser };
