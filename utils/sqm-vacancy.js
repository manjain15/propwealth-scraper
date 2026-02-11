// ══════════════════════════════════════════════
// SQM Research - Vacancy Rate Scraper
//
// Scrapes vacancy rate by postcode from SQM Research.
// URL: https://sqmresearch.com.au/graph_vacancy.php?postcode=XXXX&t=1
//
// No login required, but needs Playwright (browser) because
// the site blocks raw HTTP requests (403).
//
// Usage:
//   const { scrapeSqmVacancy } = require("./utils/sqm-vacancy");
//   const result = await scrapeSqmVacancy("2155");
//   // → { success: true, data: { vacancy_rate: "1.3%", vacancies: 45, postcode: "2155", period: "Dec 2025" } }
// ══════════════════════════════════════════════

const { chromium } = require("playwright");

/**
 * Scrape SQM Research vacancy rate for a given postcode.
 *
 * @param {string} postcode - Australian 4-digit postcode
 * @param {object} [browser] - Optional shared Playwright browser instance
 * @returns {object} { success, data: { vacancy_rate, vacancies, postcode, period }, error? }
 */
async function scrapeSqmVacancy(postcode, existingBrowser) {
  const url = `https://sqmresearch.com.au/graph_vacancy.php?postcode=${postcode}&t=1`;
  let browser = existingBrowser;
  let ownBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      ownBrowser = true;
    }

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    console.log(`   🔍 SQM: Fetching vacancy rate for postcode ${postcode}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for the page content to load
    await page.waitForTimeout(2000);

    // The vacancy rate is typically displayed in the page content.
    // SQM pages show data in different formats — try multiple extraction strategies.
    const result = await page.evaluate(() => {
      const text = document.body.innerText || "";

      // Strategy 1: Look for the latest vacancy rate in the data table
      // SQM shows a table with Month | Vacancy Rate % | No. of Vacancies
      const rows = document.querySelectorAll("table tr");
      let latestRate = null;
      let latestVacancies = null;
      let latestPeriod = null;

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 2) {
          const cellText = cells[0]?.textContent?.trim() || "";
          const rateText = cells[1]?.textContent?.trim() || "";

          // Look for month-year patterns like "Dec 2025", "Jan 2026"
          const monthMatch = cellText.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/i);
          if (monthMatch && rateText.includes("%")) {
            latestPeriod = cellText;
            latestRate = rateText;
            if (cells.length >= 3) {
              latestVacancies = cells[2]?.textContent?.trim() || null;
            }
            // First match is the most recent (tables usually have newest first)
            break;
          }
        }
      }

      // Strategy 2: Look for vacancy rate in page text using regex
      if (!latestRate) {
        // Look for patterns like "Vacancy Rate: 1.3%" or "1.3% vacancy"
        const rateMatch = text.match(/(?:vacancy\s+rate|current\s+vacancy)[:\s]*(\d+\.?\d*)\s*%/i);
        if (rateMatch) {
          latestRate = rateMatch[1] + "%";
        }
      }

      // Strategy 3: Extract from chart data if available
      if (!latestRate) {
        // SQM often embeds data in script tags for charts
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
          const src = script.textContent || "";
          // Look for data arrays like [1.2, 1.3, 1.1, ...]
          const dataMatch = src.match(/data\s*:\s*\[([\d.,\s]+)\]/);
          if (dataMatch) {
            const values = dataMatch[1].split(",").map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
            if (values.length > 0) {
              const lastValue = values[values.length - 1];
              latestRate = lastValue.toFixed(1) + "%";
              break;
            }
          }
        }
      }

      // Strategy 4: Look for the bold/large vacancy rate number on the page
      if (!latestRate) {
        const allText = text;
        // Match standalone percentage that looks like a vacancy rate (0-20%)
        const percentMatches = allText.match(/\b(\d{1,2}\.\d{1,2})%/g);
        if (percentMatches) {
          // Filter for reasonable vacancy rates (0.1% - 15%)
          const reasonable = percentMatches.filter(m => {
            const val = parseFloat(m);
            return val >= 0.1 && val <= 15;
          });
          if (reasonable.length > 0) {
            latestRate = reasonable[0];
          }
        }
      }

      return {
        vacancy_rate: latestRate,
        vacancies: latestVacancies ? parseInt(latestVacancies.replace(/,/g, "")) || null : null,
        period: latestPeriod,
        // For debugging — grab a snippet of the page text
        pageSnippet: text.substring(0, 500),
      };
    });

    await context.close();
    if (ownBrowser) await browser.close();

    if (result.vacancy_rate) {
      console.log(`   ✅ SQM Vacancy Rate for ${postcode}: ${result.vacancy_rate} (${result.period || "latest"})`);
      return {
        success: true,
        data: {
          vacancy_rate: result.vacancy_rate,
          vacancies: result.vacancies,
          postcode,
          period: result.period,
          source: "SQM Research",
        },
      };
    } else {
      console.log(`   ⚠️ SQM: Could not extract vacancy rate for ${postcode}`);
      console.log(`   Page snippet: ${result.pageSnippet?.substring(0, 200)}`);
      return {
        success: false,
        error: "Could not extract vacancy rate from SQM Research page",
        debug: result.pageSnippet?.substring(0, 300),
      };
    }
  } catch (err) {
    if (ownBrowser && browser) {
      try { await browser.close(); } catch {}
    }
    console.error(`   ❌ SQM scrape error:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { scrapeSqmVacancy };