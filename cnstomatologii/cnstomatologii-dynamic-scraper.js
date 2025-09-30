import puppeteer from "puppeteer";

// Funkcja do scrapowania kalendarza z dynamiczną zawartością
export async function scrapeDynamicCalendar(url, doctorName, timeout = 30000) {
  let browser = null;

  try {
    console.log(`🌐 Uruchamiam przeglądarkę dla: ${url}`);

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Ustaw user agent i viewport
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    await page.setViewport({ width: 1366, height: 768 });

    console.log(`📄 Ładowanie strony: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeout,
    });

    // Poczekaj dodatkowe 3 sekundy na załadowanie kalendarza
    console.log(`⏳ Czekam 3s na załadowanie kalendarza...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Sprawdź czy jest iframe z kalendarzem ZnanyLekarz i poczekaj na jego załadowanie
    const iframes = await page.$$('iframe[src*="znanylekarz"]');
    if (iframes.length > 0) {
      console.log(
        `🖼️ Znaleziono ${iframes.length} iframe(s) ZnanyLekarz, czekam na załadowanie...`
      );
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Dłuższe oczekiwanie na iframe
    }

    // Spróbuj kliknąć elementy, które mogą wywołać kalendarz
    try {
      const clickableElements = [
        ".calendar-trigger",
        ".booking-trigger",
        "[data-calendar]",
        'button[class*="calendar"]',
        'button[class*="booking"]',
      ];

      for (const selector of clickableElements) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            console.log(`🖱️ Klikam w element: ${selector}`);
            await elements[0].click();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            break;
          }
        } catch (e) {
          // Ignoruj błędy kliknięć
        }
      }

      // Spróbuj kliknąć buttony z tekstem umów
      const buttons = await page.$$("button, a");
      for (const button of buttons) {
        try {
          const text = await button.evaluate(
            (el) => el.textContent?.toLowerCase() || ""
          );
          if (text.includes("umów") || text.includes("rezerwuj")) {
            console.log(`🖱️ Klikam w przycisk: ${text.slice(0, 30)}...`);
            await button.click();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            break;
          }
        } catch (e) {
          // Ignoruj błędy kliknięć
        }
      }
    } catch (e) {
      // Ignoruj błędy kliknięć
    }

    // Spróbuj poczekać na elementy kalendarza (z timeout)
    try {
      await page.waitForSelector(
        'button[title*="calendar_slot"], .calendar, .dp-calendar',
        { timeout: 5000 }
      );
      console.log(`📅 Wykryto elementy kalendarza`);
    } catch (e) {
      console.log(`⚠️ Nie wykryto elementów kalendarza w 5s, kontynuuję...`);
    }

    // Sprawdź czy jest kalendarz i pobierz informacje
    const calendarData = await page.evaluate(() => {
      const result = {
        availableSlots: [],
        nextAvailableDate: null,
        hasCalendar: false,
        bookingInfo: null,
        dynamicCalendar: false,
      };

      try {
        // Najpierw sprawdź iframe'y z ZnanyLekarz
        const iframes = document.querySelectorAll(
          'iframe[src*="znanylekarz"], iframe[data-id]'
        );
        console.log("Znaleziono iframe'ów:", iframes.length);

        if (iframes.length > 0) {
          result.hasCalendar = true;
          result.dynamicCalendar = true;

          // Sprawdź każdy iframe
          for (let i = 0; i < iframes.length; i++) {
            const iframe = iframes[i];
            const src = iframe.src || iframe.getAttribute("src") || "";
            const dataId = iframe.getAttribute("data-id") || "";

            console.log(`Iframe ${i + 1}:`, {
              src: src.substring(0, 100),
              dataId,
            });

            if (src.includes("znanylekarz") || dataId) {
              result.bookingInfo = {
                text: iframe.title || "Widget rezerwacji ZnanyLekarz.pl",
                link: src,
                type: "iframe_widget",
              };

              // Spróbuj przeanalizować src iframe'a pod kątem danych lekarza
              const doctorMatch =
                src.match(/\/([^\/]+)\/null/) || src.match(/\/([^\/\?]+)\//);
              if (doctorMatch) {
                result.bookingInfo.doctorSlug = doctorMatch[1];
              }
              break;
            }
          }
        }

        // Szukaj dostępnych slotów (mogą być w iframe, ale spróbujmy)
        const availableSlots = document.querySelectorAll(
          'button[title="calendar_slot_available"]'
        );
        if (availableSlots.length > 0) {
          result.hasCalendar = true;
          result.dynamicCalendar = true;

          availableSlots.forEach((slot) => {
            const timeText = slot.textContent?.trim();
            const ariaLabel = slot.getAttribute("aria-label");

            if (timeText && ariaLabel) {
              result.availableSlots.push({
                time: timeText,
                fullLabel: ariaLabel,
              });
            }
          });
        }

        // Szukaj informacji o najbliższym wolnym terminie
        const nextFreeSelectors = [
          ".dp-calendar-state-message strong",
          ".next-available strong",
          ".calendar-next-date strong",
        ];

        for (const selector of nextFreeSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const dateText = element.textContent?.trim();
            if (dateText && dateText.length > 3) {
              result.hasCalendar = true;
              result.dynamicCalendar = true;
              result.nextAvailableDate = dateText;
              break;
            }
          }
        }

        // Szukaj ogólnych tekstów o terminach
        const bodyText = document.body.textContent || "";
        const datePatterns = [
          /kolejny\s+wolny\s+termin[:\s]*([^\.]+)/i,
          /następny\s+wolny\s+termin[:\s]*([^\.]+)/i,
          /wolny\s+termin[:\s]*([^\.]+)/i,
          /(\d{1,2}\s+\w+,\s+\d{1,2}:\d{2})/i,
        ];

        for (const pattern of datePatterns) {
          const match = bodyText.match(pattern);
          if (match && match[1]) {
            result.hasCalendar = true;
            result.dynamicCalendar = true;
            result.nextAvailableDate = match[1].trim();
            break;
          }
        }

        // Sprawdź linki do ZnanyLekarz (tylko jeśli nie ma już iframe)
        if (!result.bookingInfo) {
          const znanyLekazLink = document.querySelector(
            'a[href*="znanylekarz"]'
          );
          if (znanyLekazLink) {
            result.hasCalendar = true;
            result.bookingInfo = {
              text: znanyLekazLink.textContent?.trim() || "Rezerwacja online",
              link: znanyLekazLink.href,
              type: "external_booking",
            };
          }
        }

        // Sprawdź czy jest jakikolwiek kalendarz (nawet pusty)
        const calendarElements = document.querySelectorAll(
          '.calendar, .dp-calendar, [class*="calendar"], [id*="calendar"], .booking-widget, .appointment-widget, .datepicker'
        );

        if (calendarElements.length > 0) {
          result.hasCalendar = true;
          result.dynamicCalendar = true;
        }

        // Sprawdź wszystkie elementy strong/span pod kątem dat
        const strongElements = document.querySelectorAll("strong, span, p");
        strongElements.forEach((el) => {
          const text = el.textContent?.trim() || "";
          // Sprawdź czy zawiera polskie nazwy miesięcy i godziny
          if (
            /\d{1,2}\s+(sty|lut|mar|kwi|maj|cze|lip|sie|wrz|paź|lis|gru|stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|paź),?\s+\d{1,2}:\d{2}/i.test(
              text
            )
          ) {
            result.hasCalendar = true;
            result.dynamicCalendar = true;
            if (!result.nextAvailableDate) {
              result.nextAvailableDate = text;
            }
          }
        });

        // Sprawdź czy są buttony/linki ze słowami kluczowymi
        const buttons = document.querySelectorAll("button, a");
        buttons.forEach((btn) => {
          const text = btn.textContent?.toLowerCase() || "";
          if (
            text.includes("umów") ||
            text.includes("rezerwuj") ||
            text.includes("termin") ||
            text.includes("wizyta")
          ) {
            result.hasCalendar = true;
            if (!result.bookingInfo && btn.href) {
              result.bookingInfo = {
                text: btn.textContent?.trim() || "Umów wizytę",
                link: btn.href,
                type: "booking_button",
              };
            }
          }
        });
      } catch (error) {
        console.error("Błąd podczas analizy kalendarza:", error);
      }

      return result;
    });

    console.log(
      `✅ Kalendarz dla ${doctorName}:`,
      JSON.stringify(calendarData, null, 2)
    );

    // Jeśli znaleziono iframe, spróbuj pobrać dane z jego zawartości
    if (
      calendarData.hasCalendar &&
      calendarData.bookingInfo?.type === "iframe_widget"
    ) {
      try {
        console.log(`🖼️ Próbuję dostęp do iframe ZnanyLekarz...`);

        const frames = await page.frames();
        const iframeFrame = frames.find((frame) =>
          frame.url().includes("znanylekarz.pl")
        );

        if (iframeFrame) {
          console.log(`📋 Znaleziono frame ZnanyLekarz, skanuje zawartość...`);

          // Poczekaj na załadowanie zawartości iframe'a
          await new Promise((resolve) => setTimeout(resolve, 3000));

          const iframeData = await iframeFrame.evaluate(() => {
            const iframeResult = {
              availableSlots: [],
              nextAvailableDate: null,
              hasSlots: false,
            };

            try {
              // Szukaj slotów w iframe'ie
              const slots = document.querySelectorAll(
                'button[title*="calendar_slot"], .calendar-slot, .time-slot, button[class*="slot"]'
              );
              slots.forEach((slot) => {
                const timeText = slot.textContent?.trim();
                const isAvailable =
                  !slot.disabled &&
                  !slot.classList.contains("disabled") &&
                  !slot.classList.contains("booked");

                if (timeText && isAvailable && /\d{1,2}:\d{2}/.test(timeText)) {
                  iframeResult.availableSlots.push({
                    time: timeText,
                    fullLabel: slot.getAttribute("aria-label") || timeText,
                  });
                  iframeResult.hasSlots = true;
                }
              });

              // Szukaj informacji o najbliższym terminie
              const nextTermElements = document.querySelectorAll(
                "strong, span, .next-date"
              );
              nextTermElements.forEach((el) => {
                const text = el.textContent?.trim() || "";
                if (/\d{1,2}\s+\w+,?\s+\d{1,2}:\d{2}/.test(text)) {
                  iframeResult.nextAvailableDate = text;
                }
              });
            } catch (error) {
              console.error("Błąd w iframe:", error);
            }

            return iframeResult;
          });

          // Połącz dane z iframe'a z głównymi danymi
          if (iframeData.hasSlots) {
            calendarData.availableSlots = iframeData.availableSlots;
            calendarData.dynamicCalendar = true;
          }

          if (iframeData.nextAvailableDate) {
            calendarData.nextAvailableDate = iframeData.nextAvailableDate;
          }

          console.log(`📊 Dane z iframe:`, JSON.stringify(iframeData, null, 2));
        }
      } catch (error) {
        console.warn(
          `⚠️ Nie udało się przeanalizować iframe: ${error.message}`
        );
      }
    }

    return calendarData;
  } catch (error) {
    console.error(
      `❌ Błąd podczas scrapowania kalendarza dla ${doctorName}:`,
      error.message
    );
    return {
      availableSlots: [],
      nextAvailableDate: null,
      hasCalendar: false,
      bookingInfo: null,
      dynamicCalendar: false,
      error: error.message,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Test funkcji
if (import.meta.url === `file://${process.argv[1]}`) {
  const testUrl = "https://cnstomatologii.pl/o-nas/tomasz-gajewski/";
  const result = await scrapeDynamicCalendar(testUrl, "Dr. Tomasz Gajewski");
  console.log("Wynik testu:", JSON.stringify(result, null, 2));
}
