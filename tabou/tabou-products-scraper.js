import axios from "axios";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import http from "http";
import https from "https";

// --- Odporne pobieranie HTML (keep-alive + retry + backoff) ---
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGetWithRetry(
  url,
  { timeout = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, headers = {} } = {}
) {
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  let attempt = 0;
  const max = Math.max(0, retries);
  while (true) {
    try {
      return await axios.get(url, {
        timeout,
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
          Connection: "keep-alive",
          ...headers,
        },
        validateStatus: (s) => s >= 200 && s < 400,
        httpAgent: HTTP_AGENT,
        httpsAgent: HTTPS_AGENT,
        responseType: "text",
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
        await sleep(backoff + Math.floor(Math.random() * 300));
        continue;
      }
      throw e;
    }
  }
}

export async function scrapeProduct(URL) {
  const { data: html } = await httpGetWithRetry(URL, {
    timeout: 25000,
    retries: 3,
  });
  const $ = cheerio.load(html);

  // Nazwa produktu
  const name = $("h1.product_title").text().trim();

  const category = name.includes("elektryczny")
    ? "electric"
    : name.includes("gravel")
    ? "gravel"
    : name.includes("MTB")
    ? "mtb"
    : name.includes("MTB TRAIL")
    ? "mtb_trail"
    : name.includes("crossowy")
    ? "cross"
    : name.includes("trekkingowy")
    ? "trekking"
    : name.includes("składany")
    ? "folding"
    : name.includes("miejski")
    ? "city"
    : name.includes("młodzieżowy")
    ? "youth"
    : name.includes("dziecięcy")
    ? "kids"
    : name.includes("DIRT")
    ? "dirt"
    : name.includes("BMX")
    ? "bmx"
    : "other";

  // Cena
  const price = $("p.price .woocommerce-Price-amount").first().text().trim();

  let bikeType = "";
  const bikeTypeRow = $('tr th label[for="pa_typ-roweru"]').closest("tr");
  if (bikeTypeRow.length) {
    bikeType =
      bikeTypeRow.find("option[selected]").text().trim().toLowerCase() ||
      bikeTypeRow
        .find("span.woo-selected-variation-item-name")
        .text()
        .replace(":", "")
        .trim()
        .toLowerCase();
  }

  let collection = "";
  const collectionRow = $('tr th label[for="pa_kolekcja"]').closest("tr");
  if (collectionRow.length) {
    collection =
      collectionRow.find("option[selected]").text().trim().toLowerCase() ||
      collectionRow
        .find("span.woo-selected-variation-item-name")
        .text()
        .replace(":", "")
        .trim()
        .toLowerCase();
  }

  // Opis
  const description = $("div.woocommerce-Tabs-panel--description")
    .text()
    .trim()
    .replace(/\s+\n/g, "\n");

  // Specyfikacja
  const specifications = {};
  $("#tab-custom_description .product-description-section").each(
    (_, section) => {
      const sectionName = $(section)
        .find(".product-description-title")
        .text()
        .trim()
        .toUpperCase();

      specifications[sectionName] = {};

      $(section)
        .find(".product-description-row")
        .each((_, row) => {
          const key = $(row).find("b").text().trim();
          const value = $(row)
            .clone()
            .children("b")
            .remove()
            .end()
            .text()
            .trim();

          const keyFormatted = key
            .toUpperCase()
            .replace(/\s+/g, "_")
            .replace(/Ł/g, "L")
            .replace(/Ś/g, "S")
            .replace(/Ź/g, "Z")
            .replace(/Ż/g, "Z")
            .replace(/Ć/g, "C")
            .replace(/Ń/g, "N")
            .replace(/Ą/g, "A")
            .replace(/Ę/g, "E")
            .replace(/Ó/g, "O");

          specifications[sectionName][keyFormatted] = value;
        });
    }
  );

  // Kolory + rozmiary z <ul id="custom-combined-select">
  const colorsMap = {};

  $("#custom-combined-select li.select-frame").each((_, el) => {
    const colorKey = $(el).attr("data-color");
    const size = $(el).text().trim();
    const available = !$(el).hasClass("out-of-stock");

    if (!colorsMap[colorKey]) {
      colorsMap[colorKey] = {
        name: colorKey.replace("-", " / "), // np. black-gold → black / gold
        availableFrameAndWheelSizes: [],
      };
    }

    colorsMap[colorKey].availableFrameAndWheelSizes.push({
      size,
      available,
    });
  });

  const colors = Object.values(colorsMap);

  // Geometria ramy
  const geometry = {};
  const geometryTable = $(".product-geometry-table tbody");

  // Wyciągamy rozmiary z pierwszego wiersza
  const headerCells = geometryTable
    .find("tr")
    .first()
    .find("td span")
    .toArray();
  const sizes = headerCells.slice(1).map((cell) => $(cell).text().trim()); // ["48", "53", "58", "61"]

  // Iterujemy po kolejnych wierszach (parametry)
  geometryTable
    .find("tr")
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find("td span").toArray();
      const paramName = $(cells[0]).text().trim();

      if (!paramName) return;

      geometry[paramName] = {};
      sizes.forEach((size, i) => {
        geometry[paramName][size] = $(cells[i + 1])
          .text()
          .trim();
      });
    });

  // Gotowy obiekt
  const product = {
    url: URL,
    type: "product",
    name,
    price,
    description,
    specifications,
    category,
    brand: "TABOU",
    colors,
    bikeType,
    collection,
    geometry,
    scrapedAt: dayjs().toISOString(),
  };

  return product;
}
