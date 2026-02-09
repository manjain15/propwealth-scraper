const { getPage } = require("../utils/browser");

// ══════════════════════════════════════════════
// CoreLogic (RP Data) — Property page scraping
//
// Login: OAuth2 via auth.corelogic.asia
// Search: MUI Autocomplete input
// Data: property attributes, AVM tabs, sold section
// ══════════════════════════════════════════════


/**
 * Login to CoreLogic via OAuth2 redirect.
 */
async function loginToCoreLogic(page) {
  await page.goto("https://rpp.corelogic.com.au/", { waitUntil: "domcontentloaded" });

  // Wait for OAuth redirect to auth.corelogic.asia
  await page.waitForURL("**/auth.corelogic.asia/**", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log("CoreLogic login URL:", page.url());

  // Fill login form on OAuth page
  const emailField = await page.waitForSelector(
    'input[type="email"], input[type="text"][name*="user"], input[name="pf.username"], input#username, input[name="username"]',
    { timeout: 15000 }
  );
  await emailField.fill(process.env.CORELOGIC_EMAIL);

  const passField = await page.waitForSelector('input[type="password"]', { timeout: 5000 });
  await passField.fill(process.env.CORELOGIC_PASSWORD);

  await page.click('a#signOnButton, a[data-testid="sign-in-button"]');

  // Wait for redirect back to rpp.corelogic.com.au
  await page.waitForURL("**/rpp.corelogic.com.au/**", { timeout: 30000 });
  await page.waitForTimeout(5000);

  // Dismiss any popups, modals, cookie banners
  try {
    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="close"]',
      '.modal-close',
      '.close-button',
      'button:has-text("Accept")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
    ];
    for (const sel of dismissSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  } catch (e) {
    // No popups to dismiss — fine
  }

  console.log("CoreLogic post-login URL:", page.url());
  return page;
}


/**
 * Search for an address and navigate to the property page.
 */
async function searchAddress(page, address) {
  await page.waitForSelector("input#crux-multi-locality-search", { timeout: 30000 });
  
  // Click on the page body first to dismiss any overlays
  await page.click("body");
  await page.waitForTimeout(500);
  
  await page.click("input#crux-multi-locality-search");
  await page.fill("input#crux-multi-locality-search", address);
  await page.waitForTimeout(2000);

  // Click first autocomplete suggestion
  try {
    await page.waitForSelector(".MuiAutocomplete-option, .MuiAutocomplete-listbox li", { timeout: 5000 });
    await page.click(".MuiAutocomplete-option:first-child, .MuiAutocomplete-listbox li:first-child");
  } catch (e) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
  }

  // Wait for property page to render
  await page.waitForTimeout(3000);
  await page.waitForSelector(".property-attributes, #property-detail", { timeout: 15000 });
}


/**
 * Scrape property-level data from CoreLogic.
 */
