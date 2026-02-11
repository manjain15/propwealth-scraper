// ══════════════════════════════════════════════
// Domain.com.au - Comparable Sales Scraper
//
// Scrapes property profile pages for sold data.
// URL: https://www.domain.com.au/property-profile/{address-slug}
//
// Each page contains __NEXT_DATA__ with Apollo state including:
//   - beds, baths, parking, land size
//   - sale history (price, date, method)
//   - valuation estimates
//   - property type
//
// Usage:
//   const { scrapeDomainComparables } = require("./utils/domain-comparables");
//   const result = await scrapeDomainComparables([
//     "3 Parsons Circuit, Kellyville, NSW 2155",
//     "7 Abernathy Court, Kellyville, NSW 2155"
//   ]);
// ══════════════════════════════════════════════

var { chromium } = require("playwright");

/**
 * Convert a full address string to a Domain property-profile URL slug.
 * "3 Parsons Circuit, Kellyville, NSW 2155" → "3-parsons-circuit-kellyville-nsw-2155"
 */
function addressToSlug(address) {
  return address
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract property data from Domain's __NEXT_DATA__ Apollo state
 */
function extractFromApolloState(apolloState) {
  var result = {};

  // Find the Property entity
  var propertyKey = null;
  var keys = Object.keys(apolloState);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf("Property:") === 0) {
      propertyKey = keys[i];
      break;
    }
  }

  if (!propertyKey) return null;
  var prop = apolloState[propertyKey];

  // Address
  if (prop.address) {
    var addrRef = prop.address.__ref || prop.address;
    var addr = typeof addrRef === "string" ? apolloState[addrRef] : addrRef;
    if (addr) {
      result.address = addr.displayAddress || "";
      result.postcode = addr.postcode || "";
      result.suburb = addr.suburbName || "";
      result.state = addr.state || "";
      result.streetNumber = addr.streetNumber || "";
      result.streetName = addr.streetName || "";
      result.streetType = addr.streetTypeLong || addr.streetType || "";
    }
  }

  // Property type
  if (prop.propertyType) {
    var typeRef = prop.propertyType.__ref || prop.propertyType;
    var pType = typeof typeRef === "string" ? apolloState[typeRef] : typeRef;
    result.propertyType = pType ? (pType.display || pType.name || "") : "";
  }
  if (!result.propertyType && prop.__typename) {
    result.propertyType = prop.__typename.replace("Property:", "");
  }

  // Bedrooms, bathrooms, parking from features or other keys
  // These are often in separate feature objects
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var val = apolloState[key];
    if (!val || typeof val !== "object") continue;

    if (val.__typename === "NumericFeature" || val.__typename === "PropertyFeature") {
      var fName = (val.name || val.label || "").toLowerCase();
      var fVal = val.value || val.count;
      if (fName.indexOf("bed") >= 0) result.bedrooms = fVal;
      else if (fName.indexOf("bath") >= 0) result.bathrooms = fVal;
      else if (fName.indexOf("park") >= 0 || fName.indexOf("car") >= 0 || fName.indexOf("garage") >= 0) result.parking = fVal;
    }
  }

  // Valuation
  if (prop.valuation) {
    var valRef = prop.valuation.__ref || prop.valuation;
    var valObj = typeof valRef === "string" ? apolloState[valRef] : valRef;
    if (valObj) {
      result.estimatedValue = valObj.midPrice || null;
      result.estimateLow = valObj.lowerPrice || null;
      result.estimateHigh = valObj.upperPrice || null;
    }
  }

  // Sale history - look for SaleActivity or TransactionActivity entries
  result.saleHistory = [];
  for (var s = 0; s < keys.length; s++) {
    var sKey = keys[s];
    var sVal = apolloState[sKey];
    if (!sVal || typeof sVal !== "object") continue;

    if (sVal.__typename === "SaleActivity" || sVal.__typename === "TransactionActivity") {
      var sale = {
        price: sVal.price || null,
        date: sVal.date || sVal.activityDate || null,
        method: sVal.method || sVal.channel || "",
        agency: null,
      };
      // Look for agency reference
      if (sVal.agency) {
        var agRef = sVal.agency.__ref || sVal.agency;
        var ag = typeof agRef === "string" ? apolloState[agRef] : agRef;
        if (ag) sale.agency = ag.name || ag.brandName || "";
      }
      if (sale.price || sale.date) {
        result.saleHistory.push(sale);
      }
    }
  }

  // Sort by date descending (most recent first)
  result.saleHistory.sort(function(a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  return result;
}

/**
 * Extract property data from the visible page text (fallback)
 */
function extractFromBodyText(text) {
  var result = {};

  // Beds, baths, parking - look for "4 Beds 2 Baths 2 Parking"
  var bedsMatch = text.match(/(\d+)\s*Beds?/i);
  var bathsMatch = text.match(/(\d+)\s*Baths?/i);
  var parkMatch = text.match(/(\d+)\s*Parking/i);
  if (bedsMatch) result.bedrooms = parseInt(bedsMatch[1]);
  if (bathsMatch) result.bathrooms = parseInt(bathsMatch[1]);
  if (parkMatch) result.parking = parseInt(parkMatch[1]);

  // Land size - "730m²" or "700m²"
  var landMatch = text.match(/(\d+)\s*m²/);
  if (landMatch) result.landSize = landMatch[1] + " sqm";

  // Property type
  if (/\bHouse\b/i.test(text)) result.propertyType = "House";
  else if (/\bUnit\b/i.test(text)) result.propertyType = "Unit";
  else if (/\bApartment\b/i.test(text)) result.propertyType = "Apartment";
  else if (/\bTownhouse\b/i.test(text)) result.propertyType = "Townhouse";

  // Sold price and date from body text
  // "SOLD - $2,400,000" or "Sold $975k" or "$2.4m"
  var priceMatch = text.match(/(?:SOLD|Sold)[^$]*\$([0-9,.]+(?:k|m)?)/i);
  if (priceMatch) {
    var priceStr = priceMatch[1].replace(/,/g, "");
    var priceNum = parseFloat(priceStr);
    if (priceStr.toLowerCase().indexOf("k") >= 0) priceNum *= 1000;
    if (priceStr.toLowerCase().indexOf("m") >= 0) priceNum *= 1000000;
    result.soldPrice = priceNum;
  }

  // Sale history entries from "FEB 2026 Sold $2.4m PRIVATE TREATY"
  var historyPattern = /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{4})\s*Sold\s*\$([0-9,.]+(?:k|m)?)/gi;
  var histMatch;
  result.saleHistory = [];
  var monthMap = { JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun", JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec" };
  while ((histMatch = historyPattern.exec(text)) !== null) {
    var hMonth = monthMap[histMatch[1].toUpperCase()] || histMatch[1];
    var hYear = histMatch[2];
    var hPrice = histMatch[3].replace(/,/g, "");
    var hNum = parseFloat(hPrice);
    if (hPrice.toLowerCase().indexOf("k") >= 0) hNum *= 1000;
    if (hPrice.toLowerCase().indexOf("m") >= 0) hNum *= 1000000;
    result.saleHistory.push({ price: hNum, date: hMonth + " " + hYear });
  }

  return result;
}

