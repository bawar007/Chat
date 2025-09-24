import fs from "fs";
import axios from "axios";
import * as cheerio from "cheerio";
import dotenv from "dotenv";
import { URL } from "url";
import readline from "readline";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ Brak klucza OPENAI_API_KEY w .env");
}

// Konfiguracja crawlera
const CRAWLER_CONFIG = {
  maxDepth: 4, // Zwiększona głębokość dla pełnego pokrycia
  maxPages: 200, // Zwiększona liczba dla wszystkich produktów
  delay: 500, // Optymalne opóźnienie
  baseUrl: "https://www.tabou.pl",
  allowedPaths: [
    "/produkt/",
    "/rowery/", // Główne kategorie rowerów
    "/sklepy/", // Strona sklepu - ujednolicone z startUrls
    "/e-bike/",
    "/gravel/",
    "/mtb/",
    "/mtb-trail/",
    "/cross/",
    "/trekking/",
    "/miejskie/",
    "/dla-dzieci/",
    "/mlodziezowe/",
    "/folding/",
    "/bmx/",
    "/dirt/",
    "/o-nas",
    "/kontakt",
    "/czeste-pytania-faq",
    "/zwroty",
    "/regulamin",
    "/polityka-prywatnosci",
    "/gwarancja",
    "/formy-platnosci",
    "/pliki-do-pobrania",
    "/regulamin-cashback",
    "/reklamacje",
    "/jak-kupowac",
    "/zakupy-na-raty",
  ],
  excludePaths: [
    "/konto/",
    "/zamowienie/",
    "/admin/",
    "/wp-admin/",
    "/wp-content/uploads/",
    "/wp-json/",
    "/blog/", // Wyłączamy blog dla skupienia się na produktach
    "/archiwum-produktow/", // Archiwum może mieć nieaktualne dane
    "?lang=", // Różne wersje językowe
    "/en/", // Wersja angielska
    "/hu/", // Wersja węgierska
    "/de/", // Wersja niemiecka
    "?filtruj=",
    "?archive=",
  ],
};

// Funkcja do interakcji z użytkownikiem
function promptUser(question, options = []) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n${question}`);
    if (options.length > 0) {
      options.forEach((option, index) => {
        console.log(`${index + 1}. ${option}`);
      });
      console.log("0. Przerwij crawler");
    }

    rl.question("\nTwój wybór: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Funkcja do wyświetlania statystyk etapu
function showStageStats(stage, data) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 STATYSTYKI ETAPU: ${stage.toUpperCase()}`);
  console.log(`${"=".repeat(50)}`);

  switch (stage) {
    case "scraping":
      console.log(`🔍 Odwiedzone strony: ${visitedUrls.size}`);
      console.log(`📝 Zescrapowane dane: ${scrapedData.length}`);
      console.log(`🔗 URL-e w kolejce: ${urlQueue.length}`);
      console.log(
        `📦 Produkty: ${scrapedData.filter((p) => p.type === "product").length}`
      );
      console.log(
        `📂 Kategorie: ${
          scrapedData.filter((p) => p.type === "category").length
        }`
      );
      break;
    case "chunks":
      console.log(`📄 Przygotowane chunki: ${data.length}`);
      // Bardzo bezpieczne obliczanie - tylko licznik znaków
      if (Array.isArray(data) && data.length > 0) {
        // Próbkuj tylko 3 pierwsze chunki i policz średnią długość tekstu
        let totalChars = 0;
        const sampleSize = Math.min(3, data.length);
        for (let i = 0; i < sampleSize; i++) {
          if (data[i] && data[i].text) {
            totalChars += data[i].text.length;
          }
        }
        const avgChunkLength = totalChars / sampleSize;
        const estimatedTotalChars = avgChunkLength * data.length;
        const estimatedSizeKB = Math.round(estimatedTotalChars / 1024);
        console.log(
          `💾 Szacunkowy rozmiar: ${estimatedSizeKB} KB (na podstawie próbki)`
        );
      } else {
        console.log(`💾 Szacunkowy rozmiar: 0 KB`);
      }
      break;
    case "embeddings":
      console.log(`🤖 Wygenerowane embeddingi: ${data.length}`);
      // Bezpieczne obliczanie rozmiaru dla embeddingów - unikamy JSON.stringify
      let embeddingSize = 0;
      if (Array.isArray(data) && data.length > 0) {
        // Oblicz rozmiar na podstawie struktury embeddingu bez serializacji JSON
        const sampleSize = Math.min(3, data.length);
        let avgSize = 0;
        for (let i = 0; i < sampleSize; i++) {
          if (data[i]) {
            let itemSize = 0;
            // Rozmiar tekstu
            if (data[i].text) itemSize += data[i].text.length * 2; // UTF-16
            // Rozmiar wektora embeddingu (1536 liczb × 8 bajtów każda)
            if (data[i].embedding) itemSize += data[i].embedding.length * 8;
            // Rozmiar metadata (estimate)
            itemSize += 200; // szacunkowy rozmiar metadata
            avgSize += itemSize;
          }
        }
        avgSize = avgSize / sampleSize;
        embeddingSize = Math.round((avgSize * data.length) / 1024);
      }
      console.log(
        `💾 Szacunkowy rozmiar: ${embeddingSize} KB (bez serializacji JSON)`
      );
      break;
  }
  console.log(`${"=".repeat(50)}\n`);
}

// Zbiór odwiedzonych URL-i
const visitedUrls = new Set();
const urlQueue = [];
const scrapedData = [];

// Dodatkowe struktury do deduplicacji i optymalizacji
const discoveredProductUrls = new Set(); // Unikalne URL-e produktów
const discoveredCategoryUrls = new Set(); // Unikalne URL-e kategorii
const processedEmbeddings = new Set(); // Unikalne embeddingi (hash z contentu)
const globalProductLinks = new Set(); // Globalne unikalne linki produktów

// Funkcja normalizacji URL
function normalizeUrl(url, baseUrl) {
  try {
    const urlObj = new URL(url, baseUrl);
    // Usuń fragmenty i parametry zapytania (opcjonalnie)
    urlObj.hash = "";
    return urlObj.href;
  } catch (err) {
    return null;
  }
}

// Funkcja sprawdzania czy URL jest dozwolony
function isUrlAllowed(url, config) {
  try {
    const urlObj = new URL(url);

    // Sprawdź czy to ta sama domena
    if (urlObj.hostname !== new URL(config.baseUrl).hostname) {
      return false;
    }

    // Sprawdź wykluczone parametry w query string
    const searchParams = urlObj.searchParams;
    if (
      (searchParams.has("action") &&
        searchParams.get("action").includes("yith-woocompare")) ||
      searchParams.has("action") ||
      searchParams.has("archive")
    ) {
      return false;
    }

    // Sprawdź wykluczone ścieżki w pathname i search
    const fullPath = urlObj.pathname + urlObj.search;
    if (
      config.excludePaths.some(
        (path) => fullPath.includes(path) || urlObj.pathname.includes(path)
      )
    ) {
      return false;
    }

    // Jeśli są dozwolone ścieżki, sprawdź czy URL pasuje
    if (config.allowedPaths.length > 0) {
      return config.allowedPaths.some(
        (path) => urlObj.pathname.includes(path) || urlObj.pathname === "/"
      );
    }

    return true;
  } catch (err) {
    return false;
  }
}