async function scrapeProperty(address) {
  const { page, context } = await getPage();

  try {
    await loginToCoreLogic(page);
    await searchAddress(page, address);

    // Scroll down to trigger lazy-loaded content (schools, etc.)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    // ── Step 1: Extract basic property data via page.evaluate ──
    const data = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : "";
      };

      // Property attributes — first instance only (page has comparables too)
      const getAttr = (type) => {
        const el = document.querySelector(
          `.property-attributes div.property-attribute[type="${type}"] .property-attribute-val span:last-child`
        );
        return el ? el.innerText.trim() : "";
      };

      // Year built and property type from attr-container
      const attrMain = document.querySelector(".attr-container.main");
      let yearBuilt = "";
      let propertyType = "";
      if (attrMain) {
        const text = attrMain.innerText;
        const yearMatch = text.match(/Year Built[:\s]*(\d{4})/i);
        const typeMatch = text.match(/Property Type\s*\n\s*([\w\s:]+)/i);
        if (yearMatch) yearBuilt = yearMatch[1];
        if (typeMatch) propertyType = typeMatch[1].trim().split("\n")[0].trim();
      }

      // Listing description
      const listingDesc = getText('p[data-testid="listing-desc"]');

      // Sold section
      const soldSection = document.querySelector('[data-testid="last-sale-transaction-information"]');
      let soldPrice = "";
      let soldDate = "";
      if (soldSection) {
        const soldText = soldSection.innerText;
        const priceMatch = soldText.match(/\$[\d,]+/);
        const dateMatch = soldText.match(/\d{1,2}\s+\w+\s+\d{4}|\d{2}\/\d{2}\/\d{4}/);
        if (priceMatch) soldPrice = priceMatch[0];
        if (dateMatch) soldDate = dateMatch[0];
      }

      // Schools — structured extraction from list items
      const schoolItems = document.querySelectorAll('.nearby-school-list-container li[data-testid="list-template"]');
      const schoolsList = [];
      schoolItems.forEach((li) => {
        const name = li.querySelector('.school-name')?.innerText?.trim() || "";
        const distance = li.querySelector('.school-distance')?.innerText?.trim() || "";
        const type = li.querySelector('#schoolType .MuiChip-label')?.innerText?.trim() || "";
        const sector = li.querySelector('#schoolSector .MuiChip-label')?.innerText?.trim() || "";
        if (name) schoolsList.push({ name, distance, type, sector });
      });

      return {
        bedrooms: getAttr("bed"),
        bathrooms: getAttr("bath"),
        car_spaces: getAttr("car"),
        land_size: getAttr("land-area"),
        floor_area: getAttr("floor-area"),
        year_built: yearBuilt,
        property_type: propertyType,
        listing_description: listingDesc,
        sold_price: soldPrice,
        sold_date: soldDate,
        schools: schoolsList,
      };
    });

    // ── Step 2: Handle AVM tabs (requires clicking) ──
    data.valuation_estimate = "";
    data.rental_low = "";
    data.rental_mid = "";
    data.rental_high = "";
    data.rental_yield = "";

    try {
      // Find all tabs in the AVM section
      const tabs = await page.$$('[data-testid="crux-tab"] button, [data-testid="avm-detail"] [role="tab"], .MuiTabs-root button');

      for (const tab of tabs) {
        const tabText = await tab.innerText();

        // ── Valuation tab ──
        if (tabText.includes("Valuation")) {
          await tab.click();
          await page.waitForTimeout(1500);

          // Get the center value from footer (main estimate)
          const valuation = await page.evaluate(() => {
            const footer = document.querySelector(".valuation-range-footer");
            if (!footer) return "";
            const center = footer.querySelector(".text-center span.author, .legend span.author");
            return center ? center.innerText.trim() : "";
          });

          if (valuation && !valuation.includes("/W") && !valuation.includes("/w")) {
            data.valuation_estimate = valuation;
          }
        }

        // ── Rental tab ──
        if (tabText.includes("Rental")) {
          await tab.click();
          await page.waitForTimeout(1500);

          // Get rental values + yield
          const rental = await page.evaluate(() => {
            const result = { low: "", mid: "", high: "", yield: "" };

            const footer = document.querySelector(".valuation-range-footer");
            if (footer) {
              const spans = footer.querySelectorAll("span.author");
              spans.forEach((span) => {
                const val = span.innerText.trim();
                const parent = span.closest("div");
                if (!parent) return;
                const cls = parent.className;
                if (cls.includes("text-left")) result.low = val;
                else if (cls.includes("text-right")) result.high = val;
                else result.mid = val;
              });
            }

            // Rental yield
            const body = document.querySelector(".property-panel-body");
            if (body) {
              const yieldMatch = body.innerText.match(/([\d.]+)\s*%/);
              if (yieldMatch) result.yield = yieldMatch[1] + "%";
            }

            return result;
          });

          data.rental_low = rental.low;
          data.rental_mid = rental.mid;
          data.rental_high = rental.high;
          data.rental_yield = rental.yield;
        }
      }
    } catch (e) {
      console.log("AVM tab extraction error:", e.message);
    }

    // ── Step 3: Derive market status ──
    data.market_status = data.sold_price ? "OFF Market" : "ON Market";

    return { success: true, data };
  } catch (err) {
    console.error("CoreLogic property scrape error:", err.message);
    return { success: false, error: err.message };
  } finally {
    await context.close();
  }
}


/**
 * Scrape comparable sold data from CoreLogic.
 * Reuses the same login session.
 */
async function scrapeComparables(addresses) {
  const { page, context } = await getPage();
  const results = [];

  try {
    await loginToCoreLogic(page);

    for (const address of addresses) {
      try {
        await searchAddress(page, address);

        const data = await page.evaluate(() => {
          const getAttr = (type) => {
            const el = document.querySelector(
              `.property-attributes div.property-attribute[type="${type}"] .property-attribute-val span:last-child`
            );
            return el ? el.innerText.trim() : "";
          };

          const soldSection = document.querySelector('[data-testid="last-sale-transaction-information"]');
          let soldPrice = "";
          let soldDate = "";
          if (soldSection) {
            const soldText = soldSection.innerText;
            const priceMatch = soldText.match(/\$[\d,]+/);
            const dateMatch = soldText.match(/\d{1,2}\s+\w+\s+\d{4}|\d{2}\/\d{2}\/\d{4}/);
            if (priceMatch) soldPrice = priceMatch[0];
            if (dateMatch) soldDate = dateMatch[0];
          }

          return {
            bedrooms: getAttr("bed"),
            bathrooms: getAttr("bath"),
            car_spaces: getAttr("car"),
            land_size: getAttr("land-area"),
            sold_price: soldPrice,
            sold_date: soldDate,
          };
        });

        results.push({ address, ...data, success: true });
      } catch (err) {
        console.error(`Comparable scrape error for ${address}:`, err.message);
        results.push({ address, success: false, error: err.message });
      }

      await page.waitForTimeout(1500);
    }

    return { success: true, data: results };
  } catch (err) {
    console.error("CoreLogic comparables error:", err.message);
    return { success: false, error: err.message };
  } finally {
    await context.close();
  }
}


module.exports = { scrapeProperty, scrapeComparables };