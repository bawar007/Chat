// Kopia zapasowa server.js, aby przywrócić gdy server.js był uszkodzony

import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.json());

// Serwuj pliki statyczne z katalogu public
app.use(express.static("public"));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

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
    const partFiles = files.filter(file => file.match(/^tabou_part\d+\.json$/));
    
    let totalPartDocs = 0;
    
    for (const partFile of partFiles) {
      try {
        console.log(`📂 Szukam pliku: ${dataDir}/${partFile}`);
        const partData = JSON.parse(fs.readFileSync(path.join(dataDir, partFile), "utf8"));
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
      console.log(`📁 Łącznie wczytano ${totalPartDocs} dokumentów z ${partFiles.length} plików części`);
    }
  } catch (err) {
    console.warn("⚠️ Błąd odczytu katalogu data:", err.message);
  }
  
  return allDocs;
}

// Wczytujemy dane z pliku/plików JSON z obsługą błędów
let docs = [];
let crawlStats = {};

docs = loadAllEmbeddingFiles();

if (docs.length === 0) {
  console.error("❌ Nie znaleziono żadnych plików z embeddingami!");
  console.log("💡 Uruchom najpierw: npm run crawl");
  process.exit(1);
} else {
  console.log(`🎉 ŁĄCZNIE WCZYTANO: ${docs.length} dokumentów z embeddingami`);
}

try {
  crawlStats = JSON.parse(fs.readFileSync("data/crawl_stats.json", "utf8"));
  console.log("📊 Statystyki crawlingu:", crawlStats.pageTypes);
} catch (err) {
  console.warn("⚠️ Brak pliku statystyk crawlingu");
}

