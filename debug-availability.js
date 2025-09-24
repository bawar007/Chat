import axios from "axios";
import * as cheerio from "cheerio";

async function checkAvailability() {
  try {
    const response = await axios.get(
      "https://www.tabou.pl/produkt/rower-dzieciecy-tabou-rocket-cs-alu/"
    );
    const $ = cheerio.load(response.data);

    console.log("=== SZUKANIE DOSTĘPNOŚCI ===");

    // Szukaj wszystkich elementów z tekstem dostępność
    $("*")
      .filter(function () {
        const text = $(this).text().toLowerCase();
        return (
          text.includes("dostępn") ||
          text.includes("magazyn") ||
          text.includes("sztuk") ||
          text.includes("stock")
        );
      })
      .each(function () {
        console.log("Element:", $(this).prop("tagName"));
        console.log("Klasy:", $(this).attr("class") || "brak");
        console.log("ID:", $(this).attr("id") || "brak");
        console.log("Tekst:", $(this).text().trim());
        console.log("---");
      });

    // Sprawdź też konkretne selektory
    console.log("\n=== SPRAWDZANIE KONKRETNYCH SELEKTORÓW ===");
    const selectors = [
      ".variations_form",
      ".single_variation_wrap",
      ".woocommerce-variation-availability",
      ".quantity",
      ".add_to_cart_button",
    ];

    selectors.forEach((selector) => {
      const element = $(selector);
      if (element.length) {
        console.log(`✅ ${selector}:`, element.text().trim());
        console.log(`   Klasy:`, element.attr("class"));
      } else {
        console.log(`❌ ${selector}: nie znaleziono`);
      }
    });
  } catch (err) {
    console.error("Błąd:", err.message);
  }
}

checkAvailability();
