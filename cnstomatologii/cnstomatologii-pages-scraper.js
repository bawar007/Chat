import axios from "axios";
import * as cheerio from "cheerio";
import http from "http";
import https from "https";
import fs from "fs";
import { scrapeDynamicCalendar } from "./cnstomatologii-dynamic-scraper.js";

// HTTP GET z retry i timeoutem
async function httpGetWithRetry(url, timeout = 20000, retries = 2) {
  const agents = {
    http: new http.Agent({ keepAlive: true, timeout }),
    https: new https.Agent({ keepAlive: true, timeout }),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout,
        httpAgent: agents.http,
        httpsAgent: agents.https,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl,en;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          Connection: "keep-alive",
        },
      });
      return response.data;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(
          `HTTP error after ${retries + 1} attempts: ${error.message}`
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000)
      );
    }
  }
}

// Czyszczenie i normalizacja tekstu
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8222;/g, "„")
    .replace(/&#8221;/g, '"')
    .replace(/zł(\s|$)/g, "zł\n$1") // Dodaj nową linię po "zł" tylko gdy następuje spacja lub koniec tekstu
    .trim();
}

// Wyciąganie informacji o kalendarzu z dostępnymi terminami
function extractCalendarInfo($, doctorName) {
  const calendarData = {
    availableSlots: [],
    nextAvailableDate: null,
    hasCalendar: false,
    bookingInfo: null,
    dynamicCalendar: false,
  };

  try {
    // Szukaj dostępnych slotów w kalendarzu
    const availableSlots = $('button[title="calendar_slot_available"]');
    if (availableSlots.length > 0) {
      calendarData.hasCalendar = true;
      availableSlots.each((i, el) => {
        const $slot = $(el);
        const timeText = cleanText($slot.text());
        const ariaLabel = $slot.attr("aria-label") || "";

        if (timeText && ariaLabel) {
          calendarData.availableSlots.push({
            time: timeText,
            fullLabel: ariaLabel,
          });
        }
      });
    }

    // Szukaj informacji o najbliższym wolnym terminie (różne selektory)
    const nextFreeSelectors = [
      ".dp-calendar-state-message strong",
      ".next-available strong",
      ".calendar-next-date strong",
      "p strong",
      "span strong",
    ];

    for (const selector of nextFreeSelectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        const dateText = cleanText(elements.first().text());
        // Sprawdź czy tekst wygląda jak data (zawiera miesiąc lub cyfry)
        if (
          dateText &&
          (dateText.includes("Paź") ||
            dateText.includes("Lis") ||
            dateText.includes("Gru") ||
            dateText.includes("Sty") ||
            dateText.includes("Lut") ||
            dateText.includes("Mar") ||
            dateText.includes("Kwi") ||
            dateText.includes("Maj") ||
            dateText.includes("Cze") ||
            dateText.includes("Lip") ||
            dateText.includes("Sie") ||
            dateText.includes("Wrz") ||
            /\d{1,2}:\d{2}/.test(dateText))
        ) {
          calendarData.hasCalendar = true;
          calendarData.nextAvailableDate = dateText;
          break;
        }
      }
    }

    // Sprawdź zawartość tekstową strony pod kątem informacji o terminach
    const bodyText = $("body").text();
    const datePatterns = [
      /kolejny\s+wolny\s+termin[:\s]*([^\.]+)/i,
      /następny\s+wolny\s+termin[:\s]*([^\.]+)/i,
      /wolny\s+termin[:\s]*([^\.]+)/i,
      /(\d{1,2}\s+\w+,\s+\d{1,2}:\d{2})/i,
    ];

    for (const pattern of datePatterns) {
      const match = bodyText.match(pattern);
      if (match && match[1]) {
        calendarData.hasCalendar = true;
        calendarData.nextAvailableDate = cleanText(match[1]);
        break;
      }
    }

    // Szukaj ogólnych linków i przycisków związanych z rezerwacją
    const bookingSelectors = [
      'a[href*="znanylekarz"]',
      ".booking-button",
      ".appointment-button",
    ];

    for (const selector of bookingSelectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        calendarData.hasCalendar = true;
        const linkText = cleanText(elements.first().text());
        const linkHref = elements.first().attr("href");

        if (linkText || linkHref) {
          calendarData.bookingInfo = {
            text: linkText || "Umów wizytę",
            link: linkHref || null,
            type: "booking_link",
          };
          break;
        }
      }
    }

    // Szukaj tekstów wskazujących na możliwość rezerwacji
    const bookingKeywords = [
      "umów się na wizytę",
      "rezerwacja online",
      "umów wizytę",
    ];

    for (const keyword of bookingKeywords) {
      if (bodyText.toLowerCase().includes(keyword)) {
        calendarData.hasCalendar = true;
        if (!calendarData.bookingInfo) {
          calendarData.bookingInfo = {
            text: "Możliwość umówienia wizyty",
            link: null,
            type: "general_booking",
          };
        }
        break;
      }
    }

    // Jeśli znaleziono linki do znanylekarz.pl, oznacz jako system rezerwacji
    if ($('a[href*="znanylekarz"]').length > 0) {
      calendarData.hasCalendar = true;
      calendarData.dynamicCalendar = true; // Przypuszczenie, że kalendarz może być dynamiczny
      if (!calendarData.bookingInfo) {
        calendarData.bookingInfo = {
          text: "Rezerwacja online przez ZnanyLekarz.pl",
          link: $('a[href*="znanylekarz"]').first().attr("href"),
          type: "external_booking",
        };
      }
    }
  } catch (error) {
    console.warn(
      `⚠️ Błąd podczas scrapowania kalendarza dla ${doctorName}:`,
      error.message
    );
  }

  return calendarData.hasCalendar ? calendarData : null;
}

