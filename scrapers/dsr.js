const { getPage } = require("../utils/browser");

// ══════════════════════════════════════════════
// DSR Data — Direct API approach
//
// Instead of scraping the rendered page, we:
//   1. Log in with Playwright to get JSESSIONID + access_token
//   2. Call getAllMktStats.json directly via HTTP (~100ms vs ~10s)
//
// API endpoint:
//   GET https://dsrdata.com.au/DSRWeb/secure/getAllMktStats.json
//     ?access_token={token}
//     &state={STATE}
//     &postCode={POSTCODE}
//     &locality={SUBURB_UPPERCASE}
//     &propTypeCode=H          (H = Houses)
//     &requestType=DSR
//     &captchaResponse=
//     &status=noRecap
//
// Returns:
//   { response: { month, year, all_mkt_stats: {
//       ACR, DSR, TV, RENTERS, DOM, OSI, YIELD,
//       SOM_PERC, VACANCY, MEDIAN_12, SR, DISCOUNT
//   }}}
// ══════════════════════════════════════════════

const DSR_BASE = "https://dsrdata.com.au";

// ── LOGIN SELECTORS ──
const SELECTORS = {
  emailInput: 'input#emailId',
  passwordInput: 'input#password',
  loginButton: 'input[type="submit"].dsrButton',
};

// Cache the session so we don't re-login for every request
let cachedSession = null;
let sessionExpiry = 0;
const SESSION_TTL = 25 * 60 * 1000; // 25 minutes


/**
 * Log in to DSR Data and capture the access_token + JSESSIONID.
 * 
 * The access_token appears in API calls made after login.
 * We intercept network requests to capture it.
 */
