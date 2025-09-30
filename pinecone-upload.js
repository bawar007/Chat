import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { PineconeClient } from "./pinecone-client.js";

dotenv.config();

function parseArgs(argv) {
  const args = {
    in: null,
    namespace: "products",
    batchSize: 100,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--in" || a === "-i") && argv[i + 1]) args.in = argv[++i];
    else if ((a === "--namespace" || a === "-n") && argv[i + 1])
      args.namespace = argv[++i];
    else if (a === "--batch" && argv[i + 1])
      args.batchSize = parseInt(argv[++i], 10);
  }
  return args;
}

function collectInputFiles(inFlag) {
  const files = [];
  if (inFlag) {
    if (!fs.existsSync(inFlag))
      throw new Error(`Nie znaleziono pliku/katalogu: ${inFlag}`);
    const stat = fs.statSync(inFlag);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(inFlag)) {
        if (f.endsWith("-products_embbed.json"))
          files.push(path.join(inFlag, f));
      }
    } else {
      files.push(inFlag);
    }
  } else {
    const dataDir = "data";
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (f.endsWith("-products_embbed.json"))
          files.push(path.join(dataDir, f));
      }
    }
  }
  return files;
}

function normalizeVector(vec) {
  const s = vec.reduce((acc, v) => acc + v * v, 0);
  if (s <= 0) return vec;
  const inv = 1 / Math.sqrt(s);
  return vec.map((x) => x * inv);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in && !fs.existsSync("data")) {
    console.log(
      "Użycie: node pinecone-upload.js --in <plik|folder> [--namespace ns] [--batch 100]"
    );
    console.log(
      "Brak parametru --in, zostanie przeszukany katalog data/ pod kątem *_embbed.json"
    );
  }

  const files = collectInputFiles(args.in);
  if (files.length === 0) {
    console.error("❌ Nie znaleziono żadnych plików *_embbed.json");
    process.exit(1);
  }

  const client = new PineconeClient();
  await client.initialize();

  let total = 0;
  const batchSize = args.batchSize;

  for (const file of files) {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    const vectors = [];
    for (const rec of arr) {
      if (!Array.isArray(rec.embedding)) continue;

      // Generuj ID z uwzględnieniem sekcji dla lepszej organizacji
      const section = rec.meta?.section || rec.metadata?.section || "unknown";
      const productId =
        rec.meta?.product_id || rec.metadata?.product_id || "unknown";
      const chunkIndex =
        rec.meta?.chunk_index || rec.metadata?.chunk_index || 0;

      const id = rec.id || `${productId}-${section}-${chunkIndex}`;

      // Przygotuj kolory zgodnie z wymaganiami Pinecone (list of strings) i zachowaj pełną strukturę
      let colorsRaw = rec.meta?.colors || rec.metadata?.colors;
      let colorsNames = undefined;
      let colorsFull = undefined;
      if (Array.isArray(colorsRaw)) {
        if (colorsRaw.length > 0 && typeof colorsRaw[0] === "object") {
          colorsNames = colorsRaw.map((c) => c?.name).filter(Boolean);
          try {
            colorsFull = JSON.stringify(colorsRaw);
          } catch {}
        } else {
          colorsNames = colorsRaw.map((x) => String(x));
        }
      }

      const metadata = {
        sourceFile: rec.sourceFile || path.basename(file),
        field: rec.meta?.field || rec.field || "text",
        url: rec.meta?.url || rec.metadata?.url,
        type: rec.meta?.type || rec.metadata?.type || "product",
        name: rec.meta?.name || rec.metadata?.name,
        product_id: productId,
        document_id: rec.meta?.document_id || rec.metadata?.document_id,
        title: rec.meta?.title || rec.metadata?.title,
        price: rec.meta?.price || rec.metadata?.price,
        category: rec.meta?.category || rec.metadata?.category,
        brand: rec.meta?.brand || rec.metadata?.brand,
        bikeType: rec.meta?.bikeType || rec.metadata?.bikeType,
        collection: rec.meta?.collection || rec.metadata?.collection,
        section: section, // Pole sekcji (description, specifications, geometry)
        chunk_index: chunkIndex,
        total_chunks: rec.meta?.total_chunks || rec.metadata?.total_chunks,
        colors: colorsNames,
        colors_full: colorsFull,
        text: rec.text?.slice(0, 3000) || undefined, // Zwiększony limit dla sekcyjnych dokumentów
      };

      vectors.push({ id, values: normalizeVector(rec.embedding), metadata });
    }

    console.log(
      `📦 ${path.basename(file)} → przygotowano ${vectors.length} wektorów`
    );

    // wysyłka w batchach
    for (let i = 0; i < vectors.length; i += batchSize) {
      const chunk = vectors.slice(i, i + batchSize);
      const { upserted } = await client.upsertVectors(chunk, args.namespace);
      total += upserted;
      console.log(
        `✅ Upsert ${i / batchSize + 1}/${Math.ceil(
          vectors.length / batchSize
        )} (${upserted})`
      );
    }
  }

  console.log(
    `🎉 Załadowano do Pinecone razem: ${total} wektorów (ns='${args.namespace}')`
  );
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("❌ Błąd uploadu do Pinecone:", e.message);
    process.exit(1);
  });
}
