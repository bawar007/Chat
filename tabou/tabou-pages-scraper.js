import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import { URL } from "url";
import http from "http";
import https from "https";

const DEFAULTS = {
  sitemapUrl: "https://www.tabou.pl/page-sitemap.xml",
  outFile: path.resolve("data", "tabou-pages.json"),
  concurrency: 6,
  timeoutMs: 20000,
  retries: 2,
  limit: 0,
};

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
  }
  return args;
}

function sleep(minMs = 100, maxMs = 300) {
  const d = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, d));
}

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

function extractPageUrlsFromSitemap(content) {
  const urls = new Set();
  const locRe = /<loc>\s*(https?:\/\/www\.tabou\.pl\/[\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = locRe.exec(content)) !== null) {
    const u = m[1].trim();
    if (u) urls.add(u);
  }
  // fallback
  const hrefRe = /https?:\/\/www\.tabou\.pl\/[a-z0-9\-\/_?.=&%]+/gi;
  let h;
  while ((h = hrefRe.exec(content)) !== null) urls.add(h[0]);
  return Array.from(urls);
}

function shouldSkip(url) {
  const lower = url.toLowerCase();
  const disallow = [
    "/zamowienie",
    "/koszyk",
    "/blog",
    "/archiwum-produktow",
    "/archowum-produktow",
    "/huis",
    "/rowery",
    "/produkty",
    "/porownaj",
    "/moje-konto",
    "/produkt/",
    "/wp-content/",
    "/tag/",
    "/kategoria/",
    "/category/",
    "/search",
    "/?s=",
  ];
  return disallow.some((frag) => lower.includes(frag));
}

async function fetchSitemapPages({ sitemapUrl, limit }) {
  console.log("[PAGES] Pobieram sitemap:", sitemapUrl);
  const resp = await httpGet(sitemapUrl, {
    headers: { Accept: "application/xml,text/html" },
    retries: 1,
  });
  const urlsAll = extractPageUrlsFromSitemap(resp.data);
  const urls = urlsAll.filter(
    (u) => /^https?:\/\/www\.tabou\.pl\//.test(u) && !shouldSkip(u)
  );
  const unique = Array.from(new Set(urls.map((u) => u.replace(/\/$/, "/"))));
  const finalList =
    typeof limit === "number" && limit > 0 ? unique.slice(0, limit) : unique;
  console.log(
    `[PAGES] URL-e w sitemap: ${urlsAll.length} | po filtrach: ${unique.length} | do pobrania: ${finalList.length}`
  );
  return finalList;
}

function extractPageData(html, url) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  $(
    "nav, footer, header, .site-footer, .site-header, .breadcrumbs, .woocommerce-breadcrumb"
  ).remove();

  const title = ($("title").first().text() || "").trim();
  const h1 = ($("h1").first().text() || "").trim();
  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();

  const faqs = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).contents().text());
      const items = Array.isArray(json) ? json : [json];
      for (const it of items) {
        if (it["@type"] === "FAQPage" && Array.isArray(it.mainEntity)) {
          for (const q of it.mainEntity) {
            const question = q?.name || q?.question || "";
            const answer =
              q?.acceptedAnswer?.text ||
              (q?.acceptedAnswer?.["@type"] === "Answer" &&
                q?.acceptedAnswer?.text) ||
              "";
            if (question || answer) faqs.push({ question, answer });
          }
        }
      }
    } catch {}
  });

  const candidateSelectors = [
    "main",
    ".entry-content",
    ".content",
    "article",
    "#content",
    "#main",
    ".site-content",
  ];
  let container = null;
  let maxLen = 0;
  for (const sel of candidateSelectors) {
    const el = $(sel).first();
    if (el && el.length) {
      const len = el.text().replace(/\s+/g, " ").trim().length;
      if (len > maxLen) {
        maxLen = len;
        container = el;
      }
    }
  }
  if (!container || !container.length) container = $("body");

  const skipAncestors = [
    "form",
    ".woocommerce",
    ".sidebar",
    ".widget",
    ".site-footer",
    ".site-header",
    "nav",
    "footer",
    "header",
  ];

  const contentParts = [];
  container.find("h2, h3, p, li").each((_, el) => {
    const $el = $(el);
    if (skipAncestors.some((s) => $el.closest(s).length > 0)) return;
    let text = $el.text().replace(/\s+/g, " ").trim();
    if (!text) return;
    if (/^strona główna/i.test(text)) return;
    const tag = el.tagName?.toLowerCase();
    if (tag === "h2" || tag === "h3") contentParts.push(`## ${text}`);
    else if (tag === "li") contentParts.push(`- ${text}`);
    else contentParts.push(text);
  });

  const text = contentParts.join("\n");
  const lowerUrl = (url || "").toLowerCase();
  const lowerTitle = (h1 || title).toLowerCase();
  let pageType = "page";
  if (lowerUrl.includes("/gwarancja") || /gwarancja/.test(lowerTitle))
    pageType = "warranty";
  else if (lowerUrl.includes("/reklamacje") || /reklamac/.test(lowerTitle))
    pageType = "returns";
  else if (lowerUrl.includes("/jak-kupowac") || /jak kupowa/.test(lowerTitle))
    pageType = "howto";
  else if (
    lowerUrl.includes("/polityka-prywatnosci") ||
    /prywatno/.test(lowerTitle)
  )
    pageType = "privacy";
  else if (
    lowerUrl.includes("/zakupy-na-raty") ||
    /raty|płatno/.test(lowerTitle)
  )
    pageType = "payment";

  const paragraphs = contentParts.filter(
    (l) => l && !l.startsWith("##") && !l.startsWith("-")
  );
  const summary = paragraphs.slice(0, 2).join(" ");

  return {
    type: "page",
    url,
    title: h1 || title,
    metaDescription: metaDesc,
    text,
    pageType,
    summary,
    faqs,
    scrapedAt: new Date().toISOString(),
  };
}

async function scrapePages(urls, { concurrency }) {
  const results = [];
  let i = 0;
  const pool = Math.max(1, concurrency || 6);
  const batches = [];
  for (let j = 0; j < urls.length; j += pool)
    batches.push(urls.slice(j, j + pool));

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        try {
          const { data } = await httpGet(url);
          const page = extractPageData(data, url);
          results.push(page);
        } catch (e) {
          console.warn("[PAGES] Błąd strony:", url, e.message);
        } finally {
          i++;
          if (i % 5 === 0 || i === urls.length)
            console.log(`[PAGES] Postęp: ${i}/${urls.length}`);
          await sleep(60, 140);
        }
      })
    );
  }
  return results;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv);
  const { sitemapUrl, outFile, limit, concurrency } = args;
  try {
    const urls = await fetchSitemapPages({ sitemapUrl, limit });
    if (urls.length === 0) {
      console.log("[PAGES] Brak adresów do przetworzenia po filtrach");
      process.exit(0);
    }
    console.log("[PAGES] Start scrapingu stron...");
    const pages = await scrapePages(urls, { concurrency });
    console.log(`[PAGES] Zebrano stron: ${pages.length}`);
    ensureDir(outFile);
    fs.writeFileSync(outFile, JSON.stringify(pages, null, 2), "utf-8");
    console.log(`[PAGES] Zapisano do: ${outFile}`);
  } catch (e) {
    console.error("❌ Błąd (pages scraper):", e.message);
    process.exit(1);
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
