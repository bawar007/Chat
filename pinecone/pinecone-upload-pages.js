import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { PineconeClient } from "./pinecone-client.js";

dotenv.config();

function normalizeVector(vec) {
  const s = vec.reduce((acc, v) => acc + v * v, 0);
  if (s <= 0) return vec;
  const inv = 1 / Math.sqrt(s);
  return vec.map((x) => x * inv);
}

async function main() {
  const inFile = process.argv[2] || "data/tabou-pages_embbed.json";
  const namespace = "pages";

  if (!fs.existsSync(inFile)) {
    console.error(`❌ Nie znaleziono pliku: ${inFile}`);
    process.exit(1);
  }

  const arr = JSON.parse(fs.readFileSync(inFile, "utf8"));
  if (!Array.isArray(arr) || arr.length === 0) {
    console.error("❌ Plik nie zawiera żadnych rekordów do upsertu");
    process.exit(1);
  }

  const client = new PineconeClient();
  await client.initialize();

  const vectors = [];
  for (const rec of arr) {
    if (!Array.isArray(rec.embedding)) continue;
    const id =
      rec.id ||
      `${path.basename(inFile)}:${rec.index || 0}:${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    // Metadane: tylko to, co sensowne dla stron
    const metadata = {
      sourceFile: rec.sourceFile || path.basename(inFile),
      field: rec.meta?.field || rec.field || "text",
      url: rec.meta?.url || rec.metadata?.url,
      type: rec.meta?.type || rec.metadata?.type || "page",
      title: rec.meta?.title || rec.metadata?.title,
      // Dodatkowe pola pomocnicze — przydatne filtrowanie/prezentacja
      pageType: rec.meta?.pageType || rec.metadata?.pageType,
      metaDescription:
        rec.meta?.metaDescription || rec.metadata?.metaDescription,
      // Krótki fragment treści do podglądu
      text: rec.text?.slice(0, 1200) || undefined,
    };

    vectors.push({ id, values: normalizeVector(rec.embedding), metadata });
  }

  console.log(
    `📦 ${path.basename(inFile)} → przygotowano ${vectors.length} wektorów`
  );

  const batchSize = parseInt(process.env.PINECONE_BATCH || "100", 10);
  let total = 0;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const chunk = vectors.slice(i, i + batchSize);
    const { upserted } = await client.upsertVectors(chunk, namespace);
    total += upserted;
    console.log(
      `✅ Upsert ${i / batchSize + 1}/${Math.ceil(
        vectors.length / batchSize
      )} (${upserted})`
    );
  }

  console.log(
    `🎉 Załadowano do Pinecone razem: ${total} wektorów (ns='${namespace}')`
  );
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("❌ Błąd uploadu stron do Pinecone:", e.message);
    process.exit(1);
  });
}
