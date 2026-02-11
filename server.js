require("dotenv").config();
const express = require("express");
const { authMiddleware } = require("./utils/auth");
const { scrapeProperty, scrapeComparables } = require("./scrapers/corelogic");
const { scrapeStockOnMarket } = require("./scrapers/dsr");
const { generateSuburbText } = require("./utils/ai-text");
const {scrapeSqmVacancy} = require("./utils/sqm-vacancy");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(authMiddleware);

// ─── Health check ───
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════
// SUBURB ENDPOINT
// ══════════════════════════════════════════════
//
// Speed-optimised flow:
//   1. DSR API       (~100ms) → all numeric stats
//   2. SQM Research  (~10s)   → vacancy rate (SOP requirement)
//   3. Claude API    (~3-5s)  → suburb overview, highlights, future prospects
//
// Claude receives the DSR stats so it can reference real data.
// No CoreLogic Playwright needed for suburb data anymore.
//
app.post("/api/suburb", async (req, res) => {
  const { suburb, state, postcode, skipAiText } = req.body;

  if (!suburb || !state || !postcode) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: suburb, state, postcode",
    });
  }

  console.log(`📍 Suburb data for: ${suburb} ${state} ${postcode}`);

  try {
    // Step 1: Get DSR stats
    const dsrResult = await scrapeStockOnMarket(suburb, state, postcode).catch(err => ({ success: false, error: err.message }));

    const dsr = dsrResult.success ? dsrResult.data : {};

    // Step 2: ─ AI Text (skip if reusing cached suburb report) ──
    let aiResult = { success: true, data: {} };  // <-- DEFAULT to empty
    if (!skipAiText) {
      console.log(`   🤖 Generating AI text for ${suburb}...`);
      aiResult = await generateSuburbText(suburb, state, postcode, dsr);
      if (!aiResult.success) {
        console.log(`   ⚠️ AI text generation failed: ${aiResult.error}`);
        aiResult = { success: true, data: {} }; // fallback to empty
      }
    } else {
      console.log(`   ⏩ Skipping AI text generation (suburb report being reused)`);
    }

    const ai = aiResult.success ? aiResult.data : {};

    // Log failures
    const errors = [];
    if (!dsrResult.success)
      errors.push({ source: "dsr", error: dsrResult.error });
    if (!aiResult.success)
      errors.push({ source: "claude", error: aiResult.error });

    if (errors.length > 0) console.warn("⚠️ Some sources failed:", errors);

    // ── SQM Research vacancy rate (more accurate than DSR) ──
    let sqmVacancy = null;
    try {
      const sqmResult = await scrapeSqmVacancy(postcode);
      if (sqmResult.success && sqmResult.data?.vacancy_rate) {
        sqmVacancy = sqmResult.data;
        console.log(`   ✅ SQM vacancy: ${sqmVacancy.vacancy_rate} (${sqmVacancy.period || "latest"})`);
      }
    } catch (err) {
      console.log(`   ⚠️ SQM vacancy fetch failed: ${err.message}`);
    }

    // ── COMBINE ──
    const combined = {
      // Text — from Claude (grounded with DSR stats)
      city_name: ai.city_name || "",
      suburb_overview: ai.suburb_overview || "",
      highlights: ai.highlights || [],
      future_prospects: ai.future_prospects || "",
      suburb_demographics: ai.suburb_demographics || "",

      // Numbers — from DSR API
      stock_on_market: dsr.stock_on_market || "",
      stock_rating: dsr.stock_rating || "",
      days_on_market: dsr.days_on_market || "",
      dom_rating: dsr.dom_rating || "",
      vendor_discounting: dsr.vendor_discounting || "",
      gross_rental_yield: dsr.gross_rental_yield || "",
      yield_rating: dsr.yield_rating || "",
      median_house_price: dsr.median_12_months || "",
      typical_value: dsr.typical_value || "",
      renters_percentage: dsr.renters_percentage || "",
      dsr_score: dsr.dsr_score || "",
      auction_clearance_rate: dsr.auction_clearance_rate || "",
      online_search_interest: dsr.online_search_interest || "",

      // Vacancy — from DSR
      vacancy_rate: sqmVacancy?.vacancy_rate || dsr.vacancy_rate || "",
      vacancy_source: sqmVacancy ? "SQM Research" : "DSR Data",
      vacancy_period: sqmVacancy?.period || "",
      vacancy_rating: dsr.vacancy_rating || "",

      // Data period
      data_month: dsr.data_month || "",
      data_year: dsr.data_year || "",
    };

    console.log(`✅ Suburb data compiled for ${suburb} (${Object.keys(errors).length === 0 ? 'all sources OK' : errors.length + ' failures'})`);
    res.json({ success: true, data: combined, errors });
  } catch (err) {
    console.error("❌ Suburb endpoint error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════
// PROPERTY ENDPOINT
// ══════════════════════════════════════════════
// CoreLogic property page → beds, baths, land, year built,
// listing description, rental estimate, valuation, schools
//
app.post("/api/property", async (req, res) => {
  const { address } = req.body;

  if (!address) {
    return res.status(400).json({
      success: false,
      error: "Missing required field: address",
    });
  }

  console.log(`🏠 Property data for: ${address}`);

  try {
    const result = await scrapeProperty(address);
    if (!result.success) return res.status(500).json(result);

    console.log(`✅ Property data compiled`);
    res.json(result);
  } catch (err) {
    console.error("❌ Property endpoint error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════
// COMPARABLES ENDPOINT (only when provided)
// ══════════════════════════════════════════════
// CoreLogic → search each address → extract sold data
//
app.post("/api/comparables", async (req, res) => {
  const { addresses } = req.body;

  if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Missing required field: addresses (array)",
    });
  }

  console.log(`📊 Scraping ${addresses.length} comparables`);

  try {
    const result = await scrapeComparables(addresses);
    console.log(`✅ Comparables done`);
    res.json(result);
  } catch (err) {
    console.error("❌ Comparables endpoint error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── START ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PropWealth Scraper v2 on port ${PORT}`);
  console.log(`   Suburb: DSR API (~100ms) + Claude (~3s)`);
  console.log(`   Property: CoreLogic Playwright (~15s)`);
  console.log(`   Comparables: CoreLogic Playwright (~5s each)`);
});