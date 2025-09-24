import axios from "axios";
import * as cheerio from "cheerio";

// Skopiuj funkcję parseProductData z crawler.js (linia 347-886)
function parseProductData($, url) {
  // Inicjalizacja obiektu produktu
  const product = {
    name: "",
    price: "",
    availability: "",
    url: url,
    description: "",
    colors: [],
  };

  // 📛 NAZWA - ulepszone selektory dla WooCommerce/Tabou.pl
  const nameSelectors = [
    "h1", // Główny selektor tytułu produktu
    ".product-title, .product-name",
    ".entry-title, .page-title",
  ];

  for (const selector of nameSelectors) {
    const nameEl = $(selector).first();
    if (nameEl.length > 0) {
      const nameText = nameEl.text().trim();
      if (nameText && nameText.length > 5) {
        product.name = nameText;
        console.log(`   📛 Nazwa (${selector}): "${nameText}"`);
        break;
      }
    }
  }

  // 💰 CENA - ulepszone selektory DOM dla WooCommerce/Tabou.pl
  const priceSelectors = [
    ".price .woocommerce-Price-amount bdi", // Najlepszy selektor dla Tabou.pl
    ".price .woocommerce-Price-amount",
    ".price .amount",
    ".product-price .amount",
    ".woocommerce-price-amount",
  ];

  for (const selector of priceSelectors) {
    const priceEl = $(selector).first();
    if (priceEl.length > 0) {
      let priceText = priceEl.text().trim();
      if (priceText && priceText.match(/\d/)) {
        product.price = priceText;
        console.log(`   💰 Cena (${selector}): "${priceText}"`);
        break;
      }
    }
  }

  // Jeśli selektory DOM nie działają, szukaj wzorców tekstowych
  if (!product.price) {
    const text = $("body").text();
    const priceMatch = text.match(/Cena[\s:]*(\d+[,\.]?\d*\s*(?:zł|PLN))/i);
    if (priceMatch) {
      product.price = priceMatch[0].trim();
      console.log(`   💰 Cena (wzorzec tekstowy): "${product.price}"`);
    }
  }

  // Dostępność - ulepszone selektory DOM i wzorce tekstowe dla WooCommerce/Tabou.pl
  const availabilitySelectors = [
    ".stock", // GŁÓWNY selektor dla Tabou.pl
    ".woocommerce-variation-availability", // WooCommerce availability div
    ".product-availability, .availability",
    ".stock-status, .stock-info",
    ".product-status, .inventory-status",
    ".woocommerce-stock-status",
  ];

  // Najpierw sprawdź JSON-LD schema.org dla dostępności
  const jsonLdScripts = $('script[type="application/ld+json"]');
  jsonLdScripts.each(function () {
    try {
      const data = JSON.parse($(this).html());
      if (data["@graph"]) {
        for (const item of data["@graph"]) {
          if (item["@type"] === "Product" && item.offers) {
            if (Array.isArray(item.offers)) {
              for (const offer of item.offers) {
                if (offer.availability) {
                  const avail = offer.availability;
                  if (avail.includes("InStock")) {
                    product.availability = "dostępny";
                  } else if (avail.includes("OutOfStock")) {
                    product.availability = "niedostępny";
                  }
                  console.log(
                    `   📦 Dostępność (JSON-LD): "${product.availability}" z ${avail}`
                  );
                  return false; // break z each
                }
              }
            } else if (item.offers.availability) {
              const avail = item.offers.availability;
              if (avail.includes("InStock")) {
                product.availability = "dostępny";
              } else if (avail.includes("OutOfStock")) {
                product.availability = "niedostępny";
              }
              console.log(
                `   📦 Dostępność (JSON-LD single): "${product.availability}" z ${avail}`
              );
              return false; // break z each
            }
          }
        }
      }
    } catch (e) {
      // ignoruj błędy parsowania JSON
    }
  });

  // Jeśli nie znaleziono w JSON-LD, spróbuj selektorów DOM
  if (!product.availability) {
    for (const selector of availabilitySelectors) {
      const availEl = $(selector).first();
      if (availEl.length > 0) {
        const availText = availEl.text().trim();
        if (availText && availText.length > 3) {
          product.availability = availText;
          console.log(`   📦 Dostępność (${selector}): "${availText}"`);
          break;
        }
      }
    }
  }

  // 🎨 KOLORY - prawidłowy kod z crawler.js
  const colorList = $('.color-attribute-select[data-group="kolorystyka"]');
  if (colorList.length > 0) {
    console.log(`   🎨 Znaleziono color-attribute-select: ${colorList.length}`);
    colorList.find("li.select-color").each((i, li) => {
      const $li = $(li);
      const img = $li.find("img");
      const alt = img.attr("alt");
      const dataValue = $li.attr("data-variant-value");

      if (alt) {
        product.colors.push(alt.trim());
        console.log(`   🎨 Kolor z alt: "${alt.trim()}"`);
      } else if (dataValue) {
        const colorName = dataValue.replace(/-/g, " / ");
        product.colors.push(colorName);
        console.log(`   🎨 Kolor z data-value: "${colorName}"`);
      }
    });

    if (product.colors.length > 0) {
      console.log(`   🎨 Wszystkie kolory: [${product.colors.join(", ")}]`);
    }
  } else {
    console.log(`   🎨 Brak .color-attribute-select na stronie`);
  }

  // DEBUGOWANIE: Loguj każdy zescrapowany produkt
  console.log("\n🔍 ZESCRAPOWANY PRODUKT:");
  console.log(`📛 Nazwa: ${product.name || "❌ BRAK"}`);
  console.log(`💰 Cena: ${product.price || "❌ BRAK"}`);
  console.log(`📦 Dostępność: ${product.availability || "❌ BRAK"}`);
  console.log(
    `🎨 Kolory: ${
      product.colors.length > 0 ? product.colors.join(", ") : "❌ BRAK"
    }`
  );
  console.log(`🔗 URL: ${product.url}`);
  console.log(`${"─".repeat(60)}`);

  return product;
}

async function testFullParser() {
  try {
    console.log("🎯 TEST KOMPLETNEGO PARSERA PRODUKTU\n");

    const response = await axios.get(
      "https://www.tabou.pl/produkt/rower-dzieciecy-tabou-rocket-cs-alu/"
    );
    const $ = cheerio.load(response.data);

    const product = parseProductData(
      $,
      "https://www.tabou.pl/produkt/rower-dzieciecy-tabou-rocket-cs-alu/"
    );

    console.log("\n✅ PARSER ZAKOŃCZYŁ PRACĘ");
  } catch (err) {
    console.error("❌ Błąd:", err.message);
  }
}

testFullParser();