// Funkcja filtrująca zbędne URL-e
function isUrlRelevant(url) {
  const urlObj = new URL(url);

  // Filtruj zbędne parametry
  const irrelevantParams = [
    "utm_",
    "gclid",
    "fbclid",
    "_ga",
    "_gid",
    "ref",
    "source",
    "medium",
    "campaign",
    "term",
    "content",
    "hl",
    "gl",
  ];

  for (const [key] of urlObj.searchParams) {
    if (irrelevantParams.some((param) => key.startsWith(param))) {
      return false;
    }
  }

  // Filtruj zbędne ścieżki
  const irrelevantPaths = [
    "/wp-admin/",
    "/wp-login",
    "/wp-content/uploads/",
    "/feed/",
    "/rss/",
    "/sitemap",
    "/robots.txt",
    "/kategoria-produktu/",
    "/tag/",
    "/autor/",
    "/attachment/",
    "/wp-json/",
    "/xmlrpc.php",
    "/search/",
    "/szukaj/",
    "/wyszukiwanie/",
    "/?s=",
    "/page/1/",
    "/page/1", // Pierwsza strona to to samo co główna
    "/cart/",
    "/koszyk/",
    "/checkout/",
    "/kasa/",
    "/my-account/",
    "/moje-konto/",
    "/login/",
    "/register/",
  ];

  if (irrelevantPaths.some((path) => urlObj.pathname.includes(path))) {
    return false;
  }

  // Sprawdź czy to już odkryte URL-e
  if (urlObj.pathname.includes("/produkt/") && discoveredProductUrls.has(url)) {
    return false;
  }

  if (
    (urlObj.pathname.includes("/rowery/") ||
      urlObj.pathname.includes("/kategoria/")) &&
    discoveredCategoryUrls.has(url)
  ) {
    return false;
  }

  return true;
}

// Funkcja wykrywania typu strony
function detectPageType(url, $) {
  if (url.includes("/produkt/")) return "product";
  if (url.includes("/rowery/")) return "category";
  if (url.includes("/sklepy/")) return "shops";

  // Strony informacyjne
  if (url.includes("/faq") || url.includes("/czeste-pytania")) return "faq";
  if (url.includes("/kontakt")) return "contact";
  if (url.includes("/o-nas")) return "about";
  if (url.includes("/zwroty") || url.includes("/reklamacje")) return "returns";
  if (url.includes("/regulamin")) return "terms";
  if (url.includes("/polityka-prywatnosci")) return "privacy";
  if (url.includes("/gwarancja")) return "warranty";
  if (url.includes("/formy-platnosci") || url.includes("/zakupy-na-raty"))
    return "payment";
  if (url.includes("/jak-kupowac")) return "howto";
  if (url.includes("/pliki-do-pobrania")) return "downloads";

  // Wykrywanie na podstawie zawartości - dostosowane do Tabou.pl
  if (
    ($("body").text().includes("Cena") && $("body").text().includes("zł")) ||
    url.includes("/produkt/")
  )
    return "product";

  if (
    $('a[href*="/produkt/"]').length > 2 || // Jeśli jest więcej niż 2 linki do produktów
    url.includes("/rowery/")
  )
    return "category";

  return "general";
}