async function getSession() {
  // Return cached session if still valid
  if (cachedSession && Date.now() < sessionExpiry) {
    return cachedSession;
  }

  const { page, context } = await getPage();

  try {
    let accessToken = null;

    // Intercept network requests to capture the access_token
    page.on("request", (request) => {
      const url = request.url();
      const match = url.match(/access_token=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
      if (match) {
        accessToken = match[1];
        console.log("DSR token intercepted from request:", url.substring(0, 150));
      }
    });

    // Login
    await page.goto(`${DSR_BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });
    await page.fill(SELECTORS.emailInput, process.env.DSR_EMAIL);
    await page.fill(SELECTORS.passwordInput, process.env.DSR_PASSWORD);
    await page.click(SELECTORS.loginButton);

    // DSR does an AJAX login — no full page navigation.
    // Wait for either: URL change, login form disappearing, or a post-login element
    await Promise.race([
      page.waitForURL('**/products/**', { timeout: 15000 }).catch(() => {}),
      page.waitForSelector(SELECTORS.emailInput, { state: 'hidden', timeout: 15000 }).catch(() => {}),
      page.waitForTimeout(5000),
    ]);

    console.log("DSR post-login URL:", page.url());

    // Navigate to Suburb Analyser to trigger API calls containing the access_token
    await page.goto(`${DSR_BASE}/products/suburb_analyser_show`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);

    // We need to trigger an actual suburb search to force the getAllMktStats API call
    // which contains the access_token in its URL
    if (!accessToken) {
      try {
        const searchInput = await page.waitForSelector('#autocomplete-ajax', { timeout: 5000 });
        await searchInput.fill("Sydney");
        await page.waitForTimeout(2000);
        
        // The autocomplete dropdown should appear — click the first suggestion
        // or try pressing down arrow + enter to select
        try {
          // Try clicking an autocomplete suggestion
          await page.click('.ui-menu-item:first-child, .ui-autocomplete li:first-child', { timeout: 3000 });
        } catch (e) {
          // Fallback: arrow down + enter
          await page.keyboard.press("ArrowDown");
          await page.waitForTimeout(500);
          await page.keyboard.press("Enter");
        }
        
        // Wait for the API call to fire
        await page.waitForTimeout(5000);
        
        if (accessToken) {
          console.log("DSR token captured after suburb search");
        }
      } catch (e) {
        console.log("Token capture: search trigger failed:", e.message);
      }
    }

    // If still no token, try to find it in the page's JavaScript or cookies
    if (!accessToken) {
      // Check page JavaScript variables — only match valid UUID-format tokens
      accessToken = await page.evaluate(() => {
        // Check common JS variable patterns first
        if (typeof window.accessToken === 'string' && /^[a-f0-9-]{36}$/.test(window.accessToken)) return window.accessToken;
        if (typeof window.access_token === 'string' && /^[a-f0-9-]{36}$/.test(window.access_token)) return window.access_token;
        
        // Search script tags for access_token assignments with UUID values only
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
          const text = script.textContent;
          // Match: access_token = "uuid" or access_token: "uuid"
          const match = text.match(/access_token\s*[=:]\s*['"]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]/);
          if (match) return match[1];
        }
        return null;
      });
      
      if (accessToken) {
        console.log("DSR token found in page JS:", accessToken);
      }
    }

    // Last resort: check the current page URL for a token
    if (!accessToken) {
      const currentUrl = page.url();
      const urlMatch = currentUrl.match(/access_token=([a-f0-9-]+)/);
      if (urlMatch) accessToken = urlMatch[1];
    }

    // Extract JSESSIONID from cookies
    const cookies = await context.cookies();
    const jsessionCookie = cookies.find((c) => c.name === "JSESSIONID");

    if (!jsessionCookie) {
      throw new Error("Failed to capture JSESSIONID after login");
    }

    // If still no access_token, try extracting from page content
    if (!accessToken) {
      accessToken = await page.evaluate(() => {
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
          const match = script.textContent.match(/access_token['":\s]*['"]?([a-f0-9-]{36})['"]?/);
          if (match) return match[1];
        }
        return null;
      });
    }

    if (!accessToken) {
      console.log("DSR page URL at token capture:", page.url());
      throw new Error(
        "Failed to capture access_token (no UUID found in network requests or page JS). " +
        "The suburb search may not have triggered the API call."
      );
    }

    cachedSession = {
      accessToken,
      jsessionId: jsessionCookie.value,
      cookies: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    };
    sessionExpiry = Date.now() + SESSION_TTL;

    console.log("✅ DSR session captured (token + JSESSIONID)");
    return cachedSession;
  } catch (err) {
    console.error("DSR login error:", err.message);
    throw err;
  } finally {
    await context.close();
  }
}


/**
 * Fetch suburb stats from DSR Data via direct API call.
 * No browser needed after initial login — just HTTP GET.
 */
async function scrapeStockOnMarket(suburb, state, postcode) {
  try {
    const session = await getSession();

    const url = buildApiUrl(session.accessToken, suburb, state, postcode);

    console.log("DSR API call:", url.substring(0, 120) + "...");
    console.log("DSR token:", session.accessToken);

    let response = await fetch(url, {
      headers: {
        Accept: "*/*",
        Cookie: session.cookies,
        Referer: `${DSR_BASE}/products/suburb_analyser_show`,
      },
    });

    // Session expired — clear cache and retry once
    if (response.status === 401 || response.status === 403) {
      console.log("⚠️ DSR session expired, re-authenticating...");
      cachedSession = null;
      sessionExpiry = 0;

      const newSession = await getSession();
      const retryUrl = buildApiUrl(newSession.accessToken, suburb, state, postcode);

      response = await fetch(retryUrl, {
        headers: {
          Accept: "*/*",
          Cookie: newSession.cookies,
          Referer: `${DSR_BASE}/products/suburb_analyser_show`,
        },
      });
    }

    if (!response.ok) {
      throw new Error(`DSR API returned ${response.status}`);
    }

    const json = await response.json();
    return formatResponse(json);
  } catch (err) {
    console.error("DSR API error:", err.message);
    return { success: false, error: err.message };
  }
}


/**
 * Build the getAllMktStats.json URL with parameters.
 */
function buildApiUrl(accessToken, suburb, state, postcode) {
  const params = new URLSearchParams({
    access_token: accessToken,
    state: state.toUpperCase(),
    postCode: postcode,
    locality: suburb.toUpperCase(),
    propTypeCode: "H",
    requestType: "DSR",
    captchaResponse: "",
    status: "noRecap",
  });

  return `${DSR_BASE}/DSRWeb/secure/getAllMktStats.json?${params}`;
}


/**
 * Format the raw DSR API response into our standard structure.
 *
 * Raw response shape:
 *   { response: { month, year, all_mkt_stats: {
 *       ACR: 95.1, DSR: 48, TV: 2125300, RENTERS: 20,
 *       DOM: 36, OSI: 45, YIELD: 2.41, SOM_PERC: ".95",
 *       VACANCY: 1.32, MEDIAN_12: 1926610, SR: 68,
 *       DISCOUNT: "-.56"
 *   }}}
 */
function formatResponse(json) {
  const stats = json?.response?.all_mkt_stats;

  if (!stats) {
    return { success: false, error: "No stats in DSR response" };
  }

  const stockOnMarket = parseFloat(stats.SOM_PERC) || 0;
  const vacancy = parseFloat(stats.VACANCY) || 0;
  const dom = parseFloat(stats.DOM) || 0;

  return {
    success: true,
    data: {
      // Primary fields for your suburb report
      stock_on_market: parseFloat(stats.SOM_PERC).toFixed(2) + "%",
      stock_rating: stockOnMarket <= 1.5 ? "Low" : stockOnMarket <= 3.0 ? "Average" : "High",

      days_on_market: String(stats.DOM),
      dom_rating: dom <= 25 ? "Fast" : dom <= 45 ? "Average" : "Slow",

      vendor_discounting: parseFloat(stats.DISCOUNT).toFixed(2) + "%",

      vacancy_rate: parseFloat(stats.VACANCY).toFixed(2) + "%",
      vacancy_rating: vacancy <= 2.0 ? "Low" : vacancy <= 3.0 ? "Average" : "High",

      gross_rental_yield: parseFloat(stats.YIELD).toFixed(2) + "%",
      yield_rating: stats.YIELD >= 5 ? "Strong" : stats.YIELD >= 3 ? "Average" : "Low",

      dsr_score: String(stats.DSR),
      median_12_months: "$" + Number(stats.MEDIAN_12).toLocaleString(),
      typical_value: "$" + Number(stats.TV).toLocaleString(),
      renters_percentage: stats.RENTERS + "%",
      auction_clearance_rate: stats.ACR + "%",
      online_search_interest: String(stats.OSI),
      statistical_reliability: String(stats.SR),

      // Data period
      data_month: json.response.month,
      data_year: json.response.year,
    },
  };
}


function clearSession() {
  cachedSession = null;
  sessionExpiry = 0;
}


module.exports = { scrapeStockOnMarket, clearSession };