async function getEmbedding(text) {
  try {
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
    
    return data.data[0].embedding;
  } catch (error) {
    console.error("❌ Błąd podczas tworzenia embedding:", error);
    return null;
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: "Brak wiadomości" });
    }

    // Domyślny sessionId jeśli nie podano
    const currentSessionId = sessionId || 'default_session_' + Date.now();
    
    // Pobierz historię konwersacji dla sesji
    const conversationHistory = getSessionHistory(currentSessionId);
    console.log(`💭 Sesja ${currentSessionId}: historia ${conversationHistory.length} wymian`);

    console.log(`❓ Pytanie: ${message}`);

    const queryEmbedding = await getEmbedding(message);
    if (!queryEmbedding) {
      return res.status(500).json({ error: "Nie udało się przetworzyć zapytania" });
    }

    // Dodatkowe filtrowanie: jeśli pytanie ewidentnie dotyczy produktu, 
    // odfiltrowuj dokumenty general i FAQ
    const query = message.toLowerCase();
    let candidateDocs = docs;
    
    const isProductQuery = query.match(/rower|bike|trek|giant|specialized|kask|hamulce|przerzutka|koła|rama|cena|koszt|ile|kupić|sprzedaż|produkt|model|dostępny|najtańszy|najdroższy/);
    
    if (isProductQuery) {
      // Filtruj dokumenty aby wykluczyć general i FAQ gdy pytanie jest o produkt
      const filteredDocs = docs.filter(doc => {
        const type = doc.metadata?.type || 'unknown';
        return type !== 'general' && type !== 'faq';
      });
      
      // Użyj filtrowanych dokumentów jeśli mamy wystarczająco produktów/kategorii
      if (filteredDocs.length >= 5) {
        candidateDocs = filteredDocs;
        console.log(`🎯 Filtrowanie general/FAQ: ${docs.length} → ${candidateDocs.length} dokumentów`);
      }
    }

    const ranked = candidateDocs
      .map((d) => ({
        ...d,
        score: cosineSimilarity(queryEmbedding, d.embedding),
      }))
      .sort((a, b) => {
        // Sprawdź czy klient prosi o sortowanie po cenie
        if (query.toLowerCase().match(/tańsze|taniej|najtańsze|budżetowe|po cenie|do.*zł/)) {
          const extractPrice = (doc) => {
            const priceMatch = doc.text.match(/(\d+(?:[\s.,]\d{3})*)\s*zł/);
            return priceMatch ? parseFloat(priceMatch[1].replace(/[\s.,]/g, '')) : Infinity;
          };
          
          const priceA = extractPrice(a);
          const priceB = extractPrice(b);
          
          if (priceA !== Infinity && priceB !== Infinity) {
            return priceA - priceB; // sortuj po cenie rosnąco
          }
        }
        
        return b.score - a.score; // domyślnie po podobieństwie
      })
      .slice(0, 15);

    console.log(`🔍 Wybrano ${ranked.length} najlepszych dopasowań (score: ${ranked[0]?.score.toFixed(3)} - ${ranked[ranked.length-1]?.score.toFixed(3)})`);

    // Grupowanie wyników według typu dla lepszej organizacji
    const groupedResults = {};
    ranked.forEach(doc => {
      const type = doc.metadata?.type || 'other';
      if (!groupedResults[type]) {
        groupedResults[type] = [];
      }
      groupedResults[type].push(doc);
    });

    console.log('📊 Typy dokumentów:', Object.keys(groupedResults).map(type => `${type}(${groupedResults[type].length})`).join(', '));

    const contextParts = [];
    
    // Sprawdź czy są produkty niedostępne i znajdź alternatywy
    const unavailableProducts = ranked.filter(doc => {
      const isProduct = doc.metadata?.type === 'product';
      const isUnavailable = doc.metadata?.availability && 
        (doc.metadata.availability.toLowerCase().includes('niedostępny') ||
         doc.metadata.availability.toLowerCase().includes('brak'));
      return isProduct && isUnavailable;
    });
    
    if (unavailableProducts.length > 0) {
      console.log(`🔄 Znaleziono ${unavailableProducts.length} niedostępnych produktów, szukam alternatyw...`);
      
      for (const unavailableProduct of unavailableProducts.slice(0, 2)) { // Max 2 niedostępne produkty
        // Znajdź podobne dostępne produkty
        const alternatives = docs.filter(doc => {
          const isProduct = doc.metadata?.type === 'product';
          const isAvailable = !doc.metadata?.availability || 
            (!doc.metadata.availability.toLowerCase().includes('niedostępny') &&
             !doc.metadata.availability.toLowerCase().includes('brak'));
          const isDifferent = doc.metadata?.url !== unavailableProduct.metadata?.url;
          
          return isProduct && isAvailable && isDifferent;
        })
        .map(doc => ({
          ...doc,
          score: cosineSimilarity(unavailableProduct.embedding, doc.embedding)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (alternatives.length > 0) {
        console.log(`✅ Znaleziono ${alternatives.length} alternatyw dla niedostępnego produktu`);
        
        // Dodaj alternatywy do kontekstu
        contextParts.push("🔄 ALTERNATYWY DLA NIEDOSTĘPNYCH PRODUKTÓW:");
        alternatives.forEach((alt, index) => {
          let limitedText = alt.text.length > 400 ? alt.text.substring(0, 400) + "..." : alt.text;
          contextParts.push(`Alternatywa ${index + 1}: ${limitedText}`);
        });
      }
    }
  }

    for (const [type, docs] of Object.entries(groupedResults)) {
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

      docs.forEach((d, index) => {
        // Ograniczamy długość tekstu do 800 znaków na dokument
        let limitedText = d.text.length > 800 ? d.text.substring(0, 800) + "..." : d.text;
        let docInfo = `${limitedText}`;

        // Dodaj metadane jeśli dostępne (w skróconej formie)
        if (d.metadata) {
          if (d.metadata.title) docInfo += `\nTytuł: ${d.metadata.title}`;
          if (d.metadata.price) docInfo += `\nCena: ${d.metadata.price}`;
          if (d.metadata.availability)
            docInfo += `\nDostępność: ${d.metadata.availability}`;
          if (d.metadata.colors && d.metadata.colors.length > 0)
            docInfo += `\nKolory: ${d.metadata.colors.slice(0, 3).join(", ")}${d.metadata.colors.length > 3 ? "..." : ""}`;
          if (d.metadata.frameSize) docInfo += `\nRozmiar ramy: ${d.metadata.frameSize}`;
          if (d.metadata.bikeType) docInfo += `\nTyp: ${d.metadata.bikeType}`;
          if (d.metadata.specifications) {
            const specs = Object.entries(d.metadata.specifications).slice(0, 3)
              .map(([k, v]) => `${k}: ${v}`).join(", ");
            if (specs) docInfo += `\nSpec: ${specs}`;
          }
          if (d.metadata.url) docInfo += `\nURL: ${d.metadata.url}`;
        }

        contextParts.push(docInfo);
      });

      contextParts.push(""); // Pusta linia między sekcjami
    }

    let context = contextParts.join("\n");
    
    // Kontrola długości kontekstu - maksymalnie 80,000 znaków (~60k tokenów)
    const MAX_CONTEXT_LENGTH = 80000;
    if (context.length > MAX_CONTEXT_LENGTH) {
      context = context.substring(0, MAX_CONTEXT_LENGTH) + "\n\n[Kontekst skrócony z powodu limitu długości]";
      console.log(`⚠️ Kontekst skrócony z ${contextParts.join("\n").length} do ${context.length} znaków`);
    }

    console.log(
      `📝 Przygotowano kontekst o długości: ${context.length} znaków`
    );

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

${conversationHistory.length > 0 ? `Historia konwersacji:
${conversationHistory.map((item, index) => 
  `${index + 1}. Klient: ${item.user}\n   Bot: ${item.bot}`
).join('\n')}\n` : ''}
Aktualne pytanie klienta: ${message}`,
          },
        ],
        max_tokens: 1000,
        temperature: 0.6,
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error("❌ Błąd API OpenAI:", data.error);
      return res.status(500).json({ error: "Błąd generowania odpowiedzi" });
    }

    const reply = data.choices[0].message.content;
    console.log(`✅ Wygenerowano odpowiedź o długości: ${reply.length} znaków`);

    // Zapisz do pamięci sesji
    addToSession(currentSessionId, message, reply);
    console.log(`💾 Zapisano do sesji ${currentSessionId} (historia: ${conversationHistory.length + 1} wymian)`);

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
    crawlStats: crawlStats,
    lastCrawl: crawlStats.scrapedAt || "Nieznane",
  });
});

app.listen(3000, () => console.log("✔ Chat działa na http://localhost:3000"));