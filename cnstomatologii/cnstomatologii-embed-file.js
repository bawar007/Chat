import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// Funkcja do chunking tekstu
function chunkText(text, chunkSize = 1500, overlap = 300) {
  if (!text || typeof text !== "string") return [];

  const words = text.split(/\s+/);
  if (words.length <= chunkSize) return [text];

  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    const chunk = words.slice(start, end).join(" ");
    chunks.push(chunk);

    if (end >= words.length) break;
    start = end - overlap;
  }

  return chunks;
}

// Generowanie embeddingu dla tekstu
async function generateEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Brak OPENAI_API_KEY w zmiennych środowiskowych");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } catch (error) {
    console.error("❌ Błąd podczas generowania embeddingu:", error.message);
    throw error;
  }
}

// Parsowanie argumentów CLI
function parseArgs(argv) {
  const args = {
    in: null,
    out: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--in" || a === "-i") && argv[i + 1]) {
      args.in = argv[++i];
    } else if ((a === "--out" || a === "-o") && argv[i + 1]) {
      args.out = argv[++i];
    }
  }

  return args;
}

// Funkcja do analizy i podziału treści dla stron lekarzy
function parseDoctorContent(content, doctorName) {
  // Usuń tylko iframe i podstawowe info kontaktowe
  let cleanContent = content
    .replace(/<iframe[^>]*>.*?<\/iframe>/g, "")
    .replace(/Adres.*?Rejestracja \+48 \d+ \d+ \d+\s*/g, "")
    .replace(/Strona główna\/O nas\/[^\s]+\s*/g, "")
    .trim();

  // Znajdź sekcję opinii - szukaj różnych wariantów
  const opinionsPatterns = [
    /Opinie naszych pacjentów([\s\S]*?)$/,
    /Opinie pacjentów([\s\S]*?)$/,
    /Opinie([\s\S]*?)$/,
  ];

  let opinionsText = "";
  let opinionsMatch = null;

  for (const pattern of opinionsPatterns) {
    opinionsMatch = cleanContent.match(pattern);
    if (opinionsMatch) {
      opinionsText = opinionsMatch[1].trim();
      break;
    }
  }

  // Usuń opinie z głównej treści
  if (opinionsMatch) {
    cleanContent = cleanContent.replace(opinionsMatch[0], "").trim();
  }

  // Znajdź pozycję nazwy lekarza w tekście
  const doctorNameIndex = cleanContent.indexOf(doctorName);
  if (doctorNameIndex === -1) {
    // Jeśli nie ma pełnej nazwy, spróbuj znaleźć po fragmencie
    const nameParts = doctorName.split(" ");
    const lastName = nameParts[nameParts.length - 1];
    const lastNameIndex = cleanContent.indexOf(lastName);

    if (lastNameIndex === -1) {
      console.log(`  ⚠️ Nie znaleziono nazwy lekarza w tekście`);
      return {
        shortDescription: "",
        extendedInfo: cleanContent,
        opinions: opinionsText,
      };
    }
  }

  // Wszystko po nazwie lekarza to informacje o nim
  const afterDoctorName = cleanContent
    .substring(doctorNameIndex + doctorName.length)
    .trim();

  // Znajdź pozycję "Lekarz dentysta" lub podobnych tytułów
  const afterTitle = afterDoctorName
    .replace(
      /^(Lekarz dentysta|Chirurg|Bariatra|Proktolog|Fizjoterapeuta)\s*/,
      ""
    )
    .trim();

  // Podziel tekst na podstawie zdań - pierwszy akapit to krótki opis
  const paragraphs = afterTitle.split(/\n\n+/);
  const shortDescription = paragraphs.length > 0 ? paragraphs[0].trim() : "";
  const extendedInfo =
    paragraphs.length > 1 ? paragraphs.slice(1).join("\n\n").trim() : "";

  return {
    shortDescription: shortDescription,
    extendedInfo: extendedInfo,
    opinions: opinionsText,
  };
}

