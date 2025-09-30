import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";
import http from "http";
import https from "https";
import { scrapeProduct } from "./tabou-products-scraper.js";

// Prosty logger czasu
const t0 = Date.now();
const log = (...args) => console.log("[TABOU]", ...args);

// Ustawienia domyślne
const DEFAULTS = {
  sitemapUrl: "https://www.tabou.pl/product-sitemap.xml",
  outFile: path.resolve("data", "tabou-products.json"),
  concurrency: 5,
  timeoutMs: 20000,
  productTimeoutMs: 25000,
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
    else if (a === "--product-timeout" && argv[i + 1])
      args.productTimeoutMs = parseInt(argv[++i], 10);
  }
  return args;
}

// Pomocnicze: sleep z jitterem
function sleep(minMs = 100, maxMs = 300) {
  const d = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, d));
}

// HTTP GET z retry i timeoutem
async function httpGet(url, { timeout, retries, headers } = {}) {
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  let attempt = 0;
  const max = Math.max(0, retries ?? DEFAULTS.retries);
  while (true) {
    try {
      return await axios.get(url, {
        timeout: timeout ?? DEFAULTS.timeoutMs,
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
          Connection: "keep-alive",
          ...headers,
        },
        validateStatus: (s) => s >= 200 && s < 400,
        responseType: "text",
        httpAgent,
        httpsAgent,
      });
    } catch (e) {
      const status = e?.response?.status;
      const code = e?.code || e?.cause?.code;
      const retriableCodes = new Set([
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "ECONNABORTED",
        "ENOTFOUND",
      ]);
      const isRetriableStatus =
        typeof status === "number" && status >= 500 && status < 600;
      const isRetriable =
        isRetriableStatus ||
        retriableCodes.has(code) ||
        /socket hang up/i.test(e?.message || "");
      if (attempt < max && isRetriable) {
        const backoff = Math.min(1000 * Math.pow(2, attempt), 5000);
        attempt++;
        await sleep(backoff, backoff + 300);
        continue;
      }
      throw e;
    }
  }
}

// Ekstrakcja URL-i produktów z sitemap (obsługa XML/HTML)
function extractProductUrlsFromSitemap(content) {
  const urls = new Set();
  // 1) Spróbuj dopasować <loc>...
  const locRe =
    /<loc>\s*(https?:\/\/www\.tabou\.pl\/produkt\/[\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(content)) !== null) {
    const u = m[1].trim();
    if (u) urls.add(u);
  }
  // 2) Fallback: wyciągnij wszystkie odnośniki z tekstu
  const hrefRe = /https?:\/\/www\.tabou\.pl\/produkt\/[a-z0-9\-\/_?=]+/gi;
  let h;
  while ((h = hrefRe.exec(content)) !== null) {
    const u = h[0];
    urls.add(u);
  }
  return Array.from(urls);
}

async function fetchSitemapProducts({ sitemapUrl, limit }) {
  log("Pobieram sitemap:", sitemapUrl);
  const resp = await httpGet(sitemapUrl, {
    timeout: DEFAULTS.timeoutMs,
    retries: 1,
    headers: { Accept: "application/xml,text/html" },
  });
  const urlsAll = extractProductUrlsFromSitemap(resp.data);
  const urls = urlsAll
    .filter((u) => !u.includes("archive=1"))
    .filter((u) => /^https?:\/\/www\.tabou\.pl\/produkt\//.test(u));
  const unique = Array.from(new Set(urls.map((u) => u.replace(/\/$/, "/"))));
  const finalList =
    typeof limit === "number" && limit > 0 ? unique.slice(0, limit) : unique;
  log(
    `URL-e w sitemap: ${urlsAll.length} | po filtrach: ${unique.length} | do pobrania: ${finalList.length}`
  );
  return finalList;
}

async function scrapeProducts(urls, { concurrency, productTimeoutMs }) {
  const results = [];
  let done = 0;
  const total = urls.length;
  const pool = Math.max(1, concurrency || 5);

  async function worker(slice) {
    for (const url of slice) {
      try {
        const data = await scrapeProduct(url, {
          timeout: productTimeoutMs ?? DEFAULTS.productTimeoutMs,
          retries: 2,
        });
        results.push(data);
      } catch (e) {
        console.warn("⚠️  Błąd produktu:", url, e.message);
      } finally {
        done++;
        if (done % 5 === 0 || done === total) log(`Postęp: ${done}/${total}`);
        await sleep(80, 160);
      }
    }
  }

  const batches = [];
  for (let i = 0; i < urls.length; i += pool) {
    batches.push(urls.slice(i, i + pool));
  }
  for (const b of batches) {
    await Promise.all(b.map((u) => worker([u])));
  }
  return results;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv);
  const { sitemapUrl, outFile, limit, concurrency, productTimeoutMs } = args;
  try {
    const urls = await fetchSitemapProducts({ sitemapUrl, limit });
    if (urls.length === 0) {
      log("Brak adresów do przetworzenia (po filtrze archive=1)");
      process.exit(0);
    }

    log("Start scrapingu produktów...");
    const products = await scrapeProducts(urls, {
      concurrency,
      productTimeoutMs,
    });
    log(`Zebrano produktów: ${products.length}`);

    ensureDir(outFile);
    fs.writeFileSync(outFile, JSON.stringify(products, null, 2), "utf-8");
    const dt = Math.round((Date.now() - t0) / 1000);
    log(`Zapisano do: ${outFile} | Czas: ${dt}s`);
  } catch (e) {
    console.error("❌ Błąd wykonania:", e.message);
    process.exit(1);
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