// Główna funkcja scrapowania strony
export async function scrapePage(url, timeout = 20000) {
  try {
    const html = await httpGetWithRetry(url, timeout);
    const $ = cheerio.load(html);

    // Usuń niepotrzebne elementy
    $(
      "script, style, nav, header, footer, .menu, .navigation, .breadcrumb, iframe"
    ).remove();
    $(".sticky-menu, .phone_bot_w, .arrow-opinion, .slick-dots").remove();

    // Podstawowe metadane
    const title = cleanText($("title").text() || $("h1").first().text());
    const metaDescription = cleanText(
      $('meta[name="description"]').attr("content") || ""
    );

    // Główna treść strony
    let content = "";
    let contentType = "general";

    // Określenie typu strony na podstawie URL
    if (url.includes("/oferta/")) {
      contentType = "service";
      // Dla stron oferty - wybieramy główną treść
      const mainContent = $("main, .main-content, article, .content").first();
      if (mainContent.length) {
        content = cleanText(mainContent.text());
      } else {
        // Fallback - cała treść body minus elementy nawigacyjne
        content = cleanText($("body").text());
      }
    } else if (url.includes("/o-nas/")) {
      contentType = "doctor";
      // Dla stron lekarzy - informacje o personelu
      const doctorInfo = $(
        ".doctor-info, .team-member, .staff-info, main, article"
      ).first();
      if (doctorInfo.length) {
        content = cleanText(doctorInfo.text());
      } else {
        content = cleanText($("body").text());
      }
    } else if (url.includes("/cennik/")) {
      contentType = "pricing";
      // Dla cennika - wszystkie informacje o cenach
      content = cleanText($("body").text());
    } else if (url.includes("/kontakt/")) {
      contentType = "contact";
      // Dla kontaktu - dane kontaktowe
      content = cleanText($("body").text());
    } else if (url.includes("/metamorfozy/")) {
      contentType = "portfolio";
      // Dla metamorfoz - opisy przypadków
      content = cleanText($("body").text());
    } else {
      // Strona główna lub inne
      contentType = "general";
      content = cleanText($("body").text());
    }

    // Wyciągnij nagłówki dla lepszej struktury
    const headings = [];
    $("h1, h2, h3, h4, h5, h6").each((_, el) => {
      const heading = cleanText($(el).text());
      if (heading && heading.length > 2) {
        headings.push({
          level: el.tagName.toLowerCase(),
          text: heading,
        });
      }
    });

    // Wyciągnij informacje o usługach (jeśli to strona oferty)
    const services = [];
    if (contentType === "service") {
      $(".service-item, .offer-item, .treatment-item").each((_, el) => {
        const serviceName = cleanText($(el).find("h3, h4, .title").text());
        const serviceDesc = cleanText($(el).find("p, .description").text());

        if (serviceName) {
          services.push({
            name: serviceName,
            description: serviceDesc,
          });
        }
      });
    }

    // Wyciągnij informacje o lekarzach (jeśli to strona zespołu)
    const doctors = [];
    let calendarInfo = null;

    if (contentType === "doctor" || url.includes("/o-nas/")) {
      // Sprawdź czy to strona konkretnego lekarza
      const doctorName = cleanText($("h1").text() || title);
      const specialization = cleanText(
        $(".specialization, .specialty, .position").text()
      );
      const experience = cleanText($(".experience, .bio, .description").text());

      if (doctorName && !doctorName.toLowerCase().includes("zespół")) {
        doctors.push({
          name: doctorName,
          specialization: specialization,
          experience: experience,
        });

        // Scrapowanie informacji o kalendarzu/dostępności terminów
        if (doctorName && !doctorName.toLowerCase().includes("zespół")) {
          console.log(`👨‍⚕️ Scrapuję kalendarz dla lekarza: ${doctorName}`);
          calendarInfo = await scrapeDynamicCalendar(url, doctorName);
        } else {
          calendarInfo = extractCalendarInfo($, doctorName);
        }
      }
    }

    // Sprawdź czy strona ma wystarczająco treści
    if (!content || content.length < 100) {
      console.warn(
        `⚠️ Strona ${url} ma mało treści (${content.length} znaków)`
      );
    }

    // Zwróć strukturę danych
    return {
      url,
      title,
      metaDescription,
      contentType,
      content: content.slice(0, 10000), // Ogranicz długość treści
      headings,
      services: services.length > 0 ? services : undefined,
      doctors: doctors.length > 0 ? doctors : undefined,
      calendar: calendarInfo,
      lastModified: new Date().toISOString(),
      wordCount: content.split(/\s+/).length,
    };
  } catch (error) {
    console.error(`❌ Błąd scrapowania ${url}:`, error.message);
    return null;
  }
}

