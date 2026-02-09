// ══════════════════════════════════════════════
// AI Text Generation for Suburb Reports
//
// Uses Anthropic Claude API to generate:
//   - Suburb overview / description
//   - Highlights (key selling points)
//   - Future prospects
//
// Passes DSR stats so Claude can reference real data.
// ══════════════════════════════════════════════

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/**
 * Generate suburb report text using Claude.
 *
 * @param {string} suburb
 * @param {string} state
 * @param {string} postcode
 * @param {object} stats - DSR stats to ground the text with real data
 */
async function generateSuburbText(suburb, state, postcode, stats) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn("⚠️ ANTHROPIC_API_KEY not set — returning empty text");
    return { success: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  const statsContext = formatStatsForPrompt(stats);

  const prompt = `You are a professional Australian property research analyst writing for PropWealth, a buyer's agency. Write content for a suburb report on ${suburb}, ${state} ${postcode}.

Use the following real market data to inform your writing. You may reference these numbers but do NOT fabricate any additional statistics:

${statsContext}

Generate the following three sections in JSON format. Write in a professional, informative tone suitable for property investors. Be specific to this suburb — mention local features, transport links, lifestyle amenities, and demographics where relevant.

Return ONLY valid JSON with no markdown fences or explanation:

{
  "suburb_overview": "A 2-3 paragraph overview of the suburb covering location, character, demographics, transport, amenities, and lifestyle. Around 150-200 words.",
  "highlights": "A single paragraph summarising 4-5 key highlights or selling points of the suburb for investors. Around 80-100 words.",
  "future_prospects": "A 1-2 paragraph outlook on the suburb's future growth prospects, referencing infrastructure projects, population trends, and market dynamics. Around 100-150 words."
}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${errBody}`);
    }

    const data = await response.json();

    // Extract text from response
    const text = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse JSON from Claude's response
    const cleaned = text.replace(/```json\s*|```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      success: true,
      data: {
        suburb_overview: parsed.suburb_overview || "",
        highlights: parsed.highlights || "",
        future_prospects: parsed.future_prospects || "",
      },
    };
  } catch (err) {
    console.error("Claude API error:", err.message);
    return { success: false, error: err.message };
  }
}


/**
 * Format DSR stats into readable context for the prompt.
 */
function formatStatsForPrompt(stats) {
  if (!stats || Object.keys(stats).length === 0) {
    return "No market data available.";
  }

  const lines = [];

  if (stats.median_12_months) lines.push(`Median house price (12 months): ${stats.median_12_months}`);
  if (stats.typical_value) lines.push(`Typical value: ${stats.typical_value}`);
  if (stats.gross_rental_yield) lines.push(`Gross rental yield: ${stats.gross_rental_yield}`);
  if (stats.days_on_market) lines.push(`Average days on market: ${stats.days_on_market}`);
  if (stats.stock_on_market) lines.push(`Stock on market: ${stats.stock_on_market}`);
  if (stats.vacancy_rate) lines.push(`Vacancy rate: ${stats.vacancy_rate}`);
  if (stats.vendor_discounting) lines.push(`Average vendor discount: ${stats.vendor_discounting}`);
  if (stats.dsr_score) lines.push(`Demand to supply ratio (DSR): ${stats.dsr_score}/100`);
  if (stats.auction_clearance_rate) lines.push(`Auction clearance rate: ${stats.auction_clearance_rate}`);
  if (stats.renters_percentage) lines.push(`Percentage renters: ${stats.renters_percentage}`);

  return lines.join("\n");
}


module.exports = { generateSuburbText };
