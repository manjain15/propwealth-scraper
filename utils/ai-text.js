// ══════════════════════════════════════════════
// AI Text Generation for Suburb Reports
//
// Uses Anthropic Claude API to generate:
//   - City/LGA overview (about the local government area)
//   - Suburb overview (about the specific suburb)
//   - Highlights (array of key selling points)
//   - Future prospects
//   - Suburb demographics paragraph (ABS census-style)
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

Generate the following sections in JSON format. Write in a professional, informative tone suitable for property investors. Be specific — mention local features, transport links, lifestyle amenities, and demographics where relevant.

IMPORTANT: The "city_overview" must be about the LOCAL GOVERNMENT AREA (LGA) / council area, NOT the suburb itself. For example, if the suburb is Kellyville, the city_overview should be about The Hills Shire as a whole. If the suburb is Cranbourne East, the city_overview should be about the City of Casey. The suburb_overview should then be specifically about the suburb within that LGA.

Return ONLY valid JSON with no markdown fences or explanation:

{
  "city_name": "The local government area (LGA) or city/council area that this suburb falls under. For example, Cranbourne East is in 'Casey', Kellyville is in 'The Hills Shire', Gosnells is in 'Gosnells'. Use the official LGA name.",
  "city_overview": "3-5 paragraphs about the LOCAL GOVERNMENT AREA (LGA), NOT the suburb. Cover: (1) the LGA's location and geographic extent within the greater metro area, (2) the LGA's history and development as a region, (3) key economic drivers and employment hubs across the LGA, (4) major infrastructure, transport networks and amenities serving the LGA, (5) the LGA's reputation, lifestyle appeal and demographic character as a whole. Around 250-350 words total. Each paragraph should be separated by a double newline. For example, if writing about Kellyville, this section should be about The Hills Shire — its councils, major town centres, transport corridors, regional parks, and overall character — not specifically about Kellyville.",
  "highlights": ["An array of 4-5 key highlights or notable features of the SUBURB (not the LGA), e.g. 'Canning River', 'Ellis Brook Valley Reserve', 'Gosnells Railway Markets'. These should be notable landmarks, attractions, natural features, or community assets — short names only, not full sentences."],
  "suburb_overview": "3-5 paragraphs specifically about the SUBURB (not the LGA). Cover: (1) the suburb's specific location and boundaries within the LGA, (2) the suburb's history and how it developed, (3) geography, terrain and climate specific to the suburb, (4) lifestyle amenities, schools, parks, and shopping within or very near the suburb, (5) local economy and employment relevant to suburban residents. Around 250-350 words total. Each paragraph should be separated by a double newline.",
  "future_prospects": "1-2 paragraphs on future growth prospects for the LOCAL GOVERNMENT AREA (LGA), NOT just the suburb. Reference major infrastructure projects, transport upgrades, population trends, urban renewal, and economic development across the wider LGA. For example, if writing about Kellyville, discuss The Hills Shire's future — metro extensions, new town centres, regional employment hubs, etc. Around 100-150 words.",
  "suburb_demographics": "A single dense paragraph with ABS census-style demographic data about the suburb. Include approximate area in square kilometres, number of parks and percentage of green space, population figures from 2016 and 2021 censuses with growth percentage, predominant age group, household composition (e.g. couples with children), typical monthly mortgage repayment range, predominant occupation type, and owner-occupier vs renter percentages if available. Write it as flowing prose, not bullet points. Around 80-120 words. Example style: 'The size of Cranbourne East is approximately 13.4 square kilometres. It has 35 parks covering nearly 9.1% of total area. The population of Cranbourne East in 2016 was 16195 people. By 2021 the population was 24679 showing a population growth of 52.4% in the area during that time...'"
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
        max_tokens: 3000,
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
        city_name: parsed.city_name || "",
        city_overview: parsed.city_overview || "",
        suburb_overview: parsed.suburb_overview || "",
        highlights: parsed.highlights || [],
        future_prospects: parsed.future_prospects || "",
        suburb_demographics: parsed.suburb_demographics || "",
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