// Eksport dla kompatybilności
export default scrapePage;

// Main function - uruchomienie gdy jest wywoływany bezpośrednio
async function main() {
  try {
    console.log("🚀 Rozpoczynam scraping cnstomatologii.pl...");

    // Wczytaj sitemap
    const sitemap = JSON.parse(
      fs.readFileSync("data/cnstomatologii/cnstomatologii-sitemap.json", "utf8")
    );
    const filteredUrls = sitemap.filter((item) => item.included);

    console.log(`📄 Znaleziono ${filteredUrls.length} stron do przetworzenia`);

    const results = [];

    for (let i = 0; i < filteredUrls.length; i++) {
      const item = filteredUrls[i];
      console.log(
        `\\n[${i + 1}/${filteredUrls.length}] 🔍 Scrapuję: ${item.url}`
      );

      const pageData = await scrapePage(item.url);
      if (pageData) {
        results.push(pageData);
        console.log(`✅ Przetworzono ${item.url}`);

        // Pokazuj info o kalendarzu jeśli jest
        if (pageData.calendarInfo?.hasCalendar) {
          console.log(
            `📅 Kalendarz: ${
              pageData.calendarInfo.availableSlots?.length || 0
            } slotów`
          );
        }
      }

      // Czekaj między requestami
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Zapisz wyniki
    fs.writeFileSync(
      "data/cnstomatologii-pages.json",
      JSON.stringify(results, null, 2)
    );
    console.log(
      `\\n✅ Zapisano ${results.length} stron do data/cnstomatologii-pages.json`
    );
  } catch (error) {
    console.error("❌ Błąd głównej funkcji:", error.message);
  }
}

// Uruchom jeśli wywołany bezpośrednio
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