// Główna funkcja
async function main() {
  const args = parseArgs(process.argv);

  if (!args.in) {
    console.error("❌ Brak parametru --in z plikiem wejściowym");
    console.log(
      "Użycie: node cnstomatologii-embed-file.js --in data/cnstomatologii/cnstomatologii-pages.json [--out output.json]"
    );
    process.exit(1);
  }

  // Określ plik wyjściowy
  if (!args.out) {
    const inputPath = path.parse(args.in);
    args.out = path.join(inputPath.dir, `${inputPath.name}_embbed.json`);
  }

  console.log(`📖 Czytanie danych z: ${args.in}`);

  // Wczytaj dane
  if (!fs.existsSync(args.in)) {
    console.error(`❌ Plik nie istnieje: ${args.in}`);
    process.exit(1);
  }

  const inputData = JSON.parse(fs.readFileSync(args.in, "utf8"));
  console.log(`📄 Wczytano ${inputData.length} stron`);

  const embeddings = [];
  let processedPages = 0;

  for (const page of inputData) {
    console.log(
      `🔄 Przetwarzanie [${++processedPages}/${inputData.length}]: ${page.url}`
    );

    try {
      // Sprawdź czy to strona lekarza
      if (
        page.contentType === "doctor" &&
        page.doctors &&
        page.doctors.length > 0
      ) {
        console.log(`👨‍⚕️ Wykryto stronę lekarza: ${page.doctors[0].name}`);

        // Podziel treść na 3 części
        const doctorParts = parseDoctorContent(
          page.content,
          page.doctors[0].name
        );

        // 1. Krótki opis lekarza
        if (
          doctorParts.shortDescription &&
          doctorParts.shortDescription.length > 20
        ) {
          let content = `LEKARZ: ${page.doctors[0].name}\n`;
          if (page.title) content += `TYTUŁ: ${page.title}\n`;
          content += `KRÓTKI OPIS: ${doctorParts.shortDescription}`;

          console.log(
            `  📝 Generowanie embeddingu - krótki opis (${content.length} znaków)`
          );
          const embedding = await generateEmbedding(content);

          embeddings.push({
            id: `cns-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: content,
            embedding: embedding,
            metadata: {
              url: page.url,
              title: page.title || "",
              contentType: "doctor",
              dataType: "doctor_description",
              doctorName: page.doctors[0].name,
              specialization: page.doctors[0].specialization || "",
              wordCount: content.split(/\s+/).length,
              lastModified: page.lastModified || new Date().toISOString(),
              source: "cnstomatologii.pl",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // 2. Rozszerzone dane o lekarzu
        if (doctorParts.extendedInfo && doctorParts.extendedInfo.length > 30) {
          let content = `LEKARZ: ${page.doctors[0].name}\n`;
          if (page.title) content += `TYTUŁ: ${page.title}\n`;
          content += `DANE ROZSZERZONE O LEKARZU:\n${doctorParts.extendedInfo}`;

          console.log(
            `  📝 Generowanie embeddingu - dane rozszerzone (${content.length} znaków)`
          );
          const embedding = await generateEmbedding(content);

          embeddings.push({
            id: `cns-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: content,
            embedding: embedding,
            metadata: {
              url: page.url,
              title: page.title || "",
              contentType: "doctor",
              dataType: "doctor_details",
              doctorName: page.doctors[0].name,
              specialization: page.doctors[0].specialization || "",
              wordCount: content.split(/\s+/).length,
              lastModified: page.lastModified || new Date().toISOString(),
              source: "cnstomatologii.pl",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // 3. Opinie o lekarzu
        if (doctorParts.opinions && doctorParts.opinions.length > 30) {
          let content = `LEKARZ: ${page.doctors[0].name}\n`;
          if (page.title) content += `TYTUŁ: ${page.title}\n`;
          content += `OPINIE PACJENTÓW O LEKARZU:\n${doctorParts.opinions}`;

          console.log(
            `  📝 Generowanie embeddingu - opinie pacjentów (${content.length} znaków)`
          );
          const embedding = await generateEmbedding(content);

          embeddings.push({
            id: `cns-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: content,
            embedding: embedding,
            metadata: {
              url: page.url,
              title: page.title || "",
              contentType: "doctor",
              dataType: "doctor_reviews",
              doctorName: page.doctors[0].name,
              specialization: page.doctors[0].specialization || "",
              wordCount: content.split(/\s+/).length,
              lastModified: page.lastModified || new Date().toISOString(),
              source: "cnstomatologii.pl",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // 4. Kalendarz i dostępność terminów (jeśli istnieje)
        if (
          page.calendar &&
          (page.calendar.availableSlots.length > 0 ||
            page.calendar.nextAvailableDate)
        ) {
          let content = `LEKARZ: ${page.doctors[0].name}\n`;
          if (page.title) content += `TYTUŁ: ${page.title}\n`;
          content += `DOSTĘPNOŚĆ TERMINÓW I KALENDARZ:\n`;

          if (page.calendar.availableSlots.length > 0) {
            content += `Dostępne terminy:\n`;
            page.calendar.availableSlots.forEach((slot) => {
              content += `- ${slot.time} (${slot.fullLabel})\n`;
            });
          }

          if (page.calendar.nextAvailableDate) {
            content += `Najbliższy wolny termin: ${page.calendar.nextAvailableDate}\n`;
          }

          console.log(
            `  📅 Generowanie embeddingu - kalendarz lekarza (${content.length} znaków)`
          );
          const embedding = await generateEmbedding(content);

          embeddings.push({
            id: `cns-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: content,
            embedding: embedding,
            metadata: {
              url: page.url,
              title: page.title || "",
              contentType: "doctor",
              dataType: "doctor_calendar",
              doctorName: page.doctors[0].name,
              specialization: page.doctors[0].specialization || "",
              availableSlotsCount: page.calendar.availableSlots.length,
              hasNextAvailableDate: !!page.calendar.nextAvailableDate,
              wordCount: content.split(/\s+/).length,
              lastModified: page.lastModified || new Date().toISOString(),
              source: "cnstomatologii.pl",
            },
          });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        // Standardowe przetwarzanie dla innych typów stron
        let content = "";

        // Dodaj tytuł i opis
        if (page.title) content += `TYTUŁ: ${page.title}\n\n`;
        if (page.metaDescription)
          content += `OPIS: ${page.metaDescription}\n\n`;

        // Dodaj nagłówki dla lepszej struktury
        if (page.headings && page.headings.length > 0) {
          content += "STRUKTURA STRONY:\n";
          page.headings.forEach((heading) => {
            content += `${heading.level.toUpperCase()}: ${heading.text}\n`;
          });
          content += "\n";
        }

        // Dodaj informacje o usługach (jeśli istnieją)
        if (page.services && page.services.length > 0) {
          content += "USŁUGI I ZABIEGI:\n";
          page.services.forEach((service) => {
            content += `Usługa: ${service.name}\n`;
            if (service.description)
              content += `Opis: ${service.description}\n`;
            content += "\n";
          });
        }

        // Dodaj główną treść strony
        if (page.content) {
          content += "TREŚĆ STRONY:\n";
          content += page.content;
        }

        if (!content.trim()) {
          console.warn(`⚠️ Brak treści dla: ${page.url}`);
          continue;
        }

        // Podziel na chunki jeśli treść jest długa
        const chunks = chunkText(content, 1500, 300);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];

          console.log(
            `  📝 Generowanie embeddingu dla chunka ${i + 1}/${
              chunks.length
            } (${chunk.length} znaków)`
          );

          // Generuj embedding
          const embedding = await generateEmbedding(chunk);

          // Przygotuj metadane
          const metadata = {
            url: page.url,
            title: page.title || "",
            contentType: page.contentType || "general",
            dataType: "page_content",
            metaDescription: page.metaDescription || "",
            chunkIndex: i,
            totalChunks: chunks.length,
            wordCount: chunk.split(/\s+/).length,
            lastModified: page.lastModified || new Date().toISOString(),
            source: "cnstomatologii.pl",
          };

          // Dodaj specyficzne metadane w zależności od typu strony
          if (
            page.contentType === "service" &&
            page.services &&
            page.services.length > 0
          ) {
            metadata.services = page.services.map((s) => s.name);
          }

          embeddings.push({
            id: `cns-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            text: chunk,
            embedding: embedding,
            metadata: metadata,
          });

          // Krótka pauza między requestami do API
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      console.error(`❌ Błąd przetwarzania ${page.url}:`, error.message);
      continue;
    }
  }

  // Zapisz wyniki
  console.log(
    `💾 Zapisywanie ${embeddings.length} embeddingów do: ${args.out}`
  );

  // Upewnij się, że katalog istnieje
  const outputDir = path.dirname(args.out);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(args.out, JSON.stringify(embeddings, null, 2), "utf8");

  console.log(
    `✅ Gotowe! Wygenerowano ${embeddings.length} embeddingów z ${processedPages} stron`
  );
  console.log(`📂 Plik wyjściowy: ${args.out}`);

  // Statystyki
  const totalWords = embeddings.reduce(
    (sum, emb) => sum + emb.metadata.wordCount,
    0
  );
  console.log(`📊 Statystyki:`);
  console.log(`   - Łączna liczba słów: ${totalWords}`);
  console.log(
    `   - Średnia długość chunka: ${Math.round(
      totalWords / embeddings.length
    )} słów`
  );
  console.log(
    `   - Strony z wieloma chunkami: ${
      embeddings.filter((e) => e.metadata.totalChunks > 1).length
    }`
  );
}

// Uruchom jeśli wywoływany bezpośrednio
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("❌ Nieprzechwycony błąd:", e.message);
    process.exit(1);
  });
}

export { generateEmbedding, chunkText };
export default main;
