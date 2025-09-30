import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import fetch from "node-fetch";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("❌ Brak klucza OPENAI_API_KEY w .env");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { in: null, out: null, field: null, chunkSize: 1400 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--in" || a === "-i") && argv[i + 1]) args.in = argv[++i];
    else if ((a === "--out" || a === "-o") && argv[i + 1]) args.out = argv[++i];
    else if ((a === "--field" || a === "-f") && argv[i + 1])
      args.field = argv[++i];
    else if (a === "--chunk-size" && argv[i + 1])
      args.chunkSize = parseInt(argv[++i], 10);
  }
  return args;
}

function ensureOutPath(inPath, outFlag) {
  const base = outFlag || `${inPath}_embbed.json`;
  const dir = path.dirname(base);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return base;
}

function chunkText(text, maxLen = 2500, overlapLen = 300) {
  // Zwiększam domyślny chunk size
  const parts = [];
  if (!text || text.trim().length === 0) return parts;

  // Normalizuj tekst
  const normalizedText = text.replace(/\r\n?/g, "\n").trim();

  // Najpierw spróbuj dzielić po sekcjach z nagłówkami (## RAMA, ## NAPĘD itp.)
  const sectionPattern = /^## [A-ZĄĆĘŁŃÓŚŹŻ\s]+$/gm;
  const sections = normalizedText.split(sectionPattern);
  const headers = normalizedText.match(sectionPattern) || [];

  if (sections.length > 1 && headers.length > 0) {
    // Mamy sekcje z nagłówkami - dzielimy semantycznie
    let currentChunk = sections[0].trim(); // Opis podstawowy

    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      const sectionContent = sections[i + 1] || "";
      const fullSection = `${header}\n${sectionContent}`.trim();

      // Sprawdź czy można dodać sekcję do obecnego chunku
      if (currentChunk.length + fullSection.length + 2 <= maxLen) {
        currentChunk = currentChunk + "\n\n" + fullSection;
      } else {
        // Zapisz obecny chunk z overlap
        if (currentChunk.trim()) {
          parts.push(currentChunk.trim());
        }

        // Stwórz overlap z końcówki poprzedniego chunku
        const overlap = createOverlap(currentChunk, overlapLen);
        currentChunk = overlap ? overlap + "\n\n" + fullSection : fullSection;
      }
    }

    // Dodaj ostatni chunk
    if (currentChunk.trim()) {
      parts.push(currentChunk.trim());
    }
  } else {
    // Brak sekcji - dziel po akapitach z overlap
    const paragraphs = normalizedText.split(/\n{2,}/);
    let currentChunk = "";

    for (const paragraph of paragraphs) {
      const trimmedP = paragraph.trim();
      if (!trimmedP) continue;

      // Sprawdź czy akapit zmieści się w obecnym chunku
      const testChunk = currentChunk
        ? `${currentChunk}\n\n${trimmedP}`
        : trimmedP;

      if (testChunk.length <= maxLen) {
        currentChunk = testChunk;
      } else {
        // Zapisz obecny chunk
        if (currentChunk.trim()) {
          parts.push(currentChunk.trim());
        }

        // Stwórz overlap i nowy chunk
        const overlap = createOverlap(currentChunk, overlapLen);

        // Jeśli akapit jest sam w sobie za długi, podziel go
        if (trimmedP.length > maxLen) {
          const subChunks = splitLongParagraph(trimmedP, maxLen, overlapLen);
          if (overlap && subChunks.length > 0) {
            subChunks[0] = overlap + "\n\n" + subChunks[0];
          }
          parts.push(...subChunks);
          currentChunk = "";
        } else {
          currentChunk = overlap ? overlap + "\n\n" + trimmedP : trimmedP;
        }
      }
    }

    // Dodaj ostatni chunk
    if (currentChunk.trim()) {
      parts.push(currentChunk.trim());
    }
  }

  return parts.filter((chunk) => chunk.trim().length > 0);
}

function createOverlap(text, overlapLen) {
  if (!text || overlapLen <= 0) return "";

  // Weź ostatnie 'overlapLen' znaków, ale spróbuj zakończyć na granicy słowa
  if (text.length <= overlapLen) return text;

  let overlap = text.slice(-overlapLen);

  // Znajdź ostatnią spację, aby nie ciąć słów
  const lastSpaceIndex = overlap.lastIndexOf(" ");
  if (lastSpaceIndex > overlapLen * 0.7) {
    // Tylko jeśli nie tracimy zbyt dużo
    overlap = overlap.slice(lastSpaceIndex + 1);
  }

  return overlap.trim();
}

function splitLongParagraph(paragraph, maxLen, overlapLen) {
  const parts = [];
  const sentences = paragraph.split(/[.!?]+/).filter((s) => s.trim());

  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim() + ".";
    const testChunk = currentChunk
      ? `${currentChunk} ${trimmedSentence}`
      : trimmedSentence;

    if (testChunk.length <= maxLen) {
      currentChunk = testChunk;
    } else {
      if (currentChunk.trim()) {
        parts.push(currentChunk.trim());
      }

      // Stwórz overlap
      const overlap = createOverlap(currentChunk, overlapLen);
      currentChunk = overlap
        ? overlap + " " + trimmedSentence
        : trimmedSentence;
    }
  }

  if (currentChunk.trim()) {
    parts.push(currentChunk.trim());
  }

  return parts;
}

