// Sprawdzenie danych o kolorach w plikach embedding
import fs from "fs";

console.log("🔍 SPRAWDZANIE DANYCH O KOLORACH...\n");

// Sprawdź wszystkie pliki embedding
const files = [
  "tabou.json",
  "tabou_part10.json",
  "tabou_part11.json",
  "tabou_part12.json",
];

files.forEach((fileName) => {
  try {
    const data = JSON.parse(fs.readFileSync(`data/${fileName}`, "utf8"));
    console.log(`📁 ${fileName}:`);

    let productCount = 0;
    let colorCount = 0;

    data.forEach((doc) => {
      if (doc.metadata && (doc.metadata.price || doc.text.includes("zł"))) {
        productCount++;

        if (doc.metadata.colors && doc.metadata.colors.length > 0) {
          colorCount++;
          // Pokaż pierwszy produkt z kolorami jako przykład
          if (colorCount === 1) {
            console.log(`  🎨 Przykład: ${doc.text.slice(0, 50)}...`);
            console.log(`     Kolory: ${doc.metadata.colors.join(", ")}`);
            console.log(
              `     Dostępność: ${doc.metadata.availability || "brak"}`
            );
          }
        }
      }
    });

    console.log(`  📊 Produktów: ${productCount}, z kolorami: ${colorCount}`);
    console.log("");
  } catch (err) {
    console.log(`  ❌ Błąd odczytu ${fileName}: ${err.message}`);
  }
});

// Sprawdź konkretne produkty ROCKET i MISS
console.log("🔍 SZUKANIE KONKRETNYCH PRODUKTÓW...\n");

const searchTerms = ["ROCKET CS ALU", "MISS CS ALU", "ROCKET CS", "MISS CS"];

searchTerms.forEach((term) => {
  console.log(`🔎 Szukam: ${term}`);

  files.forEach((fileName) => {
    try {
      const data = JSON.parse(fs.readFileSync(`data/${fileName}`, "utf8"));

      const found = data.filter(
        (doc) => doc.text && doc.text.toUpperCase().includes(term)
      );

      if (found.length > 0) {
        console.log(`  📄 ${fileName}: ${found.length} wyników`);
        found.forEach((doc, i) => {
          if (i < 2) {
            // Pokaż tylko 2 pierwsze
            console.log(`    ${i + 1}. ${doc.text.slice(0, 60)}...`);
            if (doc.metadata) {
              if (doc.metadata.colors)
                console.log(`       Kolory: ${doc.metadata.colors.join(", ")}`);
              if (doc.metadata.availability)
                console.log(`       Dostępność: ${doc.metadata.availability}`);
              if (doc.metadata.price)
                console.log(`       Cena: ${doc.metadata.price}`);
            }
          }
        });
      }
    } catch (err) {
      // Ignoruj błędy
    }
  });
  console.log("");
});