// Funkcja parsowania danych produktu
function parseProductData($, url) {
  const product = {
    url,
    type: "product",
    name: "",
    price: "",
    availability: "",
    description: "",
    specifications: {},
    images: [],
    category: "",
    sku: "",
    brand: "TABOU",
    // Dodatkowe pola specyficzne dla Tabou.pl
    colors: [],
    frameSize: "",
    wheelSize: "",
    bikeType: "",
    collection: "",
    availableFrameSizes: [],
  };

  // Nazwa produktu - dostosowane do rzeczywistej struktury Tabou.pl
  const nameSelectors = [
    "h1", // Główny nagłówek strony produktu
    ".product-title, .product-name",
    ".entry-title, .page-title",
    '[class*="product-name"], [class*="product-title"]',
  ];

  for (const selector of nameSelectors) {
    const nameEl = $(selector).first();
    if (nameEl.length > 0 && nameEl.text().trim()) {
      product.name = nameEl.text().trim();
      break;
    }
  }

  // Cena - ulepszone selektory DOM i wzorce tekstowe dla Tabou.pl
  const priceSelectors = [
    ".price .woocommerce-Price-amount bdi", // Główny selektor WooCommerce
    ".price .woocommerce-Price-amount",
    ".price .amount, .product-price .amount",
    ".woocommerce-price-amount, .price-current",
    ".product-price, .entry-summary .price",
    ".summary .price span, .price-wrapper span",
  ];

  // Najpierw spróbuj selektorów DOM
  for (const selector of priceSelectors) {
    const priceEl = $(selector).first();
    if (priceEl.length > 0) {
      const priceText = priceEl.text().trim();
      if (priceText && priceText.match(/\d+/)) {
        product.price = priceText.includes("zł")
          ? priceText
          : `${priceText} zł`;
        break;
      }
    }
  }

  // Jeśli selektory DOM nie działają, szukaj w tekście całej strony
  if (!product.price) {
    const text = $("body").text();
    // Wzorzec: "Cena XXX zł" - najczęstszy na Tabou.pl
    const priceMatch = text.match(/Cena\s*(\d+[\d\s,.]*)?\s*zł/i);
    if (priceMatch) {
      product.price = priceMatch[0].trim();
    } else {
      // Alternatywnie: liczby z "zł" (minimum 3 cyfry)
      const altPriceMatch = text.match(/(\d{3,})\s*zł/);
      if (altPriceMatch) {
        product.price = altPriceMatch[0].trim();
      }
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
          break;
        }
      }
    }
  }

  // Jeśli selektory DOM nie działają, szukaj w tekście całej strony
  if (!product.availability) {
    const text = $("body").text();
    const availabilityPatterns = [
      /Dostępny\s*\(\d+\/\d+\s+wariantów\)/i, // "Dostępny (4/5 wariantów)"
      /Dostępne\s+rozmiary[:\s]*([^\n\r\.]+)/i, // Główny wzorzec Tabou.pl
      /Dostępny\s+online/i,
      /W\s+magazynie/i,
      /Na\s+stanie/i,
      /Wszystkie\s+warianty\s+niedostępne/i,
      /Dostępny/i,
      /Niedostępny/i,
      /Wyprzedany/i,
      /Na\s+zamówienie/i,
      /Brak\s+w\s+magazynie/i,
      /Tymczasowo\s+niedostępny/i,
    ];

    for (const pattern of availabilityPatterns) {
      const match = text.match(pattern);
      if (match) {
        product.availability = match[0].trim();
        break;
      }
    }
  }

  // Jeśli nie znaleziono dostępności wyżej, sprawdź warianty produktu
  if (!product.availability) {
    const text = $("body").text();

    // Sprawdź warianty produktu i ich dostępność
    const hasVariants =
      $(".variations select option").length > 1 ||
      $(".variable-item").length > 0 ||
      $("ul[data-attribute_name]").length > 0;

    // Sprawdź dostępne opcje wariantów
    let availableVariants = 0;
    let totalVariants = 0;

    // Sprawdź globalny status dostępności na stronie
    const noVariationsInStock = $("body").hasClass("no-variations-in-stock");
    const outOfStockMessages =
      text.includes("niedostępna") ||
      text.includes("out-of-stock") ||
      text.includes("aktualnie niedostępna");

    if (hasVariants) {
      // Sprawdź dane JSON wariantów jeśli dostępne
      const variationsFormData = $(".variations_form").attr(
        "data-product_variations"
      );
      if (variationsFormData) {
        try {
          const variations = JSON.parse(
            variationsFormData.replace(/&quot;/g, '"')
          );
          totalVariants = variations.length;

          // Sprawdź każdy wariant indywidualnie - uwzględnij kombinacje kolorów i rozmiarów
          availableVariants = variations.filter((v) => {
            const isPurchasable =
              v.is_purchasable === true || v.is_purchasable === "yes";
            const notOutOfStock =
              !v.availability_html.includes("out-of-stock") &&
              !v.availability_html.includes("niedostępna") &&
              !v.availability_html.includes("aktualnie niedostępna");
            return isPurchasable && notOutOfStock;
          }).length;
        } catch (e) {
          console.warn("Błąd parsowania danych wariantów");
        }
      }

      // Jeśli nie udało się z JSON, sprawdź tradycyjnie
      if (totalVariants === 0) {
        // Sprawdź kombinacje wariantów (kolory x rozmiary)
        const colorOptions =
          $('.variations select[data-attribute_name*="kolorystyka"] option')
            .length - 1; // -1 dla "Wybierz opcję"
        const sizeOptions =
          $('.variations select[data-attribute_name*="rozmiar"] option')
            .length - 1;
        const wheelSizeOptions =
          $('.variations select[data-attribute_name*="rozmiar-kola"] option')
            .length - 1;

        if (colorOptions > 0 && (sizeOptions > 0 || wheelSizeOptions > 0)) {
          // Kombinacje kolorów x rozmiary
          totalVariants =
            colorOptions * Math.max(sizeOptions, wheelSizeOptions, 1);
        } else {
          // Zlicz dostępne rozmiary standardowo
          $('.variations select[data-attribute_name*="rozmiar"] option').each(
            (i, el) => {
              const $option = $(el);
              if ($option.val() && $option.val() !== "") {
                totalVariants++;
                // Opcja dostępna jeśli nie ma klasy disabled lub podobnej
                if (!$option.is(":disabled") && !$option.hasClass("disabled")) {
                  availableVariants++;
                }
              }
            }
          );

          // Jeśli nie ma select, sprawdź przyciski wariantów
          if (totalVariants === 0) {
            $(".variable-item").each((i, el) => {
              const $item = $(el);
              totalVariants++;
              if (
                !$item.hasClass("disabled") &&
                !$item.hasClass("unavailable")
              ) {
                availableVariants++;
              }
            });
          }
        }
      }

      // Jeśli strona oznaczona jako brak wariantów w magazynie, wymuś 0 dostępnych
      if (noVariationsInStock || outOfStockMessages) {
        availableVariants = 0;
      }
    }

    for (const pattern of availabilityPatterns) {
      const match = text.match(pattern);
      if (match) {
        // Jeśli znaleziono "Dostępne rozmiary", sprawdź dostępność wariantów
        if (pattern.source.includes("Dostępne") && hasVariants) {
          if (availableVariants > 0) {
            product.availability = `Dostępnych: (${availableVariants} wariantów)`;
          } else {
            product.availability = "Wszystkie warianty niedostępne";
          }
        } else {
          product.availability = match[0].trim();
        }
        break;
      }
    }
  } // Koniec bloku if (!product.availability)

  // Jeśli nie znaleziono statusu dostępności, ustaw domyślną wartość
  if (!product.availability) {
    product.availability = "Dostępność do sprawdzenia";
  }

  // Kolorystyka - ekstrakcja z konkretnej struktury WooCommerce
  const bodyText = $("body").text();
  const allColors = new Set();

  // 1. Znajdź listę kolorów w strukturze WooCommerce (.color-attribute-select)
  const colorList = $('.color-attribute-select[data-group="kolorystyka"]');
  if (colorList.length > 0) {
    colorList.find("li.select-color").each((i, li) => {
      const $li = $(li);
      const img = $li.find("img");
      const alt = img.attr("alt");
      const dataValue = $li.attr("data-variant-value");
      const isActive = $li.hasClass("active");

      if (alt) {
        allColors.add(alt.trim());
        // Oznacz aktualnie wybrany kolor
        if (isActive) {
          product.selectedColor = alt.trim();
        }
      } else if (dataValue) {
        // Fallback - skonwertuj data-variant-value na czytelną nazwę
        const colorName = dataValue.replace(/-/g, " / ");
        allColors.add(colorName);
        if (isActive) {
          product.selectedColor = colorName;
        }
      }
    });
  }

  // 2. Sprawdź inne selektory WooCommerce dla kolorów
  if (allColors.size === 0) {
    const colorSelectors = [
      ".variations .value ul li img[alt]",
      ".wvs-archive-variations-wrapper img[alt]",
      ".wvs-color-variable-item",
      ".variable-item-color",
    ];

    colorSelectors.forEach((selector) => {
      $(selector).each((i, el) => {
        const $el = $(el);
        let colorName = "";

        if ($el.is("img")) {
          colorName = $el.attr("alt");
        } else {
          colorName =
            $el.attr("title") || $el.attr("data-title") || $el.text().trim();
        }

        if (colorName && colorName.trim()) {
          allColors.add(colorName.trim());
        }
      });
    });
  }

  // 3. Sprawdź aktualnie wybrany kolor z tekstu (Kolorystyka: pink / white)
  if (!product.selectedColor) {
    const currentColorMatch = bodyText.match(/Kolorystyka:\s*([^\n\r]+)/i);
    if (currentColorMatch) {
      product.selectedColor = currentColorMatch[1].trim();
      allColors.add(currentColorMatch[1].trim());
    }
  }

  // 4. Fallback - szukaj obrazków z kolorami w alt
  if (allColors.size === 0) {
    $("img[alt]").each((i, el) => {
      const alt = $(el).attr("alt");
      const src = $(el).attr("src") || "";
      if (
        alt &&
        (alt.includes("/") ||
          alt.includes("black") ||
          alt.includes("white") ||
          alt.includes("blue") ||
          alt.includes("red") ||
          alt.includes("green") ||
          alt.includes("pink") ||
          alt.includes("orange") ||
          alt.includes("yellow") ||
          alt.includes("purple") ||
          alt.includes("gray") ||
          alt.includes("grey") ||
          src.includes("color") ||
          src.includes("variant"))
      ) {
        allColors.add(alt.trim());
      }
    });
  }

  // 5. Ustaw kolory w produkcie
  if (allColors.size > 0) {
    product.colors = Array.from(allColors);
  } else {
    product.colors = [];
  }

  // Rozmiar ramy i koła - szukaj wzoru "Rama X cm / koła Y"
  const sizeMatch = bodyText.match(
    /Rama\s+(\d+\s*cm)\s*\/\s*koła\s+(\d+["'])/i
  );
  if (sizeMatch) {
    product.frameSize = sizeMatch[1];
    product.wheelSize = sizeMatch[2];
  }

  // Typ roweru - szukaj "Typ roweru: X"
  const typeMatch = bodyText.match(/Typ roweru:\s*(\w+)/i);
  if (typeMatch) {
    product.bikeType = typeMatch[1];
  }

  // Kolekcja - szukaj "Kolekcja: XXXX"
  const collectionMatch = bodyText.match(/Kolekcja:\s*(\d+)/i);
  if (collectionMatch) {
    product.collection = collectionMatch[1];
  }

  // Dostępne rozmiary ram - szukaj wszystkich opcji rozmiaru
  const frameSizeMatches = bodyText.match(/(\d+\s*cm\s*\/\s*\d+["'])/g);
  if (frameSizeMatches) {
    product.availableFrameSizes = frameSizeMatches;
  }

  // Opis produktu - rozszerzone selektory dla WooCommerce/Tabou
  const descSelectors = [
    ".woocommerce-product-details__short-description",
    ".product-short-description, .short-description",
    ".product-description, .description",
    ".product-content, .entry-content",
    ".product-summary, .summary",
    "#tab-description, .description-tab",
  ];

  for (const selector of descSelectors) {
    const descEl = $(selector).first();
    if (descEl.length > 0) {
      product.description = descEl.text().trim();
      break;
    }
  }

  // Specyfikacje/parametry - rozszerzone selektory dla WooCommerce/Tabou
  const specificationSelectors = [
    ".woocommerce-product-attributes tr",
    ".product-attributes tr, .specifications tr",
    ".product-specs tr, .params tr",
    ".additional-information tr, .product-details tr",
    '[id*="specification"] tr, [class*="spec"] tr',
  ];

  specificationSelectors.forEach((selector) => {
    $(selector).each((i, el) => {
      const key = $(el)
        .find("td:first-child, th:first-child, .attribute-label")
        .text()
        .trim();
      const value = $(el)
        .find("td:last-child, td:nth-child(2), .attribute-value")
        .text()
        .trim();
      if (key && value && key !== value) {
        product.specifications[key] = value;
      }
    });
  });

  // Dodatkowe parsowanie specyfikacji z tekstu strony (specyficzne dla Tabou.pl)
  const specText = bodyText;
  const specPatterns = [
    /RAMA\s+(.*?)(?=\s*NAPĘD|\s*$)/is,
    /NAPĘD\s+(.*?)(?=\s*KOŁA|\s*$)/is,
    /KOŁA\s+(.*?)(?=\s*HAMULCE|\s*$)/is,
    /HAMULCE\s+(.*?)(?=\s*DODATKI|\s*$)/is,
    /DODATKI\s+(.*?)(?=\s*[A-Z]{2,}|\s*$)/is,
  ];

  specPatterns.forEach((pattern) => {
    const match = specText.match(pattern);
    if (match) {
      const section = match[0].split(/\s+/)[0];
      const content = match[1].trim();
      if (content) {
        product.specifications[section] = content;
      }
    }
  });

  // Obrazy produktu - rozszerzone selektory dla WooCommerce/Tabou
  const imageSelectors = [
    ".woocommerce-product-gallery img",
    ".product-images img, .product-gallery img",
    '.gallery img, [class*="product-image"] img',
    ".wp-post-image, .product-photo img",
    ".product-thumbnails img, .product-carousel img",
  ];

  imageSelectors.forEach((selector) => {
    $(selector).each((i, el) => {
      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src");
      if (src && !src.includes("placeholder") && !src.includes("loading")) {
        const normalizedSrc = normalizeUrl(src, url);
        if (normalizedSrc && !product.images.includes(normalizedSrc)) {
          product.images.push(normalizedSrc);
        }
      }
    });
  });

  // SKU/kod produktu - rozszerzone selektory dla WooCommerce/Tabou
  const skuSelectors = [
    ".sku_wrapper .sku, .product_meta .sku",
    ".product-code, .product-sku, .item-code",
    '[class*="sku"], [data-sku]',
    ".product-id, .product-number",
  ];
  for (const selector of skuSelectors) {
    const skuEl = $(selector).first();
    if (skuEl.length > 0) {
      product.sku = skuEl.text().trim();
      break;
    }
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

// Funkcja parsowania kategorii
function parseCategoryData($, url) {
  const category = {
    url,
    type: "category",
    name: "",
    description: "",
    products: [],
    subcategories: [],
  };

  // Nazwa kategorii - rozszerzone selektory dla WooCommerce/Tabou
  const categoryNameSelectors = [
    "h1.page-title, h1.woocommerce-products-header__title",
    ".category-title, .archive-title, .product-category-title",
    "h1, .page-header h1, .entry-title",
    ".woocommerce-products-header h1",
  ];

  for (const selector of categoryNameSelectors) {
    const nameEl = $(selector).first();
    if (nameEl.length > 0 && nameEl.text().trim()) {
      category.name = nameEl.text().trim();
      break;
    }
  }

  // Opis kategorii - rozszerzone selektory dla WooCommerce/Tabou
  const categoryDescSelectors = [
    ".woocommerce-products-header .term-description",
    ".category-description, .archive-description",
    ".product-category-description, .category-intro",
    ".taxonomy-description, .term-description",
  ];

  for (const selector of categoryDescSelectors) {
    const descEl = $(selector).first();
    if (descEl.length > 0 && descEl.text().trim()) {
      category.description = descEl.text().trim();
      break;
    }
  }

  // Produkty w kategorii - dostosowane do struktury Tabou.pl (zoptymalizowane na podstawie analizy HTML)
  const productSelectors = [
    ".woocommerce-LoopProduct-link", // Główny selektor Tabou.pl (48 elementów w MTB)
    'a[href*="/produkt/"]', // Linki prowadzące do produktów
    ".products .product a", // typowy WooCommerce
    ".product-list a",
    ".product-grid a",
    ".product-item a",
  ];

  let foundProducts = 0;
  let foundProductLinks = new Set();

  productSelectors.forEach((selector) => {
    $(selector).each((i, el) => {
      const $el = $(el);
      const productLink = $el.attr("href");
      let productName = $el.attr("title") || $el.text().trim();
      if (!productName) {
        productName = $el
          .closest("div")
          .find("*")
          .filter(function () {
            return (
              $(this).text().toLowerCase().includes("rower") ||
              $(this).text().toLowerCase().includes("tabou")
            );
          })
          .first()
          .text()
          .trim();
      }
      let productPrice = "";
      const nearbyText = $el.closest("div").text();
      const priceMatch = nearbyText.match(/(\d{3,})\s*zł/);
      if (priceMatch) {
        productPrice = priceMatch[0];
      }
      if (productLink && productName) {
        const normalizedLink = normalizeUrl(productLink, url);
        if (normalizedLink) {
          foundProductLinks.add(normalizedLink);
          if (!category.products.some((p) => p.url === normalizedLink)) {
            category.products.push({
              name: productName,
              price: productPrice,
              url: normalizedLink,
            });
            foundProducts++;
          }
        }
      }
    });
  });
  console.log(
    `🟢 [KATEGORIA] ${url} | Nazwa: ${
      category.name
    } | Opis: ${category.description?.slice(0, 60)}... | Liczba produktów: ${
      category.products.length
    } | Unikalnych linków: ${foundProductLinks.size}`
  );
  if (category.products.length === 0) {
    console.warn(`⚠️  [KATEGORIA] Brak produktów w: ${url}`);
  }

  return category;
}

// Funkcja parsowania FAQ
function parseFaqData($, url) {
  const faq = {
    url,
    type: "faq",
    questions: [],
  };

  // Różne struktury FAQ
  $(".faq-item, .accordion-item, .qa-item").each((i, el) => {
    const question = $(el)
      .find(".question, .faq-question, h3, h4")
      .text()
      .trim();
    const answer = $(el).find(".answer, .faq-answer, .content").text().trim();

    if (question && answer) {
      faq.questions.push({ question, answer });
    }
  });

  // Alternatywna struktura
  if (faq.questions.length === 0) {
    $("dt").each((i, el) => {
      const question = $(el).text().trim();
      const answer = $(el).next("dd").text().trim();
      if (question && answer) {
        faq.questions.push({ question, answer });
      }
    });
  }

  return faq;
}

// Funkcja parsowania ogólnej strony informacyjnej
function parseGeneralPageData($, url) {
  const page = {
    url,
    type: detectPageType(url, $),
    title: "",
    content: "",
    headings: [],
    links: [],
  };

  // Tytuł strony
  page.title = $("h1, .page-title, title").first().text().trim();

  // Zawartość strony
  const contentSelectors = [
    ".content, .main-content, .page-content",
    ".entry-content, .post-content",
    "main, article",
  ];

  for (const selector of contentSelectors) {
    const contentEl = $(selector).first();
    if (contentEl.length > 0) {
      page.content = contentEl.text().trim();
      break;
    }
  }

  // Jeśli nie znaleziono głównej zawartości, zbierz wszystkie akapity
  if (!page.content) {
    page.content = $("p")
      .map((i, el) => $(el).text().trim())
      .get()
      .join(" ");
  }

  // Nagłówki
  $("h1, h2, h3, h4, h5, h6").each((i, el) => {
    const text = $(el).text().trim();
    if (text) {
      page.headings.push({
        level: parseInt(el.tagName.charAt(1)),
        text,
      });
    }
  });

  return page;
}

// Funkcja odkrywania linków na stronie
function discoverLinks($, currentUrl) {
  const links = new Set();
  const discoveredInThisPage = new Set(); // Lokalna deduplicacja dla tej strony

  // Standardowe linki
  $("a[href]").each((i, el) => {
    const href = $(el).attr("href");
    if (href) {
      const normalizedUrl = normalizeUrl(href, currentUrl);
      if (
        normalizedUrl &&
        isUrlAllowed(normalizedUrl, CRAWLER_CONFIG) &&
        isUrlRelevant(normalizedUrl) &&
        !discoveredInThisPage.has(normalizedUrl) &&
        !visitedUrls.has(normalizedUrl)
      ) {
        links.add(normalizedUrl);
        discoveredInThisPage.add(normalizedUrl);

        // Dodaj do globalnych zbiorów
        if (normalizedUrl.includes("/produkt/")) {
          discoveredProductUrls.add(normalizedUrl);
        } else if (
          normalizedUrl.includes("/rowery/") ||
          normalizedUrl.includes("/kategoria/")
        ) {
          discoveredCategoryUrls.add(normalizedUrl);
        }
      }
    }
  });

  // Dodaj linki do paginacji (np. ?paged=2, /page/2, itp.) - tylko jeśli są unikalne
  $("a[href]").each((i, el) => {
    const href = $(el).attr("href");
    if (href && (/page\/(\d+)/i.test(href) || /[&?]paged?=\d+/i.test(href))) {
      const normalizedUrl = normalizeUrl(href, currentUrl);
      if (
        normalizedUrl &&
        isUrlAllowed(normalizedUrl, CRAWLER_CONFIG) &&
        isUrlRelevant(normalizedUrl) &&
        !discoveredInThisPage.has(normalizedUrl) &&
        !visitedUrls.has(normalizedUrl)
      ) {
        links.add(normalizedUrl);
        discoveredInThisPage.add(normalizedUrl);
        discoveredCategoryUrls.add(normalizedUrl);
      }
    }
  });
  // Dodatkowe logi diagnostyczne
  if (links.size === 0) {
    console.warn(
      `[discoverLinks] Brak nowych linków na stronie: ${currentUrl}`
    );
  } else {
    console.log(
      `[discoverLinks] ${currentUrl} -> znaleziono ${links.size} linków`
    );
  }

  return Array.from(links);
}

// Główna funkcja scrapowania pojedynczej strony
async function scrapePage(url, depth = 0) {
  if (
    visitedUrls.has(url) ||
    depth > CRAWLER_CONFIG.maxDepth ||
    scrapedData.length >= CRAWLER_CONFIG.maxPages
  ) {
    return;
  }

  visitedUrls.add(url);
  console.log(`🔹 Scraping: ${url} (depth: ${depth})`);

  try {
    await sleep(CRAWLER_CONFIG.delay, 500);
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    // Wykryj typ strony i parsuj odpowiednio
    const pageType = detectPageType(url, $);
    let pageData;

    switch (pageType) {
      case "product":
        pageData = parseProductData($, url);
        break;
      case "category":
        pageData = parseCategoryData($, url);
        break;
      case "faq":
        pageData = parseFaqData($, url);
        break;
      default:
        pageData = parseGeneralPageData($, url);
        break;
    }

    // Dodaj metadane
    pageData.scrapedAt = new Date().toISOString();
    pageData.depth = depth;

    scrapedData.push(pageData);

    // Odkryj nowe linki i dodaj do kolejki
    const newLinks = discoverLinks($, url);

    // Dla kategorii, dodaj także linki produktów do kolejki
    if (pageType === "category" && pageData.products) {
      for (const product of pageData.products) {
        if (
          product.url &&
          !visitedUrls.has(product.url) &&
          depth < CRAWLER_CONFIG.maxDepth
        ) {
          newLinks.push(product.url);
        }
      }
    }

    for (const link of newLinks) {
      if (!visitedUrls.has(link) && depth < CRAWLER_CONFIG.maxDepth) {
        urlQueue.push({ url: link, depth: depth + 1 });
      }
    }

    console.log(
      `✔ Scraped ${url} (type: ${pageType}, found ${newLinks.length} links)`
    );
  } catch (err) {
    console.error(`❌ Error scraping ${url}:`, err.message);
  }
}

// Funkcja przekształcania danych na chunki tekstowe
function prepareTextChunks() {
  const chunks = [];
  const seenHashes = new Set(); // Lokalna deduplicacja w tej funkcji

  for (const pageData of scrapedData) {
    let textContent = "";
    let metadata = {
      url: pageData.url,
      type: pageData.type,
      title: pageData.title || pageData.name || "",
      depth: pageData.depth,
    };

    switch (pageData.type) {
      case "product":
        textContent = `Produkt: ${pageData.name}
Cena: ${pageData.price}
Dostępność: ${pageData.availability}
Opis: ${pageData.description}
Specyfikacje: ${Object.entries(pageData.specifications)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")}
SKU: ${pageData.sku}`;

        // Dodaj informacje o kolorach jeśli dostępne
        if (pageData.colors && pageData.colors.length > 0) {
          textContent += `\nKolory: ${pageData.colors.join(", ")}`;
        }

        // Dodaj informacje o rozmiarach jeśli dostępne
        if (pageData.frameSize) {
          textContent += `\nRozmiar ramy: ${pageData.frameSize}`;
        }
        if (pageData.wheelSize) {
          textContent += `\nRozmiar kół: ${pageData.wheelSize}`;
        }
        if (
          pageData.availableFrameSizes &&
          pageData.availableFrameSizes.length > 0
        ) {
          textContent += `\nDostępne rozmiary: ${pageData.availableFrameSizes.join(
            ", "
          )}`;
        }

        // Dodaj informacje o typie roweru jeśli dostępne
        if (pageData.bikeType) {
          textContent += `\nTyp roweru: ${pageData.bikeType}`;
        }

        // Dodaj informacje o kolekcji jeśli dostępne
        if (pageData.collection) {
          textContent += `\nKolekcja: ${pageData.collection}`;
        }

        metadata.price = pageData.price;
        metadata.availability = pageData.availability;

        // Dodaj dodatkowe metadane do porównań
        if (pageData.colors) metadata.colors = pageData.colors;
        if (pageData.currentColor)
          metadata.currentColor = pageData.currentColor;
        if (pageData.frameSize) metadata.frameSize = pageData.frameSize;
        if (pageData.wheelSize) metadata.wheelSize = pageData.wheelSize;
        if (pageData.availableFrameSizes)
          metadata.availableFrameSizes = pageData.availableFrameSizes;
        if (pageData.bikeType) metadata.bikeType = pageData.bikeType;
        if (pageData.collection) metadata.collection = pageData.collection;
        if (pageData.specifications)
          metadata.specifications = pageData.specifications;
        if (pageData.sku) metadata.sku = pageData.sku;

        break;

      case "faq":
        textContent = pageData.questions
          .map((q) => `Q: ${q.question}\nA: ${q.answer}`)
          .join("\n\n");
        break;

      case "category":
        textContent = `Kategoria: ${pageData.name}
Opis: ${pageData.description}
Produkty: ${pageData.products.map((p) => `${p.name} - ${p.price}`).join(", ")}`;
        break;

      default:
        textContent = `${pageData.title}\n${pageData.content}`;
        if (pageData.headings) {
          textContent += "\n" + pageData.headings.map((h) => h.text).join("\n");
        }
        break;
    }

    // Sprawdź czy content nie jest duplikatem
    const contentHash = hashContent(textContent);
    if (processedEmbeddings.has(contentHash)) {
      console.log(`⏭️ Pomijam duplikat contentu z: ${pageData.url}`);
      continue;
    }
    processedEmbeddings.add(contentHash);

    // Dziel na chunki po 1000 znaków - tylko unikalne
    for (let i = 0; i < textContent.length; i += 1000) {
      const chunkText = textContent.slice(i, i + 1000);
      const chunkHash = hashContent(chunkText);

      if (!seenHashes.has(chunkHash)) {
        seenHashes.add(chunkHash);
        chunks.push({
          text: chunkText,
          metadata: { ...metadata, chunkIndex: Math.floor(i / 1000) },
        });
      }
    }
  }

  console.log(
    `✅ Przygotowano ${chunks.length} unikalnych chunków z ${scrapedData.length} stron`
  );
  return chunks;
}

// Funkcja do hashowania contentu dla deduplicacji
function hashContent(text) {
  let hash = 0;
  if (text.length === 0) return hash;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Konwersja na 32-bit integer
  }
  return hash.toString();
}

async function checkEmbeddingModelAccess(model = "text-embedding-3-small") {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { input: "testowy tekst", model },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    if (resp.data && resp.data.data && resp.data.data[0].embedding) {
      console.log(`✔ Model ${model} jest dostępny dla Twojego klucza API.`);
      return true;
    }
    console.warn(`⚠️ Odpowiedź nie zawiera embeddingu dla modelu ${model}.`);
    return false;
  } catch (err) {
    if (err.response) {
      console.error(
        `❌ Błąd dostępu do modelu ${model}:`,
        err.response.status,
        err.response.data
      );
    } else {
      console.error(
        `❌ Błąd połączenia z API dla modelu ${model}:`,
        err.message
      );
    }
    return false;
  }
}

// Funkcja sleep z opcjonalnym jitterem
function sleep(ms, jitter = 0) {
  const delay = ms + Math.floor(Math.random() * jitter);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Funkcja tworzenia embeddingu z retry
async function getEmbedding(text, retries = 10) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { input: text, model: "text-embedding-3-small" },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.data[0].embedding;
  } catch (err) {
    if (err.response && err.response.status === 429 && retries > 0) {
      console.warn("⚠️ 429 Too Many Requests, retrying in 2-4s...");
      await sleep(2000, 2000); // 2-4 sekundy
      return getEmbedding(text, retries - 1);
    }
    console.error("❌ Błąd podczas tworzenia embeddingu:", err.message);
    return null;
  }
}

// Główna funkcja crawlingu z kontrolą etapową
async function crawl(startUrl = CRAWLER_CONFIG.baseUrl) {
  console.log("� INTERAKTYWNY CRAWLER TABOU.PL");
  console.log(
    "Crawler będzie działał etapami z możliwością kontroli przez użytkownika.\n"
  );

  // ETAP 1: Sprawdzenie dostępności API
  console.log("�🔍 ETAP 1: Sprawdzanie dostępności modeli embeddingów...");
  const isSmallModelAvailable = await checkEmbeddingModelAccess(
    "text-embedding-3-small"
  );
  const isAdaModelAvailable = await checkEmbeddingModelAccess(
    "text-embedding-ada-002"
  );

  if (!isSmallModelAvailable && !isAdaModelAvailable) {
    console.error(
      "❌ Żaden z modeli embeddingów nie jest dostępny. Sprawdź swój klucz API."
    );
    return;
  }

  // Pętla menu głównego
  let startScraping = false;
  let skipToChunks = false; // Flaga dla przejścia bezpośrednio do chunków
  while (!startScraping) {
    const choice1 = await promptUser(
      "✅ API OpenAI działa poprawnie. Czy chcesz rozpocząć scraping?",
      [
        "Tak, rozpocznij scraping stron",
        "Pokaż konfigurację crawlera",
        "Zmień konfigurację (maxPages/maxDepth)",
        "Rozpocznij embedding z zapisanego pliku scraped_data",
      ]
    );

    if (choice1 === "0") {
      console.log("👋 Crawler przerwany przez użytkownika.");
      return;
    }

    if (choice1 === "1") {
      startScraping = true;
      break;
    }

    if (choice1 === "2") {
      console.log(`\n� AKTUALNA KONFIGURACJA:`);
      console.log(`   • Maksymalna głębokość: ${CRAWLER_CONFIG.maxDepth}`);
      console.log(`   • Maksymalne strony: ${CRAWLER_CONFIG.maxPages}`);
      console.log(`   • Opóźnienie: ${CRAWLER_CONFIG.delay}ms`);
      console.log(
        `   • Dozwolone ścieżki: ${CRAWLER_CONFIG.allowedPaths.length} typów`
      );
      console.log(
        `   • Wykluczone ścieżki: ${CRAWLER_CONFIG.excludePaths.length} typów`
      );
      console.log(`   • URL startowy: ${CRAWLER_CONFIG.baseUrl}`);

      // Pokaż przykłady dozwolonych ścieżek
      console.log(`\n📁 Przykłady dozwolonych ścieżek:`);
      CRAWLER_CONFIG.allowedPaths.slice(0, 10).forEach((path) => {
        console.log(`   - ${path}`);
      });
      if (CRAWLER_CONFIG.allowedPaths.length > 10) {
        console.log(
          `   ... i ${CRAWLER_CONFIG.allowedPaths.length - 10} więcej`
        );
      }

      // Pokaż przykłady wykluczonych ścieżek
      console.log(`\n🚫 Przykłady wykluczonych ścieżek:`);
      CRAWLER_CONFIG.excludePaths.slice(0, 8).forEach((path) => {
        console.log(`   - ${path}`);
      });
      if (CRAWLER_CONFIG.excludePaths.length > 8) {
        console.log(
          `   ... i ${CRAWLER_CONFIG.excludePaths.length - 8} więcej`
        );
      }
      continue; // Wróć do menu
    }

    if (choice1 === "3") {
      const newMaxPages = await promptUser(
        "Podaj nową wartość maxPages (obecnie " + CRAWLER_CONFIG.maxPages + "):"
      );
      const newMaxDepth = await promptUser(
        "Podaj nową wartość maxDepth (obecnie " + CRAWLER_CONFIG.maxDepth + "):"
      );

      if (!isNaN(newMaxPages) && parseInt(newMaxPages) > 0) {
        CRAWLER_CONFIG.maxPages = parseInt(newMaxPages);
      }
      if (!isNaN(newMaxDepth) && parseInt(newMaxDepth) > 0) {
        CRAWLER_CONFIG.maxDepth = parseInt(newMaxDepth);
      }
      console.log(
        `✅ Konfiguracja zaktualizowana: maxPages=${CRAWLER_CONFIG.maxPages}, maxDepth=${CRAWLER_CONFIG.maxDepth}`
      );
      continue; // Wróć do menu
    }

    if (choice1 === "4") {
      // Wczytaj zapisane dane i rozpocznij embedding
      try {
        if (!fs.existsSync("data/scraped_data.json")) {
          console.log(
            "❌ Plik data/scraped_data.json nie istnieje. Najpierw wykonaj scraping."
          );
          continue;
        }

        const savedData = JSON.parse(
          fs.readFileSync("data/scraped_data.json", "utf8")
        );
        console.log(
          `📁 Wczytano ${savedData.length} zapisanych stron z data/scraped_data.json`
        );

        // Zastąp bieżące dane zapisanymi danymi
        scrapedData.length = 0; // Wyczyść tablicę
        scrapedData.push(...savedData); // Dodaj zapisane dane

        console.log(
          "✅ Dane zostały wczytane. Przechodzę do etapu przygotowania chunków..."
        );
        startScraping = true; // Ustaw flagę aby wyjść z pętli
        skipToChunks = true; // Ustaw flagę aby ominąć scraping
        break;
      } catch (err) {
        console.error(
          "❌ Błąd wczytywania pliku scraped_data.json:",
          err.message
        );
        continue;
      }
    }
  } // Koniec pętli while (!startScraping)

  // ETAP 2: Scraping stron (omiń jeśli wczytano dane z pliku)
  if (!skipToChunks) {
    console.log("\n🔍 ETAP 2: Rozpoczynanie scrapingu stron...");
    console.log(
      `📊 Konfiguracja: maxDepth=${CRAWLER_CONFIG.maxDepth}, maxPages=${CRAWLER_CONFIG.maxPages}`
    );

    // Wyczyść poprzednie dane
    visitedUrls.clear();
    urlQueue.length = 0;
    scrapedData.length = 0;
    discoveredProductUrls.clear();
    discoveredCategoryUrls.clear();
    processedEmbeddings.clear();
    globalProductLinks.clear();

    // Dodaj startowe URL-e
    const startUrls = [
      "https://www.tabou.pl",
      "https://www.tabou.pl/rowery/",
      "https://www.tabou.pl/sklepy/",
      "https://www.tabou.pl/rowery/e-ebike/",
      "https://www.tabou.pl/rowery/gravel/",
      "https://www.tabou.pl/rowery/mtb/",
      "https://www.tabou.pl/rowery/cross/",
      "https://www.tabou.pl/rowery/trekking/",
      "https://www.tabou.pl/rowery/mtb-trail/",
      "https://www.tabou.pl/rowery/folding/",
      "https://www.tabou.pl/rowery/miejskie/",
      "https://www.tabou.pl/rowery/mlodziezowe/",
      "https://www.tabou.pl/rowery/dla-dzieci/",
      "https://www.tabou.pl/rowery/dirt/",
      "https://www.tabou.pl/rowery/bmx/",
      "https://www.tabou.pl/o-nas/",
      "https://www.tabou.pl/kontakt/",
      "https://www.tabou.pl/czeste-pytania-faq/",
      "https://www.tabou.pl/zwroty/",
      "https://www.tabou.pl/regulamin/",
      "https://www.tabou.pl/polityka-prywatnosci/",
      "https://www.tabou.pl/gwarancja/",
      "https://www.tabou.pl/formy-platnosci/",
      "https://www.tabou.pl/pliki-do-pobrania/",
      "https://www.tabou.pl/regulamin-cashback/",
      "https://www.tabou.pl/reklamacje/",
      "https://www.tabou.pl/jak-kupowac/",
      "https://www.tabou.pl/zakupy-na-raty/",
    ];

    for (const url of startUrls) {
      urlQueue.push({ url, depth: 0 });
    }

    // Przetwarzaj kolejkę URL-i z okresowym raportowaniem
    let lastReport = 0;
    const reportInterval = 100; // Co ile stron pokazywać postęp

    while (
      urlQueue.length > 0 &&
      scrapedData.length < CRAWLER_CONFIG.maxPages
    ) {
      const { url, depth } = urlQueue.shift();
      if (!isUrlAllowed(url, CRAWLER_CONFIG)) {
        console.log(`⏭️  Pomijam niedozwolony URL: ${url}`);
        continue;
      }

      await scrapePage(url, depth);

      // Pokaż postęp co N stron
      if (scrapedData.length - lastReport >= reportInterval) {
        lastReport = scrapedData.length;
        console.log(
          `📈 Postęp: ${scrapedData.length}/${CRAWLER_CONFIG.maxPages} stron, ${urlQueue.length} w kolejce`
        );

        // if (scrapedData.length >= 50) {
        //   // Opcja przerwania po 50 stronach
        //   const continueChoice = await promptUser(
        //     `Zescrapowano już ${scrapedData.length} stron. Czy kontynuować?`,
        //     [
        //       "Tak, kontynuuj scraping",
        //       "Pokaż statystyki i kontynuuj",
        //       "Przejdź do następnego etapu (chunki)",
        //     ]
        //   );

        //   if (continueChoice === "0") {
        //     console.log("👋 Scraping przerwany przez użytkownika.");
        //     return;
        //   }

        //   if (continueChoice === "2") {
        //     showStageStats("scraping");
        //   }

        //   if (continueChoice === "3") {
        //     console.log("⏭️ Przechodzę do etapu przygotowania chunków...");
        //     break;
        //   }
        // }
      }
    }

    console.log(`✔ Zakończono scraping. Zebrano ${scrapedData.length} stron.`);

    // Zapisz surowe dane po zakończeniu scrapingu
    try {
      fs.writeFileSync(
        "data/scraped_data.json",
        JSON.stringify(scrapedData, null, 2)
      );
      console.log(`💾 Zapisano surowe dane do data/scraped_data.json`);
    } catch (err) {
      console.error("❌ Błąd zapisu surowych danych:", err.message);
    }

    showStageStats("scraping");
  } // Koniec sekcji scrapingu

  // ETAP 3: Przygotowanie chunków
  const choice3 = await promptUser(
    "🔄 ETAP 3: Czy przejść do przygotowania chunków tekstowych?",
    [
      "Tak, przygotuj chunki",
      "Pokaż listę wszystkich odwiedzonych stron",
      "Zapisz tylko surowe dane (bez chunków)",
    ]
  );

  if (choice3 === "0") {
    console.log("👋 Crawler przerwany przed etapem chunków.");
    return await saveFinalResults([], []);
  }

  if (choice3 === "2") {
    console.log("\n===== LISTA ODWIEDZONYCH PODSTRON =====");
    let idx = 1;
    for (const url of visitedUrls) {
      console.log(`${idx++}. ${url}`);
    }
    console.log("===== KONIEC LISTY =====\n");
  }

  if (choice3 === "3") {
    console.log("� Zapisuję tylko surowe dane...");
    return await saveFinalResults([], []);
  }

  console.log("🔄 Przygotowywanie chunków tekstowych...");
  const chunks = prepareTextChunks();
  console.log(`📝 Przygotowano ${chunks.length} chunków tekstu.`);
  showStageStats("chunks", chunks);

  // ETAP 4: Embeddingi
  const choice4 = await promptUser(
    "🤖 ETAP 4: Czy przejść do tworzenia embeddingów?",
    [
      "Tak, utwórz embeddingi dla wszystkich chunków",
      "Utwórz embeddingi tylko dla pierwszych 50 chunków (test)",
      "Pomiń embeddingi, zapisz tylko chunki",
    ]
  );

  if (choice4 === "0") {
    console.log("👋 Crawler przerwany przed etapem embeddingów.");
    return await saveFinalResults(chunks, []);
  }

  if (choice4 === "3") {
    console.log("💾 Zapisuję dane bez embeddingów...");
    return await saveFinalResults(chunks, []);
  }

  // Tworzenie embeddingów
  console.log("🤖 Tworzenie embeddingów...");
  const docs = [];
  const maxChunks =
    choice4 === "2" ? Math.min(50, chunks.length) : chunks.length;

  for (let i = 0; i < maxChunks; i++) {
    const chunk = chunks[i];
    console.log(
      `🔹 Embedding ${i + 1}/${maxChunks} - ${chunk.metadata.type}: ${
        chunk.metadata.title
      }`
    );

    const embedding = await getEmbedding(chunk.text);
    if (embedding) {
      docs.push({
        text: chunk.text,
        embedding,
        metadata: chunk.metadata,
      });
    }

    // Throttling między requestami
    await sleep(500, 1000);

    // Co 10 embeddingów pytaj czy kontynuować
    if ((i + 1) % 3000 === 0 && i + 1 < maxChunks) {
      const continueEmbed = await promptUser(
        `Utworzono ${i + 1}/${maxChunks} embeddingów. Czy kontynuować?`,
        ["Tak, kontynuuj", "Zapisz obecne wyniki i zakończ"]
      );

      if (continueEmbed === "0" || continueEmbed === "2") {
        console.log("💾 Zapisuję obecne wyniki...");
        break;
      }
    }
  }

  if (docs.length === 0) {
    console.error("❌ Nie udało się wygenerować embeddingów.");
    return await saveFinalResults(chunks, []);
  }

  showStageStats("embeddings", docs);

  // ETAP 5: Zapis wyników
  return await saveFinalResults(chunks, docs);
}

// Funkcja zapisu wyników
async function saveFinalResults(chunks, docs) {
  const choice5 = await promptUser("💾 ETAP 5: Zapisać wyniki?", [
    "Tak, zapisz wszystkie pliki",
    "Zapisz tylko embeddingi",
    "Zapisz tylko surowe dane",
  ]);

  if (choice5 === "0") {
    console.log("👋 Zapis przerwany przez użytkownika.");
    return;
  }

  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data");

    if (choice5 === "1" || choice5 === "2") {
      // Zapisz embeddingi - dzielimy na mniejsze pliki jeśli za duże
      if (docs.length > 0) {
        try {
          // Próba zapisu całego pliku
          const docsJson = JSON.stringify(docs, null, 2);
          fs.writeFileSync("data/tabou.json", docsJson);
          console.log(
            `✔ Zapisano ${docs.length} embeddingów do data/tabou.json`
          );
        } catch (error) {
          console.log("⚠ Plik zbyt duży, dzielę na części...");
          // Podział na części po 500 embeddingów (zmniejszone z 1000)
          const chunkSize = 500;
          let partNumber = 1;
          for (let i = 0; i < docs.length; i += chunkSize) {
            const chunk = docs.slice(i, i + chunkSize);
            const filename = `data/tabou_part${partNumber}.json`;
            fs.writeFileSync(filename, JSON.stringify(chunk, null, 2));
            console.log(
              `✔ Zapisano część ${partNumber} (${chunk.length} embeddingów) do ${filename}`
            );
            partNumber++;
          }
        }
      }
    }

    if (choice5 === "1" || choice5 === "3") {
      // Zapisz surowe dane - także z podziałem jeśli potrzeba
      try {
        const scrapedJson = JSON.stringify(scrapedData, null, 2);
        fs.writeFileSync("data/scraped_data.json", scrapedJson);
        console.log(
          `✔ Zapisano ${scrapedData.length} stron surowych danych do data/scraped_data.json`
        );
      } catch (error) {
        console.log("⚠ Dane surowe zbyt duże, dzielę na części...");
        const chunkSize = 100; // Mniejsze chunki dla surowych danych
        let partNumber = 1;
        for (let i = 0; i < scrapedData.length; i += chunkSize) {
          const chunk = scrapedData.slice(i, i + chunkSize);
          const filename = `data/scraped_data_part${partNumber}.json`;
          fs.writeFileSync(filename, JSON.stringify(chunk, null, 2));
          console.log(
            `✔ Zapisano część ${partNumber} (${chunk.length} stron) do ${filename}`
          );
          partNumber++;
        }
      }
    }

    // Zawsze zapisz statystyki
    const stats = {
      totalPages: scrapedData.length,
      totalChunks: chunks.length,
      totalEmbeddings: docs.length,
      pageTypes: scrapedData.reduce((acc, page) => {
        acc[page.type] = (acc[page.type] || 0) + 1;
        return acc;
      }, {}),
      scrapedAt: new Date().toISOString(),
      deduplicationStats: {
        discoveredProductUrls: discoveredProductUrls.size,
        discoveredCategoryUrls: discoveredCategoryUrls.size,
        processedEmbeddings: processedEmbeddings.size,
        globalProductLinks: globalProductLinks.size,
        visitedUrls: visitedUrls.size,
      },
    };

    fs.writeFileSync("data/crawl_stats.json", JSON.stringify(stats, null, 2));
    console.log("📊 Statystyki zapisane do data/crawl_stats.json");

    console.log("\n🎉 CRAWLER ZAKOŃCZONY POMYŚLNIE!");
    console.log(`� FINALNE STATYSTYKI:`);
    console.log(`   • Strony: ${stats.totalPages}`);
    console.log(`   • Chunki: ${stats.totalChunks}`);
    console.log(`   • Embeddingi: ${stats.totalEmbeddings}`);
    console.log(`   • Produkty: ${stats.pageTypes.product || 0}`);
    console.log(`   • Kategorie: ${stats.pageTypes.category || 0}`);
  } catch (err) {
    console.error("❌ Błąd zapisu plików:", err.message);
  }
}

// Uruchomienie crawlera
crawl("https://www.tabou.pl");
