// ══════════════════════════════════════════════
// SQM Research - Vacancy Rate Scraper
//
// URL: https://sqmresearch.com.au/property/vacancy-rates?postcode=XXXX
//
// The page renders a Highcharts combo chart with 2 series:
//   - "Vacancies" (column) — count of vacant properties
//   - "Vacancy Rate" (line) — percentage vacancy rate
//
// We extract the last data point from the "Vacancy Rate" line series.
// ══════════════════════════════════════════════

const { chromium } = require("playwright");

async function scrapeSqmVacancy(postcode, existingBrowser) {
  var url = "https://sqmresearch.com.au/property/vacancy-rates?postcode=" + postcode;
  var browser = existingBrowser;
  var ownBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      ownBrowser = true;
    }

    var context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    var page = await context.newPage();

    console.log("   SQM: Fetching vacancy rate for postcode " + postcode + "...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for Highcharts to render
    await page.waitForTimeout(5000);

    var result = await page.evaluate(function() {
      var vacancyRate = null;
      var vacancyCount = null;
      var period = null;

      // Access Highcharts charts array
      if (!window.Highcharts || !window.Highcharts.charts) {
        return { vacancy_rate: null, error: "Highcharts not found on page" };
      }

      var charts = window.Highcharts.charts.filter(function(c) { return c; });
      if (charts.length === 0) {
        return { vacancy_rate: null, error: "No charts found" };
      }

      var chart = charts[0];
      var series = chart.series || [];

      for (var i = 0; i < series.length; i++) {
        var s = series[i];
        var name = (s.name || "").toLowerCase();
        var points = s.data || [];

        if (points.length === 0) continue;

        var lastPoint = points[points.length - 1];

        if (name === "vacancy rate") {
          // This is the percentage line series
          vacancyRate = lastPoint.y;

          // Convert timestamp to month/year
          if (lastPoint.x) {
            var d = new Date(lastPoint.x);
            var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            period = months[d.getMonth()] + " " + d.getFullYear();
          }
        } else if (name === "vacancies") {
          // This is the count column series
          vacancyCount = lastPoint.y;
        }
      }

      return {
        vacancy_rate: vacancyRate,
        vacancies: vacancyCount,
        period: period,
      };
    });

    await context.close();
    if (ownBrowser) await browser.close();

    if (result.vacancy_rate !== null && result.vacancy_rate !== undefined) {
      var rateStr = result.vacancy_rate.toFixed(2) + "%";
      console.log(
        "   SQM Vacancy Rate for " + postcode + ": " + rateStr +
        " (" + (result.period || "latest") + ")" +
        (result.vacancies ? " — " + result.vacancies + " vacancies" : "")
      );
      return {
        success: true,
        data: {
          vacancy_rate: rateStr,
          vacancies: result.vacancies,
          postcode: postcode,
          period: result.period,
          source: "SQM Research",
        },
      };
    } else {
      console.log("   SQM: Could not extract vacancy rate for " + postcode);
      console.log("   Error: " + (result.error || "unknown"));
      return {
        success: false,
        error: result.error || "Could not extract vacancy rate",
      };
    }
  } catch (err) {
    if (ownBrowser && browser) {
      try { await browser.close(); } catch (e) {}
    }
    console.error("   SQM scrape error:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { scrapeSqmVacancy };