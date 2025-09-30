import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";
import http from "http";
import https from "https";
import { scrapePage } from "./cnstomatologii-pages-scraper.js";

// Prosty logger czasu
const t0 = Date.now();
const log = (...args) => console.log("[CNS]", ...args);

// Ustawienia domyślne
const DEFAULTS = {
  sitemapUrl: "https://cnstomatologii.pl/page-sitemap.xml",
  outFile: path.resolve("data", "cnstomatologii-pages.json"),
  concurrency: 3,
  timeoutMs: 15000,
  pageTimeoutMs: 20000,
  retries: 2,
};

// Parsowanie argumentów CLI
function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sitemap" && argv[i + 1]) args.sitemapUrl = argv[++i];
    else if (a === "--out" && argv[i + 1])
      args.outFile = path.resolve(argv[++i]);
    else if (a === "--limit" && argv[i + 1])
      args.limit = parseInt(argv[++i], 10);
    else if (a === "--concurrency" && argv[i + 1])
      args.concurrency = parseInt(argv[++i], 10);
    else if (a === "--timeout" && argv[i + 1])
      args.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--page-timeout" && argv[i + 1])
      args.pageTimeoutMs = parseInt(argv[++i], 10);
  }
  return args;
}

// Pomocnicze: sleep z jitterem
function sleep(minMs = 100, maxMs = 300) {
  const d = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, d));
}

// HTTP GET z retry i timeoutem
async function httpGetWithRetry(url, timeout = 15000, retries = 2) {
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
      await sleep(1000, 2000);
    }
  }
}

// Pobieranie URLi z sitemap
async function fetchSitemapUrls(sitemapUrl) {
  log(`Pobieranie sitemap: ${sitemapUrl}`);
  const xml = await httpGetWithRetry(sitemapUrl);
  const $ = cheerio.load(xml, { xmlMode: true });

  const urls = [];
  $("url").each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    const lastmod = $(el).find("lastmod").text().trim();

    if (loc) {
      urls.push({
        url: loc,
        lastmod: lastmod || null,
      });
    }
  });

  log(`Znaleziono ${urls.length} URLi w sitemap`);
  return urls;
}

// Filtrowanie URLi - usuwamy te, które nas nie interesują
function filterUrls(urls) {
  const filtered = urls.filter((item) => {
    const url = item.url;

    // Pomijamy wersje językowe (en/de) - skupiamy się na polskiej wersji
    if (url.includes("/en/") || url.includes("/de/")) return false;

    // Pomijamy polityki prywatności itp.
    if (url.includes("polityka-prywatnosci") || url.includes("privacy-policy"))
      return false;

    // Skupiamy się na najważniejszych sekcjach
    const importantSections = [
      "/oferta/", // oferty usług
      "/o-nas/", // informacje o lekarzach
      "/cennik/", // cennik
      "/kontakt/", // kontakt
      "/metamorfozy/", // metamorfozy
      "/galeria/", // galeria
    ];

    // Dodajemy stronę główną
    if (url === "https://cnstomatologii.pl/") return true;

    // Sprawdzamy czy URL zawiera którąś z ważnych sekcji
    return importantSections.some((section) => url.includes(section));
  });

  log(`Przefiltrowano ${urls.length} → ${filtered.length} URLi`);
  return filtered;
}

// Worker dla konkretnej strony
async function processPage(pageInfo, index, total, timeoutMs) {
  const { url } = pageInfo;
  try {
    log(`[${index + 1}/${total}] Przetwarzanie: ${url}`);
    const pageData = await scrapePage(url, timeoutMs);

    if (pageData) {
      log(`✅ [${index + 1}/${total}] Sukces: ${url}`);
      return pageData;
    } else {
      log(`⚠️ [${index + 1}/${total}] Brak danych: ${url}`);
      return null;
    }
  } catch (error) {
    log(`❌ [${index + 1}/${total}] Błąd ${url}: ${error.message}`);
    return null;
  }
}

// Główny worker pool
async function processPages(pages, concurrency, timeoutMs) {
  const results = [];
  const workers = [];
  let index = 0;

  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (index < pages.length) {
          const currentIndex = index++;
          const pageInfo = pages[currentIndex];
          await sleep(200, 500); // Delay między requestami
          const result = await processPage(
            pageInfo,
            currentIndex,
            pages.length,
            timeoutMs
          );
          if (result) results.push(result);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

// Główna funkcja
async function main() {
  const args = parseArgs(process.argv);

  try {
    // 1. Pobierz URLs z sitemap
    const allUrls = await fetchSitemapUrls(args.sitemapUrl);

    // 2. Przefiltruj URLs
    let filteredUrls = filterUrls(allUrls);

    // 3. Ogranicz liczbę jeśli podano limit
    if (args.limit && args.limit > 0) {
      filteredUrls = filteredUrls.slice(0, args.limit);
      log(`Ograniczono do ${args.limit} pierwszych URLi`);
    }

    if (filteredUrls.length === 0) {
      log("❌ Brak URLi do przetworzenia");
      return;
    }

    log(`🚀 Rozpoczynam scrapowanie ${filteredUrls.length} stron...`);

    // 4. Przetwarzaj strony
    const results = await processPages(
      filteredUrls,
      args.concurrency,
      args.pageTimeoutMs
    );

    // 5. Zapisz wyniki
    const outputDir = path.dirname(args.outFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(args.outFile, JSON.stringify(results, null, 2), "utf8");

    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`✅ Gotowe! Zapisano ${results.length} stron w ${args.outFile}`);
    log(`⏱️ Czas wykonania: ${elapsed}s`);
  } catch (error) {
    log(`❌ Błąd główny: ${error.message}`);
    process.exit(1);
  }
}

// Eksport funkcji dla innych modułów
export { fetchSitemapUrls, filterUrls, processPages };

// Uruchom jeśli wywoływany bezpośrednio
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("❌ Nieprzechwycony błąd:", e.message);
    process.exit(1);
  });
}