/**
 * Scrape comparable sales data from Domain for given addresses.
 *
 * @param {string[]} addresses - Array of full addresses
 * @param {object} [existingBrowser] - Optional shared Playwright browser
 * @returns {object} { success, data: [{ address, bedrooms, bathrooms, parking, landSize, soldPrice, soldDate, ... }] }
 */
async function scrapeDomainComparables(addresses, existingBrowser) {
  var browser = existingBrowser;
  var ownBrowser = false;

  try {
    if (!browser) {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
      });
      ownBrowser = true;
    }

    var context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-AU",
      timezoneId: "Australia/Sydney",
    });

    await context.addInitScript(function() {
      Object.defineProperty(navigator, "webdriver", { get: function() { return false; } });
    });

    var results = [];

    for (var i = 0; i < addresses.length; i++) {
      var address = addresses[i];
      var slug = addressToSlug(address);
      var url = "https://www.domain.com.au/property-profile/" + slug;

      console.log("   Domain [" + (i + 1) + "/" + addresses.length + "]: " + address);
      console.log("   URL: " + url);

      try {
        var page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);

        var pageData = await page.evaluate(function() {
          var result = { bodyText: "", nextData: null, ldJson: null };

          // Get body text
          result.bodyText = (document.body.innerText || "").substring(0, 5000);

          // Get __NEXT_DATA__
          var nextEl = document.querySelector("#__NEXT_DATA__");
          if (nextEl) {
            try {
              var parsed = JSON.parse(nextEl.textContent || "");
              if (parsed.props && parsed.props.pageProps && parsed.props.pageProps["__APOLLO_STATE__"]) {
                result.nextData = parsed.props.pageProps["__APOLLO_STATE__"];
              }
            } catch(e) {}
          }

          // Get LD+JSON (first House schema)
          var ldEls = document.querySelectorAll('script[type="application/ld+json"]');
          for (var j = 0; j < ldEls.length; j++) {
            try {
              var ld = JSON.parse(ldEls[j].textContent || "");
              if (ld["@type"] === "House" || ld["@type"] === "Apartment" || ld["@type"] === "Residence") {
                result.ldJson = ld;
                break;
              }
            } catch(e) {}
          }

          return result;
        });

        await page.close();

        // Extract data — prefer Apollo state, fall back to body text
        var propData = null;
        if (pageData.nextData) {
          propData = extractFromApolloState(pageData.nextData);
        }

        // Merge with body text extraction for any missing fields
        var bodyData = extractFromBodyText(pageData.bodyText);

        // Also get LD+JSON data
        var ldData = pageData.ldJson || {};

        // Combine all sources
        var bedrooms = (propData && propData.bedrooms) || bodyData.bedrooms || ldData.numberOfRooms || null;
        var bathrooms = (propData && propData.bathrooms) || bodyData.bathrooms || ldData.numberOfBathroomsTotal || null;
        var parking = (propData && propData.parking) || bodyData.parking || null;
        var landSize = bodyData.landSize || null;
        var propertyType = bodyData.propertyType || (propData && propData.propertyType) || ldData["@type"] || "";

        // Get most recent sale
        var saleHistory = (propData && propData.saleHistory && propData.saleHistory.length) ? propData.saleHistory : bodyData.saleHistory || [];
        var lastSale = saleHistory.length > 0 ? saleHistory[0] : {};
        var soldPrice = lastSale.price || bodyData.soldPrice || null;
        var soldDate = lastSale.date || null;
        var soldMethod = lastSale.method || "";

        // Format sold price
        var soldPriceFormatted = "";
        if (soldPrice) {
          soldPriceFormatted = "$" + Number(soldPrice).toLocaleString();
        }

        // Format sold date
        var soldDateFormatted = "";
        if (soldDate) {
          // If it's already a readable string like "Feb 2017", use as-is
          if (typeof soldDate === "string" && soldDate.match(/^[A-Z][a-z]{2}\s+\d{4}$/)) {
            soldDateFormatted = soldDate;
          } else {
            try {
              var d = new Date(soldDate);
              if (!isNaN(d.getTime())) {
                var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                soldDateFormatted = d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
              } else {
                soldDateFormatted = soldDate;
              }
            } catch(e) {
              soldDateFormatted = soldDate;
            }
          }
        }

        var compResult = {
          success: true,
          address: (propData && propData.address) || address,
          bedrooms: bedrooms,
          bathrooms: bathrooms,
          car_spaces: parking,
          land_size: landSize,
          property_type: propertyType,
          sold_price: soldPriceFormatted,
          sold_date: soldDateFormatted,
          sold_method: soldMethod,
          estimated_value: propData ? propData.estimatedValue : null,
          sale_history: saleHistory,
          source: "Domain",
        };

        console.log("   ✅ " + compResult.address + " — " + (soldPriceFormatted || "price unknown") + " " + soldDateFormatted);
        results.push(compResult);

        // Brief delay between requests to be respectful
        if (i < addresses.length - 1) {
          await new Promise(function(r) { setTimeout(r, 2000); });
        }

      } catch(err) {
        console.log("   ❌ Failed for " + address + ": " + err.message);
        results.push({
          success: false,
          address: address,
          error: err.message,
        });
      }
    }

    await context.close();
    if (ownBrowser) await browser.close();

    return {
      success: true,
      data: results,
    };

  } catch(err) {
    if (ownBrowser && browser) {
      try { await browser.close(); } catch(e) {}
    }
    console.error("   ❌ Domain scraper error:", err.message);
    return { success: false, error: err.message, data: [] };
  }
}

module.exports = { scrapeDomainComparables, addressToSlug };