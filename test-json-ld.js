import axios from "axios";
import * as cheerio from "cheerio";

async function testJSONLD() {
  try {
    console.log("🔍 Testowanie parsera JSON-LD dostępności...\n");

    const response = await axios.get(
      "https://www.tabou.pl/produkt/rower-dzieciecy-tabou-rocket-cs-alu/"
    );
    const $ = cheerio.load(response.data);

    let availability = null;

    // Test JSON-LD parsing (kod z crawler.js)
    const jsonLdScripts = $('script[type="application/ld+json"]');
    console.log(`📄 Znaleziono ${jsonLdScripts.length} skryptów JSON-LD`);

    jsonLdScripts.each(function (index) {
      try {
        const data = JSON.parse($(this).html());
        console.log(
          `\n📋 Skrypt ${index + 1}:`,
          typeof data,
          data["@type"] || "brak @type"
        );

        if (data["@graph"]) {
          console.log(`   📊 @graph ma ${data["@graph"].length} elementów`);
          for (const item of data["@graph"]) {
            if (item["@type"] === "Product" && item.offers) {
              console.log("   🎯 Znaleziono Product z offers!");
              console.log(
                "   📦 Offers:",
                typeof item.offers,
                Array.isArray(item.offers)
                  ? `array[${item.offers.length}]`
                  : "object"
              );

              if (Array.isArray(item.offers)) {
                for (const offer of item.offers) {
                  if (offer.availability) {
                    console.log(`   ✅ Availability: ${offer.availability}`);
                    if (offer.availability.includes("InStock")) {
                      availability = "dostępny";
                    } else if (offer.availability.includes("OutOfStock")) {
                      availability = "niedostępny";
                    }
                    break;
                  }
                }
              } else if (item.offers.availability) {
                console.log(
                  `   ✅ Single Availability: ${item.offers.availability}`
                );
                if (item.offers.availability.includes("InStock")) {
                  availability = "dostępny";
                } else if (item.offers.availability.includes("OutOfStock")) {
                  availability = "niedostępny";
                }
              }

              if (availability) break;
            }
          }
        }

        // Sprawdź też pojedynczy obiekt
        if (data["@type"] === "Product" && data.offers) {
          console.log("   🎯 Znaleziono pojedynczy Product z offers!");
          if (data.offers.availability) {
            console.log(
              `   ✅ Direct Availability: ${data.offers.availability}`
            );
            if (data.offers.availability.includes("InStock")) {
              availability = "dostępny";
            } else if (data.offers.availability.includes("OutOfStock")) {
              availability = "niedostępny";
            }
          }
        }
      } catch (e) {
        console.log(
          `   ❌ Błąd parsowania skryptu ${index + 1}:`,
          e.message.substring(0, 50)
        );
      }
    });

    console.log(`\n🎯 WYNIK PARSOWANIA JSON-LD:`);
    console.log(`   Dostępność: ${availability || "nie znaleziono"}`);

    // Dla porównania - sprawdźmy tradycyjne selektory
    console.log(`\n🔧 TRADYCYJNE SELEKTORY:`);
    const stockEl = $(".stock").first();
    console.log(
      `   .stock: ${
        stockEl.length ? stockEl.text().trim() || "pusty" : "nie znaleziono"
      }`
    );

    const variationsForm = $(".variations_form");
    console.log(
      `   .variations_form: ${
        variationsForm.length ? "znaleziono" : "nie znaleziono"
      }`
    );

    const addToCartBtn = $(
      'button[name="add-to-cart"], input[name="add-to-cart"], .add-to-cart-button'
    );
    console.log(
      `   przycisk koszyka: ${
        addToCartBtn.length
          ? addToCartBtn.prop("disabled")
            ? "nieaktywny"
            : "aktywny"
          : "nie znaleziono"
      }`
    );
  } catch (err) {
    console.error("❌ Błąd:", err.message);
  }
}

testJSONLD();
