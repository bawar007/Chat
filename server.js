// Kopia zapasowa server.js, aby przywrócić gdy server.js był uszkodzony

import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { PineconeClient } from "./pinecone-client.js";

// --- Konfiguracja cache (embeddingi / odpowiedzi) ---
// Używamy lekkiej implementacji LRU opartej na Map.
// ENV zmienne pozwalają włączyć/wyłączyć oraz ustawić limity.
const CACHE_EMBEDDINGS_ENABLED =
  (process.env.CACHE_EMBEDDINGS_ENABLED || "true").toLowerCase() === "true";
const CACHE_EMBEDDINGS_MAX_ITEMS = parseInt(
  process.env.CACHE_EMBEDDINGS_MAX_ITEMS || "500"
);
const CACHE_EMBEDDINGS_TTL_MS = parseInt(
  process.env.CACHE_EMBEDDINGS_TTL_MS || "86400000"
); // domyślnie 24h

// Prosta struktura LRU: Map zachowuje kolejność wstawiania; przy odczycie przenosimy element na koniec.
class LRUCache {
  constructor(maxItems, ttlMs) {
    this.maxItems = maxItems;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expires }
  }

  _now() {
    return Date.now();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires && entry.expires < this._now()) {
      this.map.delete(key);
      return undefined;
    }
    // Odśwież pozycję (LRU): usuwamy i dodajemy ponownie aby trafiła na koniec iteracji
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const expires = this.ttlMs > 0 ? this._now() + this.ttlMs : 0;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires });
    // Jeśli przekroczono limit, usuń najstarszy (pierwszy w Map)
    if (this.map.size > this.maxItems) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
  }

  size() {
    return this.map.size;
  }
}

const embeddingCache = CACHE_EMBEDDINGS_ENABLED
  ? new LRUCache(CACHE_EMBEDDINGS_MAX_ITEMS, CACHE_EMBEDDINGS_TTL_MS)
  : null;
if (CACHE_EMBEDDINGS_ENABLED) {
  console.log(
    `🧠 Cache embeddingów włączony: max ${CACHE_EMBEDDINGS_MAX_ITEMS} pozycji, TTL ${CACHE_EMBEDDINGS_TTL_MS}ms`
  );
} else {
  console.log("🧠 Cache embeddingów wyłączony");
}

// Konfiguracja cache odpowiedzi
const CACHE_RESPONSES_ENABLED =
  (process.env.CACHE_RESPONSES_ENABLED || "false").toLowerCase() === "true";
const CACHE_RESPONSES_MAX_ITEMS = parseInt(
  process.env.CACHE_RESPONSES_MAX_ITEMS || "200"
);
const CACHE_RESPONSES_TTL_MS = parseInt(
  process.env.CACHE_RESPONSES_TTL_MS || "3600000"
); // 1h
const responseCache = CACHE_RESPONSES_ENABLED
  ? new LRUCache(CACHE_RESPONSES_MAX_ITEMS, CACHE_RESPONSES_TTL_MS)
  : null;
if (CACHE_RESPONSES_ENABLED) {
  console.log(
    `💬 Cache odpowiedzi włączony: max ${CACHE_RESPONSES_MAX_ITEMS} pozycji, TTL ${CACHE_RESPONSES_TTL_MS}ms`
  );
} else {
  console.log("💬 Cache odpowiedzi wyłączony");
}

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serwuj pliki statyczne z katalogu public
app.use(express.static("public"));

// CORS (prosty – w razie potrzeby doprecyzować do konkretnej domeny)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Prosty rate limiting (in-memory) – do produkcji lepiej Redis / nginx
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000"
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "60"); // zapytań / okno / IP
const rateMap = new Map();

app.use((req, res, next) => {
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  let bucket = rateMap.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
  }
  bucket.count += 1;
  rateMap.set(ip, bucket);
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests, slow down." });
  }
  next();
});

// Konfiguracja
const PORT = parseInt(process.env.PORT || "3000");
const MAX_CONTEXT_CHARS = parseInt(process.env.CONTEXT_MAX_CHARS || "80000");
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "1200");
const MAX_RESULTS_PER_TYPE = parseInt(process.env.MAX_RESULTS_PER_TYPE || "6");
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "1500");

// Pamięć sesji (w produkcji użyj Redis lub bazy danych)
const sessionMemory = new Map();

// Funkcje do zarządzania sesjami
function getSessionHistory(sessionId) {
  if (!sessionMemory.has(sessionId)) {
    sessionMemory.set(sessionId, []);
  }
  return sessionMemory.get(sessionId);
}

function addToSession(sessionId, userMessage, botResponse) {
  const history = getSessionHistory(sessionId);
  history.push({ user: userMessage, bot: botResponse });

  // Ogranicz historię do ostatnich 10 wymian (20 wiadomości)
  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }

  sessionMemory.set(sessionId, history);
}