function flattenSpecifications(spec) {
  if (!spec || typeof spec !== "object") return "";
  const lines = [];
  for (const [section, obj] of Object.entries(spec)) {
    if (!obj || typeof obj !== "object") continue;
    lines.push(`## ${section}`);
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === "-") continue;
      const key = String(k).replace(/_/g, " ");
      lines.push(`- ${key}: ${String(v).trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function flattenGeometry(geom) {
  if (!geom || typeof geom !== "object") return "";
  const lines = ["## GEOMETRIA"];
  for (const [metric, values] of Object.entries(geom)) {
    if (!values || typeof values !== "object") continue;
    for (const [size, val] of Object.entries(values)) {
      lines.push(`- ${metric} (${size}): ${String(val).trim()}`);
    }
  }
  return lines.join("\n").trim();
}

async function createEmbedding(input) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input }),
  });
  const data = await resp.json();
  if (data?.error) throw new Error(data.error?.message || "OpenAI error");
  return data.data[0].embedding;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in) {
    console.log(
      "Użycie: node embed-file.js --in <plik> [--field name] [--out <plik_wyj>] [--chunk-size N]"
    );
    process.exit(1);
  }

  const inPath = args.in;
  const outPath = ensureOutPath(inPath.replace(/\.json$/i, ""), args.out);

  if (!fs.existsSync(inPath)) {
    console.error(`❌ Nie znaleziono pliku: ${inPath}`);
    process.exit(1);
  }

  // wczytaj treść
  const raw = fs.readFileSync(inPath, "utf8");
  let records = [];
  let mode = "text";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      records = parsed;
      mode = "json-array";
    } else if (parsed && typeof parsed === "object") {
      records = [parsed];
      mode = "json-object";
    }
  } catch {
    // nie-JSON -> traktuj jako tekst
    records = [{ text: raw }];
    mode = "text";
  }

  const toEmbed = [];
  const fieldName = args.field || "text"; // domyślnie pole 'text'
  for (const rec of records) {
    const baseText =
      mode === "text"
        ? rec.text
        : rec[fieldName] || rec.specificationText || rec.description || "";

    // zbuduj metadane dla Pinecone, jeśli to obiekt produktu
    const baseMeta = {};
    if (mode !== "text" && rec && typeof rec === "object") {
      // Stwórz unikalny identyfikator produktu/dokumentu
      const productId = rec.url
        ? crypto
            .createHash("md5")
            .update(rec.url)
            .digest("hex")
            .substring(0, 12)
        : rec.name
        ? crypto
            .createHash("md5")
            .update(rec.name)
            .digest("hex")
            .substring(0, 12)
        : crypto.randomUUID().substring(0, 12);

      Object.assign(baseMeta, {
        product_id: productId,
        document_id: productId, // alias dla kompatybilności
        title: rec.name || rec.title,
        name: rec.name,
        price: rec.price,
        url: rec.url,
        type:
          rec.type || (rec.price || rec.specificationText ? "product" : "page"),
        category: rec.category,
        brand: rec.brand,
        bikeType: rec.bikeType,
        collection: rec.collection,
        // zachowaj strukturę colors taką jak po scrapowaniu (tablica stringów lub obiektów)
        colors: rec.colors,
        sku: rec.sku,
        // dla stron informacyjnych
        metaDescription: rec.metaDescription,
        faqs: rec.faqs,
      });
    }

    let fullText = String(baseText || "");
    // Jeśli to produkt, stwórz osobne dokumenty dla każdej sekcji
    const isProduct =
      (rec.type ||
        (rec.price || rec.specificationText ? "product" : "page")) ===
      "product";

    if (isProduct) {
      const specTxt = flattenSpecifications(
        rec.specifications || rec.specification || null
      );
      const geomTxt = flattenGeometry(rec.geometry || null);

      // Stwórz osobne dokumenty dla każdej sekcji
      const sections = [];

      // 1. Dokument z opisem
      if (fullText.trim()) {
        sections.push({
          text: fullText.trim(),
          section: "description",
          meta: { ...baseMeta, section: "description" },
        });
      }

      // 2. Dokument ze specyfikacją
      if (specTxt) {
        sections.push({
          text: specTxt,
          section: "specifications",
          meta: { ...baseMeta, section: "specifications" },
        });
      }

      // 3. Dokument z geometrią
      if (geomTxt) {
        sections.push({
          text: geomTxt,
          section: "geometry",
          meta: { ...baseMeta, section: "geometry" },
        });
      }

      // Dodaj wszystkie sekcje do przetworzenia
      for (const sectionDoc of sections) {
        const chunks = chunkText(sectionDoc.text, args.chunkSize);
        for (let i = 0; i < chunks.length; i++) {
          toEmbed.push({
            id: crypto.randomUUID(),
            sourceFile: path.basename(inPath),
            index: i,
            text: chunks[i],
            meta: {
              field: fieldName,
              ...sectionDoc.meta,
              chunk_index: i,
              total_chunks: chunks.length,
            },
          });
        }
      }
    } else {
      // Dla stron niebędących produktami - stara logika
      const chunks = chunkText(fullText, args.chunkSize);
      if (chunks.length === 0) continue;
      for (let i = 0; i < chunks.length; i++) {
        toEmbed.push({
          id: crypto.randomUUID(),
          sourceFile: path.basename(inPath),
          index: i,
          text: chunks[i],
          meta: { field: fieldName, ...baseMeta },
        });
      }
    }
  }

  console.log(
    `📄 Wejście: ${inPath} | tryb: ${mode} | rekordy: ${records.length} | chunki: ${toEmbed.length}`
  );

  const out = [];
  for (const item of toEmbed) {
    try {
      const embedding = await createEmbedding(item.text);
      out.push({ ...item, embedding });
    } catch (e) {
      console.warn("⚠️ Błąd embeddingu rekordu:", e.message);
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Zapisano: ${outPath} | dokumentów: ${out.length}`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
