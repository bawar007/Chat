import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { PineconeClient } from "./pinecone-client.js";

dotenv.config();

function parseArgs(argv) {
  const args = {
    in: null,
    namespace: "cnstomatologii",
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
        if (f.includes("cnstomatologii") && f.endsWith("_embbed.json"))
          files.push(path.join(inFlag, f));
      }
    } else {
      files.push(inFlag);
    }
  } else {
    const dataDir = "data";
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (f.includes("cnstomatologii") && f.endsWith("_embbed.json"))
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
      "Użycie: node cns-pinecone-upload.js --in <plik|folder> [--namespace ns] [--batch 100]"
    );
    console.log(
      "Brak parametru --in, zostanie przeszukany katalog data/ pod kątem cnstomatologii*_embbed.json"
    );
  }

  const files = collectInputFiles(args.in);
  if (files.length === 0) {
    console.error(
      "❌ Nie znaleziono żadnych plików cnstomatologii*_embbed.json"
    );
    process.exit(1);
  }

  const client = new PineconeClient();
  await client.initialize();

  let total = 0;
  const batchSize = args.batchSize;

  for (const file of files) {
    console.log(`📦 Przetwarzanie: ${path.basename(file)}`);
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    const vectors = [];

    for (const rec of arr) {
      if (!Array.isArray(rec.embedding)) continue;

      // Generuj ID z uwzględnieniem typu danych dla lepszej organizacji
      const dataType = rec.metadata?.dataType || "general";
      const doctorName = rec.metadata?.doctorName || "";
      const contentType = rec.metadata?.contentType || "page";

      // Format ID: cns-{contentType}-{dataType}-{timestamp}
      const id =
        rec.id ||
        `cns-${contentType}-${dataType}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

      const metadata = {
        // Podstawowe informacje
        source: "cnstomatologii.pl",
        sourceFile: rec.sourceFile || path.basename(file),
        url: rec.metadata?.url || "",
        title: rec.metadata?.title || "",

        // Typ treści i danych
        contentType: contentType,
        dataType: dataType,

        // Informacje medyczne
        doctorName: doctorName,
        specialization: rec.metadata?.specialization || "",

        // Metadane treści
        wordCount:
          rec.metadata?.wordCount || rec.text?.split(/\s+/).length || 0,
        lastModified: rec.metadata?.lastModified || new Date().toISOString(),

        // Tekst dla celów debugowania (ograniczony)
        text: rec.text?.slice(0, 2000) || undefined,
      };

      // Dodaj specyficzne metadane w zależności od typu danych
      if (dataType === "doctor_description") {
        metadata.searchTags = [
          "lekarz",
          "dentysta",
          "specjalizacja",
          doctorName.toLowerCase(),
        ];
      } else if (dataType === "doctor_reviews") {
        metadata.searchTags = [
          "opinie",
          "pacjenci",
          "recenzje",
          doctorName.toLowerCase(),
        ];
      } else if (dataType === "doctor_details") {
        metadata.searchTags = [
          "doświadczenie",
          "wykształcenie",
          "kariera",
          doctorName.toLowerCase(),
        ];
      } else if (dataType === "doctor_calendar") {
        metadata.searchTags = [
          "kalendarz",
          "terminy",
          "wizyta",
          "rezerwacja",
          doctorName.toLowerCase(),
        ];
      } else if (contentType === "service") {
        metadata.searchTags = ["usługi", "zabiegi", "leczenie", "stomatologia"];
      } else if (contentType === "contact") {
        metadata.searchTags = ["kontakt", "adres", "telefon", "godziny"];
      } else if (contentType === "pricing") {
        metadata.searchTags = ["cennik", "ceny", "koszt", "płatność"];
      } else {
        metadata.searchTags = ["informacje", "centrum", "stomatologia"];
      }

      vectors.push({
        id,
        values: normalizeVector(rec.embedding),
        metadata,
      });
    }

    console.log(
      `📄 ${path.basename(file)} → przygotowano ${vectors.length} wektorów`
    );

    // Wysyłka w batchach
    for (let i = 0; i < vectors.length; i += batchSize) {
      const chunk = vectors.slice(i, i + batchSize);
      try {
        const { upserted } = await client.upsertVectors(chunk, args.namespace);
        total += upserted;
        console.log(
          `✅ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
            vectors.length / batchSize
          )} → upserted ${upserted} wektorów`
        );
      } catch (error) {
        console.error(
          `❌ Błąd wysyłki batch ${Math.floor(i / batchSize) + 1}:`,
          error.message
        );
        // Kontynuuj z następnym batchem
      }
    }
  }

  console.log(
    `🎉 Załadowano do Pinecone razem: ${total} wektorów (namespace='${args.namespace}')`
  );

  // Podsumowanie typów danych
  const files_processed = files.map((f) => path.basename(f)).join(", ");
  console.log(`📋 Przetworzone pliki: ${files_processed}`);
  console.log(`🏥 Dane medyczne z cnstomatologii.pl gotowe do wyszukiwania!`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("❌ Błąd uploadu do Pinecone:", e.message);
    process.exit(1);
  });
}