function groupAndMergeChunks(documents) {
  const groupedByProduct = new Map();
  const standaloneChunks = [];

  // Grupuj dokumenty po product_id
  for (const doc of documents) {
    const productId = doc.metadata?.product_id || doc.metadata?.document_id;

    if (productId) {
      if (!groupedByProduct.has(productId)) {
        groupedByProduct.set(productId, []);
      }
      groupedByProduct.get(productId).push(doc);
    } else {
      standaloneChunks.push(doc);
    }
  }

  const mergedResults = [];

  // Łącz chunki tego samego produktu
  for (const [productId, chunks] of groupedByProduct) {
    if (chunks.length === 1) {
      mergedResults.push(chunks[0]);
    } else {
      // Sortuj chunki po indeksie lub score
      chunks.sort((a, b) => {
        const indexA = a.metadata?.index || 0;
        const indexB = b.metadata?.index || 0;
        return indexA - indexB;
      });

      // Łącz teksty chunków
      const mergedText = chunks.map((c) => c.text).join("\n\n");
      const avgScore =
        chunks.reduce((sum, c) => sum + (c.score || 0), 0) / chunks.length;

      // Utwórz połączony dokument z najlepszymi metadanymi
      const mergedDoc = {
        ...chunks[0], // bazuj na pierwszym chunku
        text: mergedText,
        score: avgScore,
        metadata: {
          ...chunks[0].metadata,
          chunks_merged: chunks.length,
          chunk_indices: chunks.map((c) => c.metadata?.index || 0).join(","),
        },
      };

      mergedResults.push(mergedDoc);
    }
  }

  // Dodaj dokumenty bez product_id
  mergedResults.push(...standaloneChunks);

  // Sortuj wyniki po score
  return mergedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));

  return dotProduct / (magnitudeA * magnitudeB);
}

// Funkcja wczytywania wszystkich plików embedding
function loadAllEmbeddingFiles() {
  let allDocs = [];

  // Wczytaj główny plik tabou.json
  try {
    console.log("📂 Szukam pliku: data/tabou.json");
    if (fs.existsSync("data/tabou.json")) {
      const mainData = JSON.parse(fs.readFileSync("data/tabou.json", "utf8"));
      if (Array.isArray(mainData) && mainData.length > 0) {
        allDocs = allDocs.concat(mainData);
        console.log(`📄 Wczytano główny plik: ${mainData.length} dokumentów`);
      }
    }
  } catch (err) {
    console.warn("⚠️ Błąd wczytywania tabou.json:", err.message);
  }

  // Wczytaj pliki części (tabou_part1.json, tabou_part2.json, ...)
  try {
    const dataDir = "data";
    const files = fs.readdirSync(dataDir);
    const partFiles = files.filter((file) =>
      file.match(/^tabou_part\d+\.json$/)
    );

    let totalPartDocs = 0;

    for (const partFile of partFiles) {
      try {
        console.log(`📂 Szukam pliku: ${dataDir}/${partFile}`);
        const partData = JSON.parse(
          fs.readFileSync(path.join(dataDir, partFile), "utf8")
        );
        if (Array.isArray(partData) && partData.length > 0) {
          allDocs = allDocs.concat(partData);
          totalPartDocs += partData.length;
          console.log(`📄 Wczytano ${partFile}: ${partData.length} dokumentów`);
        }
      } catch (err) {
        console.warn(`⚠️ Błąd wczytywania ${partFile}:`, err.message);
      }
    }

    if (totalPartDocs > 0) {
      console.log(
        `📁 Łącznie wczytano ${totalPartDocs} dokumentów z ${partFiles.length} plików części`
      );
    }
  } catch (err) {
    console.warn("⚠️ Błąd odczytu katalogu data:", err.message);
  }

  // Wczytaj wszystkie pliki *_embbed.json (generowane przez embed-file.js)
  try {
    const dataDir = "data";
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);
      const embbedFiles = files.filter((f) => f.endsWith("_embbed.json"));
      let embbedCount = 0;
      for (const ef of embbedFiles) {
        try {
          const p = path.join(dataDir, ef);
          console.log(`📂 Szukam pliku embeddingów: ${p}`);
          const arr = JSON.parse(fs.readFileSync(p, "utf8"));
          if (Array.isArray(arr) && arr.length > 0) {
            allDocs = allDocs.concat(
              arr.map((d) => {
                const meta = d.meta || {};
                const metadata = d.metadata || {};
                return {
                  text: d.text || meta.text || metadata.text || "",
                  embedding: d.embedding,
                  metadata: {
                    ...meta,
                    sourceFile: d.sourceFile || ef,
                    type: meta.type || metadata.type || "product",
                    title: meta.title || metadata.title || undefined,
                    price: meta.price || metadata.price || undefined,
                    url: meta.url || metadata.url || undefined,
                    // Nie nadpisuj wartości undefined jeśli już istnieją
                    ...(meta.name && { name: meta.name }),
                    ...(meta.category && { category: meta.category }),
                    ...(meta.brand && { brand: meta.brand }),
                    ...(meta.bikeType && { bikeType: meta.bikeType }),
                    ...(meta.colors && { colors: meta.colors }),
                  },
                };
              })
            );
            embbedCount += arr.length;
            console.log(`📄 Wczytano ${ef}: ${arr.length} embeddingów`);
          }
        } catch (err) {
          console.warn(`⚠️ Błąd wczytywania ${ef}:`, err.message);
        }
      }
      if (embbedCount > 0) {
        console.log(
          `📁 Łącznie wczytano ${embbedCount} dokumentów z *_embbed.json`
        );
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ Błąd odczytu katalogu data dla *_embbed.json:",
      err.message
    );
  }

  return allDocs;
}

// Wczytujemy dane z pliku/plików JSON z obsługą błędów
let docs = [];
let crawlStats = {};
let pineconeClient = null;

// Inicjalizacja Pinecone (opcjonalna)
const initializePinecone = async () => {
  try {
    if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
      pineconeClient = new PineconeClient();
      await pineconeClient.initialize();
      console.log("✅ Pinecone client zainicjalizowany");
      return true;
    } else {
      console.log(
        "ℹ️ Pinecone nie skonfigurowany (brak PINECONE_API_KEY lub PINECONE_INDEX_NAME)"
      );
      return false;
    }
  } catch (error) {
    console.error("❌ Błąd inicjalizacji Pinecone:", error.message);
    return false;
  }
};

// Załaduj lokalne embeddingi tylko jeśli nie wymuszono trybu Pinecone-only
const PINECONE_ONLY =
  (process.env.PINECONE_ONLY || "false").toLowerCase() === "true";
if (!PINECONE_ONLY) {
  docs = loadAllEmbeddingFiles();

  // Pre-normalizacja embeddingów dokumentów (unit length) dla szybszych obliczeń kosinusów = dot product
  let normDocs = 0;
  for (const d of docs) {
    if (Array.isArray(d.embedding)) {
      const s = d.embedding.reduce((acc, v) => acc + v * v, 0);
      if (s > 0) {
        const inv = 1 / Math.sqrt(s);
        for (let i = 0; i < d.embedding.length; i++) d.embedding[i] *= inv;
        normDocs++;
      }
    }
  }
  console.log(
    `🧪 Znormalizowano embeddingi dokumentów: ${normDocs}/${docs.length}`
  );

  if (docs.length === 0) {
    console.warn(
      "ℹ️ Brak lokalnych plików z embeddingami — jeśli używasz Pinecone, to OK."
    );
  } else {
    console.log(
      `🎉 ŁĄCZNIE WCZYTANO: ${docs.length} dokumentów z embeddingami`
    );
  }
} else {
  console.log(
    "🧭 Tryb PINECONE_ONLY włączony — lokalne pliki embeddingów nie będą ładowane."
  );
}

try {
  crawlStats = JSON.parse(fs.readFileSync("data/crawl_stats.json", "utf8"));
  console.log("📊 Statystyki crawlingu:", crawlStats.pageTypes);
} catch (err) {
  console.warn("⚠️ Brak pliku statystyk crawlingu");
}

async function getEmbedding(text) {
  try {
    const key = crypto.createHash("sha256").update(text).digest("hex");
    if (embeddingCache) {
      const cached = embeddingCache.get(key);
      if (cached) {
        console.log(`⚡ EMBEDDING CACHE HIT (${key.substring(0, 8)})`);
        lastEmbeddingCacheStatus = "HIT";
        return cached;
      } else {
        console.log(`🆕 EMBEDDING CACHE MISS (${key.substring(0, 8)})`);
        lastEmbeddingCacheStatus = "MISS";
      }
    }

    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
    });
    const data = await resp.json();

    if (data.error) {
      console.error("❌ Błąd API OpenAI Embeddings:", data.error);
      return null;
    }

    const embedding = data.data[0].embedding;
    if (embeddingCache) {
      embeddingCache.set(key, embedding);
    }
    lastEmbeddingCacheStatus = "MISS";
    return embedding;
  } catch (error) {
    console.error("❌ Błąd podczas tworzenia embedding:", error);
    return null;
  }
}

let lastEmbeddingCacheStatus = "MISS";

app.post("/api/chat", async (req, res) => {
  console.log("� === POCZĄTEK ENDPOINTU API/CHAT ===");
  console.log("�🔥 ENDPOINT HIT - req.body:", req.body);
  try {
    const { message, sessionId } = req.body || {};
    const t0 = Date.now();

    console.log("📨 Otrzymano zapytanie:", message);

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Brak wiadomości" });
    }

    // Walidacja długości
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res
        .status(400)
        .json({ error: `Wiadomość za długa (>${MAX_MESSAGE_LENGTH} znaków)` });
    }

    // Prosta sanityzacja wejścia (usunięcie znaków kontrolnych poza \n \r \t)
    const sanitizedMessage = message
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim();
    if (sanitizedMessage.length === 0) {
      return res.status(400).json({ error: "Pusta wiadomość po oczyszczeniu" });
    }

    // Domyślny sessionId jeśli nie podano
    const currentSessionId = sessionId || "sess_" + crypto.randomUUID();

    // Pobierz historię konwersacji dla sesji
    const conversationHistory = getSessionHistory(currentSessionId);
    console.log(
      `💭 Sesja ${currentSessionId}: historia ${conversationHistory.length} wymian`
    );

    // (Instrumentacja wydajności została dodana wcześniej – start mierzenia w t0 powyżej)

    let queryEmbedding = await getEmbedding(sanitizedMessage);
    // Normalizacja embeddingu zapytania (aby móc używać czystego dot product)
    if (Array.isArray(queryEmbedding)) {
      const qs = queryEmbedding.reduce((a, v) => a + v * v, 0);
      if (qs > 0) {
        const inv = 1 / Math.sqrt(qs);
        for (let i = 0; i < queryEmbedding.length; i++)
          queryEmbedding[i] *= inv;
      }
    }
    if (!queryEmbedding) {
      return res
        .status(500)
        .json({ error: "Nie udało się przetworzyć zapytania" });
    }
    res.setHeader("X-Embedding-Cache", lastEmbeddingCacheStatus);

    // Dodatkowe filtrowanie: jeśli pytanie ewidentnie dotyczy produktu,
    // odfiltrowuj dokumenty general i FAQ
    const query = sanitizedMessage.toLowerCase();
    let ranked = [];

    // Sprawdź czy użyć Pinecone czy lokalnego wyszukiwania
    if (false && pineconeClient) {
      // WYŁĄCZONE - używaj tylko lokalnych plików
      console.log("🔍 Używam Pinecone do wyszukiwania...");
      try {
        // Przygotuj filtry dla Pinecone
        const filters = {};

        const isProductQuery = query.match(
          /rower|bike|trek|giant|specialized|kask|hamulce|przerzutka|koła|rama|cena|koszt|ile|kupić|sprzedaż|produkt|model|dostępny|najtańszy|najdroższy|geometria|wymiary|specyfikacja|komponenty|napęd|tabou|wizz|gravo|flow|rozmiar/
        );

        console.log("🔍 Query:", query);
        console.log("🎯 isProductQuery:", isProductQuery);

        let namespace = "default";
        if (isProductQuery) {
          filters.type = { $eq: "product" };
          namespace = "products"; // Produkty są w namespace 'products'
          console.log("🎯 Wyszukiwanie produktów w namespace 'products'");
        } else {
          // Dla zapytań ogólnych sprawdź też namespace 'pages'
          namespace = "pages";
          console.log("🎯 Wyszukiwanie stron w namespace 'pages'");
        }

        // Wyszukaj w Pinecone
        const pineconeResults = await pineconeClient.semanticSearch(
          queryEmbedding,
          25, // TOP_K - zwiększone dla lepszego pokrycia chunków
          filters,
          namespace
        );

        console.log(
          "📊 Pinecone results:",
          pineconeResults.matches?.length || 0
        );

        // Przekształć wyniki Pinecone na format lokalny
        let pineconeMatches = (pineconeResults.matches || []).map((match) => {
          const md = match.metadata || {};
          const title = md.title || md.name || "Dokument";
          let desc = md.description || md.text || "";

          // Dodaj geometrię jeśli jest dostępna i zapytanie dotyczy geometrii
          if (
            md.geometry &&
            /geometr|wymiar|specyfikacj|rozmiar/i.test(query)
          ) {
            desc += `\n\n## GEOMETRIA\n${md.geometry}`;
          }

          return {
            text: desc ? `${title} - ${desc}` : `${title}`,
            score: match.score,
            metadata: md,
          };
        });

        // Grupuj i łącz chunki tego samego produktu
        ranked = groupAndMergeChunks(pineconeMatches);

        console.log(
          `🔍 Pinecone zwrócił ${
            ranked.length
          } wyników (score: ${ranked[0]?.score.toFixed(3)} - ${ranked[
            ranked.length - 1
          ]?.score.toFixed(3)})`
        );
      } catch (error) {
        console.error(
          "❌ Błąd Pinecone, fallback do lokalnego wyszukiwania:",
          error.message
        );
        pineconeClient = null; // Wyłącz Pinecone na tej sesji
        ranked = []; // Wyczyść wyniki
      }
    }

    // Fallback do lokalnego wyszukiwania jeśli Pinecone nie działa lub nie ma wyników
    if (!pineconeClient || ranked.length === 0) {
      console.log("🔍 Używam lokalnego wyszukiwania...");
      let candidateDocs = docs;

      const isProductQuery = query.match(
        /rower|bike|trek|giant|specialized|kask|hamulce|przerzutka|koła|rama|cena|koszt|ile|kupić|sprzedaż|produkt|model|dostępny|najtańszy|najdroższy|geometria|wymiary|specyfikacja|komponenty|napęd|tabou|wizz|gravo|flow|rozmiar/
      );

      if (isProductQuery) {
        // Sprawdź czy pytanie dotyczy geometrii/wymiarów
        const isGeometryQuery =
          /geometr|wymiar|rozmiar|wielkość|ST|TT|HT|WB|RC|SA|HA|PK|WS/i.test(
            query
          );

        // Filtruj dokumenty aby wykluczyć general i FAQ gdy pytanie jest o produkt
        let filteredDocs = docs.filter((doc) => {
          const type = doc.metadata?.type || "unknown";
          return type !== "general" && type !== "faq";
        });

        // Jeśli pytanie o geometrię, preferuj dokumenty z sekcją geometry
        if (isGeometryQuery) {
          const geometryDocs = filteredDocs.filter(
            (doc) =>
              doc.metadata?.section === "geometry" ||
              doc.text?.includes("## GEOMETRIA")
          );
          if (geometryDocs.length > 0) {
            console.log(
              `🎯 Znaleziono ${geometryDocs.length} dokumentów z geometrią`
            );
            filteredDocs = geometryDocs;
          }
        }

        // Użyj filtrowanych dokumentów jeśli mamy wystarczająco produktów/kategorii
        if (filteredDocs.length >= 5) {
          candidateDocs = filteredDocs;
          console.log(
            `🎯 Filtrowanie general/FAQ: ${docs.length} → ${candidateDocs.length} dokumentów`
          );
        }
      }

      const wantsPriceSort = query.match(
        /tańsze|taniej|najtańsze|budżetowe|po cenie|do.*zł/
      );
      const TOP_K = 15;
      const RANK_SCAN_LIMIT = 400;
      const scanLimit =
        RANK_SCAN_LIMIT > 0 && candidateDocs.length > RANK_SCAN_LIMIT
          ? RANK_SCAN_LIMIT
          : candidateDocs.length;

      if (wantsPriceSort) {
        ranked = candidateDocs
          .slice(0, scanLimit)
          .map((d) => ({
            ...d,
            score: cosineSimilarity(queryEmbedding, d.embedding),
          }))
          .sort((a, b) => {
            const pricePattern = /(\d+(?:[\s.,]\d{3})*)\s*zł/;
            const price = (doc) => {
              const m = doc.text.match(pricePattern);
              return m ? parseFloat(m[1].replace(/[\s.,]/g, "")) : Infinity;
            };
            const pa = price(a),
              pb = price(b);
            if (pa !== Infinity && pb !== Infinity) return pa - pb;
            return b.score - a.score;
          })
          .slice(0, TOP_K);
      } else {
        const buf = [];
        for (let i = 0; i < scanLimit; i++) {
          const d = candidateDocs[i];
          const score = cosineSimilarity(queryEmbedding, d.embedding); // już dot product po normalizacji
          if (buf.length < TOP_K) {
            buf.push({ ...d, score });
            if (buf.length === TOP_K) buf.sort((a, b) => a.score - b.score);
          } else if (score > buf[0].score) {
            buf[0] = { ...d, score };
            buf.sort((a, b) => a.score - b.score);
          }
        }
        ranked = buf.sort((a, b) => b.score - a.score);
      }
    } // Koniec lokalnego wyszukiwania

    console.log(
      `🔍 Wybrano ${
        ranked.length
      } najlepszych dopasowań (score: ${ranked[0]?.score.toFixed(3)} - ${ranked[
        ranked.length - 1
      ]?.score.toFixed(3)})`
    );

    // Grupowanie wyników według typu dla lepszej organizacji
    const groupedResults = {};
    ranked.forEach((doc) => {
      const type = doc.metadata?.type || "other";
      if (!groupedResults[type]) {
        groupedResults[type] = [];
      }
      groupedResults[type].push(doc);
    });

    console.log(
      "📊 Typy dokumentów:",
      Object.keys(groupedResults)
        .map((type) => `${type}(${groupedResults[type].length})`)
        .join(", ")
    );

    const contextParts = [];
    // Prosta obsługa komendy "pokaż więcej" – zwiększ liczbę pozycji per sekcja
    const askMore =
      /pokaż więcej|pokaz więcej|pokaz wiecej|pokaz więcej|wie?cej/i.test(
        sanitizedMessage
      );
    const effectiveMaxPerType = askMore
      ? MAX_RESULTS_PER_TYPE * 2
      : MAX_RESULTS_PER_TYPE;

    // Sprawdź czy są produkty niedostępne i znajdź alternatywy
    const unavailableProducts = ranked.filter((doc) => {
      const isProduct = doc.metadata?.type === "product";
      return isProduct;
    });

    if (unavailableProducts.length > 0) {
      console.log(
        `🔄 Znaleziono ${unavailableProducts.length} niedostępnych produktów, szukam alternatyw...`
      );

      for (const unavailableProduct of unavailableProducts.slice(0, 2)) {
        // Max 2 niedostępne produkty
        // Znajdź podobne dostępne produkty
        const alternatives = docs
          .filter((doc) => {
            const isProduct = doc.metadata?.type === "product";
            const isAvailable =
              !doc.metadata?.availability ||
              (!doc.metadata.availability
                .toLowerCase()
                .includes("niedostępny") &&
                !doc.metadata.availability.toLowerCase().includes("brak"));
            const isDifferent =
              doc.metadata?.url !== unavailableProduct.metadata?.url;

            return isProduct && isAvailable && isDifferent;
          })
          .map((doc) => ({
            ...doc,
            score: cosineSimilarity(
              unavailableProduct.embedding,
              doc.embedding
            ),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);

        if (alternatives.length > 0) {
          console.log(
            `✅ Znaleziono ${alternatives.length} alternatyw dla niedostępnego produktu`
          );

          // Dodaj alternatywy do kontekstu
          contextParts.push("🔄 ALTERNATYWY DLA NIEDOSTĘPNYCH PRODUKTÓW:");
          alternatives.forEach((alt, index) => {
            let limitedText =
              alt.text.length > 400
                ? alt.text.substring(0, 400) + "..."
                : alt.text;
            contextParts.push(`Alternatywa ${index + 1}: ${limitedText}`);
          });
        }
      }
    }

    for (const [type, group] of Object.entries(groupedResults)) {
      let sectionHeader = "";
      switch (type) {
        case "product":
          sectionHeader = "🛍️ PRODUKTY:";
          break;
        case "category":
          sectionHeader = "📂 KATEGORIE:";
          break;
        case "faq":
          sectionHeader = "❓ FAQ:";
          break;
        case "contact":
          sectionHeader = "📞 KONTAKT:";
          break;
        case "about":
          sectionHeader = "ℹ️ O FIRMIE:";
          break;
        default:
          sectionHeader = "📄 INFORMACJE:";
          break;
      }

      contextParts.push(sectionHeader);

      // Ogranicz liczbę elementów w sekcji, aby uniknąć zbyt długich odpowiedzi
      const limitedGroup = group.slice(0, effectiveMaxPerType);

      limitedGroup.forEach((d, index) => {
        // Ograniczamy długość tekstu do 800 znaków na dokument
        let limitedText =
          d.text.length > 800 ? d.text.substring(0, 800) + "..." : d.text;
        let docInfo = `${limitedText}`;

        // Dodaj metadane jeśli dostępne (w skróconej formie)
        if (d.metadata) {
          if (d.metadata.title) docInfo += `\nTytuł: ${d.metadata.title}`;
          if (d.metadata.price) docInfo += `\nCena: ${d.metadata.price}`;
          if (d.metadata.availability)
            docInfo += `\nDostępność: ${d.metadata.availability}`;
          // Kolory: preferuj pełną strukturę jeśli dostępna
          let colorsLine = null;
          if (d.metadata.colors_full) {
            try {
              const full = JSON.parse(d.metadata.colors_full);
              if (Array.isArray(full) && full.length > 0) {
                const parts = full.slice(0, 2).map((c) => {
                  const name = c?.name || String(c);
                  if (
                    Array.isArray(c?.availableFrameAndWheelSizes) &&
                    c.availableFrameAndWheelSizes.length > 0
                  ) {
                    const sizes = c.availableFrameAndWheelSizes
                      .slice(0, 3)
                      .map((s) => `${s.size} ${s.available ? "✅" : "❌"}`)
                      .join(", ");
                    return `${name}: ${sizes}`;
                  }
                  return name;
                });
                colorsLine =
                  parts.join(" | ") + (full.length > 2 ? " | ..." : "");
              }
            } catch {}
          }
          if (
            !colorsLine &&
            Array.isArray(d.metadata.colors) &&
            d.metadata.colors.length > 0
          ) {
            colorsLine = `${d.metadata.colors.slice(0, 3).join(", ")}${
              d.metadata.colors.length > 3 ? "..." : ""
            }`;
          }
          if (colorsLine) {
            docInfo += `\nKolory: ${colorsLine}`;
          }
          if (d.metadata.frameSize)
            docInfo += `\nRozmiar ramy: ${d.metadata.frameSize}`;
          if (d.metadata.bikeType) docInfo += `\nTyp: ${d.metadata.bikeType}`;
          if (d.metadata.specifications) {
            const specs = Object.entries(d.metadata.specifications)
              .slice(0, 3)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ");
            if (specs) docInfo += `\nSpec: ${specs}`;
          }
          if (d.metadata.url) docInfo += `\nURL: ${d.metadata.url}`;
        }

        contextParts.push(docInfo);
      });

      // Jeśli obcięto liczbę wyników, dodaj notkę
      if (group.length > limitedGroup.length) {
        contextParts.push(
          `… i ${
            group.length - limitedGroup.length
          } więcej. Użyj frazy 'pokaż więcej' lub doprecyzuj zapytanie, aby zawęzić wyniki.`
        );
      }
      contextParts.push(""); // Pusta linia między sekcjami
    }

    let context = contextParts.join("\n");

    if (context.length > MAX_CONTEXT_CHARS) {
      context =
        context.substring(0, MAX_CONTEXT_CHARS) +
        "\n\n[Kontekst skrócony – limit]";
      console.log(
        `⚠️ Kontekst skrócony do ${context.length} znaków (limit ${MAX_CONTEXT_CHARS})`
      );
    }

    console.log(
      `📝 Przygotowano kontekst o długości: ${context.length} znaków`
    );

    // Cache odpowiedzi – zanim wykonamy zapytanie do modelu
    let responseCacheKey = null;
    if (responseCache) {
      try {
        const topDocIds = ranked
          .map(
            (d) =>
              d.metadata?.url || d.metadata?.title || d.text.substring(0, 40)
          )
          .join("|");
        const historyHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(conversationHistory))
          .digest("hex");
        responseCacheKey = crypto
          .createHash("sha256")
          .update(sanitizedMessage + "|" + topDocIds + "|" + historyHash)
          .digest("hex");
        const cachedAnswer = responseCache.get(responseCacheKey);
        if (cachedAnswer) {
          console.log(
            `💨 RESPONSE CACHE HIT (${responseCacheKey.substring(0, 8)})`
          );
          res.setHeader("X-Response-Cache", "HIT");
          addToSession(currentSessionId, sanitizedMessage, cachedAnswer);
          return res.json({
            response: cachedAnswer,
            sessionId: currentSessionId,
            cached: true,
          });
        } else {
          console.log(
            `🆕 RESPONSE CACHE MISS (${responseCacheKey.substring(0, 8)})`
          );
          res.setHeader("X-Response-Cache", "MISS");
        }
      } catch (e) {
        console.warn("⚠️ Błąd generowania klucza response cache:", e.message);
      }
    }

    // Ulepszone zapytanie do GPT
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Jesteś profesjonalnym asystentem sklepu internetowego tabou.pl.

INSTRUKCJE PODSTAWOWE:
- Odpowiadaj TYLKO na podstawie dostarczonego kontekstu
- Jeśli nie masz informacji w kontekście, powiedz to wprost
- Dla produktów zawsze podawaj: nazwę, cenę (jeśli dostępna), dostępność, kolory/warianty
- KOLORY: Kolory typu "pink / white" to JEDEN kolor dwukolorowy, a nie dwa oddzielne kolory
- Bądź pomocny i konkretny
- Jeśli użytkownik pyta o produkty, pokaż mu konkretne opcje

FORMATOWANIE I PREZENTACJA:
✅ ZAWSZE używaj struktury lista/tabela + ikonki - NIGDY suchego tekstu
📝 Obowiązkowe ikonki w odpowiedziach:
  🚲 - przy produktach/rowerach
  💰 - przy cenach/budżecie 
  ✅ - przy dostępności na stanie
  ❌ - przy braku dostępności
  🎨 - przy kolorach/wariantach
  📏 - przy rozmiarach
  🔧 - przy specyfikacjach technicznych
  🛒 - przy zakupach/dodawaniu do koszyka
  📞 - przy kontakcie/wsparciu
  📦 - przy dostawie
  ⭐ - przy rekomendacjach
  🔄 - przy alternatywach

PRZYKŁAD DOBREGO FORMATOWANIA:
"<h3>🚲 Dostępne rowery miejskie:</h3>
<ul>
  <li><strong>Trek FX 3</strong><br>
      💰 Cena: 2,999 zł<br>
      ✅ Dostępność: Na stanie<br>
      🎨 Kolory: czarny/srebrny, niebieski<br>
      📏 Rozmiary: 17cm, 19cm, 21cm<br>
      <a href='URL' target='_blank'>🛒 Zobacz produkt</a></li>
</ul>
<p>⭐ <strong>Rekomendacja:</strong> Trek FX 3 to doskonały wybór na codzienne dojazdy do pracy.</p>"

TABELE dla porównań:
"<table border='1' style='width:100%; border-collapse: collapse;'>
<tr style='background: #f5f5f5;'><th>🚲 Produkt</th><th>💰 Cena</th><th>✅ Status</th></tr>
<tr><td>Trek FX 3</td><td>2,999 zł</td><td>Na stanie</td></tr>
</table>"

WSZYSTKIE LINKI: target='_blank' (nowe okno)

DOPYTYWANIE I PROWADZENIE ROZMOWY:
- Jeśli pytanie jest zbyt ogólne (np. "chcę rower"), zadawaj doprecyzowujące pytania jak sprzedawca w sklepie rowerowym:
  * "Czy interesuje Cię rower miejski, MTB, gravel czy szosowy?"
  * "Jaki rozmiar ramy preferujesz?"
  * "Jaki budżet masz w planach?"
  * "Czy to rower dla dorosłego czy dziecka?"
- Używaj historii konwersacji do kontynuowania wątku (np. jeśli wcześniej wspomniał o "gravel", pamiętaj o tym)
- Gdy klient doprecyzowuje poprzednie pytanie (np. "a w kolorze czarnym"), odnieś się do wcześniejszych rekomendacji

RÓŻNORODNOŚĆ ODPOWIEDZI:
- UNIKAJ powtarzania tych samych sformułowań w kolejnych odpowiedziach
- Wykorzystuj różne style prezentacji:
  * LISTA PUNKTOWA: dla prostych wyliczeń produktów
  * TABELA: dla porównań lub szczegółowych zestawień
  * AKAPIT Z REKOMENDACJĄ: dla porad i sugestii
  * KRÓTKIE STRESZCZENIE: dla szybkich odpowiedzi
- Variuj początek odpowiedzi: "Oto", "Znalazłem", "Na podstawie danych", "Polecam", "Dostępne są"
- Używaj różnych określeń: "produkty/rowery/modele", "dostępne/na stanie/w sprzedaży"

LIMIT PREZENTACJI:
- Nie pokazuj więcej niż ${MAX_RESULTS_PER_TYPE} pozycji naraz. Jeśli wyników jest więcej, zaznacz to i zaproponuj doprecyzowanie (np. budżet/typ/rozmiar) lub poproś o komendę "pokaż więcej".

KOLORY/WARIANTY: 
- Jeśli masz informacje o kolorach, rozmiarach czy wariantach produktu, zawsze je uwzględnij
- Używaj informacji z pól "Kolory:" oraz "Aktualny kolor:" jeśli dostępne

PORÓWNANIA PRODUKTÓW:
- AUTOMATYCZNE WYKRYWANIE: Rozpoznaj prośby o porównanie z fraz takich jak:
  * "porównaj X z Y", "różnice między A i B"
  * "X czy Y", "co lepsze", "który wybrać"  
  * "zestawienie", "porównanie modeli"
  * gdy w pytaniu są wymienione 2 konkretne nazwy produktów
- AUTOMATYCZNE DZIAŁANIE: Jeśli wykryjesz prośbę o porównanie, automatycznie znajdź oba produkty w kontekście i stwórz porównanie
- Utwórz szczegółową tabelę porównawczą z następującymi kategoriami:
  * Nazwa produktu i cena
  * Dostępność i kolory
  * Specyfikacje techniczne (rama, koła, typ roweru, kolekcja)
  * Rozmiary dostępne
  * Główne zalety/różnice każdego produktu
- Zakończ porównanie rekomendacją dla różnych typów użytkowników

SORTOWANIE I FILTROWANIE:
- ROZPOZNAJ prośby o sortowanie po cenie: "tańsze alternatywy", "najtańsze", "budżetowe", "do X zł"
- AUTOMATYCZNIE prezentuj produkty od najtańszych gdy klient pyta o cenę
- Gdy klient podaje budżet (np. "do 3000 zł"), pokaż tylko produkty w tym przedziale
- Używaj fraz: "W Twoim budżecie:", "Najtańsze opcje:", "Alternatywy cenowe:"

WAŻNE: 
- Jeśli dostępność to "niedostępny" dla wszystkich produktów, może to oznaczać błąd w danych - podaj informację o konieczności sprawdzenia bezpośrednio w sklepie
- Gdy dostępność to "Dostępność do sprawdzenia", informuj że status należy sprawdzić bezpośrednio na stronie produktu`,
          },
          {
            role: "user",
            content: `Kontekst ze sklepu:\n${context}

${
  conversationHistory.length > 0
    ? `Historia konwersacji:
${conversationHistory
  .map(
    (item, index) => `${index + 1}. Klient: ${item.user}\n   Bot: ${item.bot}`
  )
  .join("\n")}\n`
    : ""
}
Aktualne pytanie klienta: ${message}`,
          },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.6,
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error("❌ Błąd API OpenAI:", data.error);
      return res.status(500).json({ error: "Błąd generowania odpowiedzi" });
    }

    let reply = data.choices[0].message.content;
    const finish =
      data.choices[0].finish_reason || data.choices[0].finishReason;
    if (finish === "length") {
      console.warn(
        "⚠️ Odpowiedź ucięta przez limit tokenów (finish_reason=length)"
      );
      reply +=
        '\n\n<p style="color:#888">(Odpowiedź została skrócona. Napisz: <em>pokaż więcej</em>, aby rozwinąć listę.)</p>';
    }
    if (responseCache && responseCacheKey) {
      responseCache.set(responseCacheKey, reply);
    }
    const tTotal = Date.now() - t0;
    // Jeśli wcześniejsze znaczniki istnieją (tEmbed0/1 etc.) moglibyśmy je tu uwzględnić – obecnie mamy tylko total.
    const PERF_LOG = true;
    if (PERF_LOG)
      console.log(
        `✅ Wygenerowano odpowiedź (${reply.length} znaków) total=${tTotal}ms`
      );
    res.setHeader("X-Time-Total", tTotal);

    // Zapisz do pamięci sesji
    addToSession(currentSessionId, sanitizedMessage, reply);
    console.log(
      `💾 Zapisano do sesji ${currentSessionId} (historia: ${
        conversationHistory.length + 1
      } wymian)`
    );

    res.json({
      response: reply,
      sources: ranked.length,
      types: Object.keys(groupedResults),
      sessionId: currentSessionId, // Zwróć sessionId dla frontend
    });
  } catch (error) {
    console.error("❌ Błąd podczas przetwarzania:", error);
    res
      .status(500)
      .json({ error: "Wystąpił błąd podczas przetwarzania zapytania" });
  }
});

// Endpoint do sprawdzania statusu
app.get("/api/status", (req, res) => {
  res.json({
    status: "OK",
    documentsLoaded: docs.length,
    pineconeEnabled: Boolean(pineconeClient),
    pineconeIndex: pineconeClient?.indexName || null,
    pineconeNamespace: pineconeClient?.namespace || null,
    crawlStats: crawlStats,
    lastCrawl: crawlStats.scrapedAt || "Nieznane",
  });
});

// Inicjalizacja Pinecone przy starcie serwera
initializePinecone();

app.listen(PORT, () =>
  console.log(`✔ Chat działa na http://localhost:${PORT}`)
);

let tEmbed1 = Date.now();
