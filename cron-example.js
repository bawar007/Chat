#!/usr/bin/env node
/**
 * Przykład demonstracyjny CRON JOB do automatycznego scrapingu
 *
 * Ten plik pokazuje jak używać node-cron do automatycznego scrapingu
 * Uruchamia się o 12:00 i 23:59 każdego dnia
 */

import cron from "node-cron";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";

const execPromise = promisify(exec);

// =================================================================
// FUNKCJA CRON DO AUTOMATYCZNEGO SCRAPINGU CNS
// =================================================================

async function croneScrapperCns() {
  try {
    console.log("🕐 CRON: Rozpoczynam automatyczny scraping CNS...");

    // Scraping sitemap
    console.log("📋 CRON: Scraping sitemap...");
    const sitemapResult = await execPromise("npm run scrape:cns");
    console.log("✅ CRON: Sitemap zakończony");

    // Scraping pages
    console.log("📄 CRON: Scraping pages...");
    const pagesResult = await execPromise(
      "node cnstomatologii/cnstomatologii-pages-scraper.js"
    );
    console.log("✅ CRON: Pages zakończony");

    // Generowanie embeddingów
    console.log("🧠 CRON: Generowanie embeddingów...");
    const embedResult = await execPromise("npm run embed:cns");
    console.log("✅ CRON: Embeddingi zakończone");

    // Upload do Pinecone
    console.log("📌 CRON: Upload do Pinecone...");
    const uploadResult = await execPromise("npm run pinecone:upload:cns");
    console.log("✅ CRON: Upload zakończony");

    console.log("🎉 CRON: Automatyczny scraping CNS zakończony pomyślnie!");

    // Zapisz log sukcesu
    const logEntry = {
      timestamp: new Date().toISOString(),
      status: "success",
      type: "cron-scraping-cns",
      message: "Automatyczny scraping CNS zakończony pomyślnie",
    };

    // Zapisz log do pliku
    saveLog(logEntry);
  } catch (error) {
    console.error("❌ CRON: Błąd podczas automatycznego scrapingu CNS:", error);

    // Zapisz log błędu
    const logEntry = {
      timestamp: new Date().toISOString(),
      status: "error",
      type: "cron-scraping-cns",
      message: error.message,
      stderr: error.stderr || null,
    };

    // Zapisz log do pliku
    saveLog(logEntry);
  }
}

// Funkcja pomocnicza do zapisywania logów
function saveLog(logEntry) {
  try {
    const logFile = "data/cron-logs.json";

    // Upewnij się że katalog data istnieje
    if (!fs.existsSync("data")) {
      fs.mkdirSync("data", { recursive: true });
    }

    let logs = [];
    if (fs.existsSync(logFile)) {
      logs = JSON.parse(fs.readFileSync(logFile, "utf8"));
    }

    logs.push(logEntry);

    // Zachowaj tylko ostatnie 50 logów
    if (logs.length > 50) {
      logs = logs.slice(-50);
    }

    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    console.log("📝 Log zapisany do:", logFile);
  } catch (error) {
    console.error("❌ Błąd zapisywania logu:", error.message);
  }
}

// =================================================================
// HARMONOGRAM CRON
// =================================================================

console.log("⏰ Konfiguracja harmonogramu CRON...");

// WZORCE CRON:
// Sekunda Minuta Godzina DzieńMiesiąca Miesiąc DzieńTygodnia
// *       *      *      *            *     *
//
// Przykłady:
// '0 12 * * *'     - o 12:00 każdego dnia
// '59 23 * * *'    - o 23:59 każdego dnia
// '0 */6 * * *'    - co 6 godzin
// '0 9 * * 1-5'    - o 9:00 od poniedziałku do piątku
// '30 14 * * 0'    - o 14:30 w niedzielę

// Harmonogram 1: Scraping o 12:00
cron.schedule(
  "0 12 * * *",
  () => {
    console.log("🕐 CRON TRIGGER: Uruchamiam scraping CNS o 12:00");
    croneScrapperCns();
  },
  {
    scheduled: true,
    timezone: "Europe/Warsaw",
    name: "cron-scraping-12",
  }
);

// Harmonogram 2: Scraping o 23:59
cron.schedule(
  "59 23 * * *",
  () => {
    console.log("🕐 CRON TRIGGER: Uruchamiam scraping CNS o 23:59");
    croneScrapperCns();
  },
  {
    scheduled: true,
    timezone: "Europe/Warsaw",
    name: "cron-scraping-2359",
  }
);

// Dodatkowy harmonogram testowy - co minutę (do testów)
// Odkomentuj jeśli chcesz testować
/*
cron.schedule('* * * * *', () => {
  console.log('🧪 TEST CRON: Uruchamiam test co minutę');
  console.log('Aktualny czas:', new Date().toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw'
  }));
}, {
  scheduled: true,
  timezone: "Europe/Warsaw",
  name: "test-cron"
});
*/

console.log("✅ CRON: Harmonogram ustawiony!");
console.log("📅 Scraping CNS będzie uruchamiany:");
console.log("   🕐 Codziennie o 12:00");
console.log("   🕚 Codziennie o 23:59");
console.log("🌍 Strefa czasowa: Europe/Warsaw");

// Informacje o aktualnym czasie
console.log(
  "🕰️  Aktualny czas:",
  new Date().toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
);

// Test ręcznego uruchomienia (odkomentuj jeśli chcesz przetestować)
// console.log("🧪 Uruchamiam test funkcji...");
// croneScrapperCns();

// =================================================================
// ZARZĄDZANIE CRON JOBS
// =================================================================

// Funkcja do wyświetlania wszystkich aktywnych cron jobs
function showActiveCronJobs() {
  const tasks = cron.getTasks();
  console.log("📋 Aktywne CRON jobs:");
  tasks.forEach((task, name) => {
    console.log(`   📌 ${name}: ${task.getStatus()}`);
  });
}

// Funkcja do zatrzymania konkretnego cron job
function stopCronJob(name) {
  const task = cron.getTasks().get(name);
  if (task) {
    task.stop();
    console.log(`⏹️  Zatrzymano CRON job: ${name}`);
  } else {
    console.log(`❌ Nie znaleziono CRON job: ${name}`);
  }
}

// Funkcja do uruchomienia konkretnego cron job
function startCronJob(name) {
  const task = cron.getTasks().get(name);
  if (task) {
    task.start();
    console.log(`▶️  Uruchomiono CRON job: ${name}`);
  } else {
    console.log(`❌ Nie znaleziono CRON job: ${name}`);
  }
}

// Pokaż aktywne jobs po 5 sekundach
setTimeout(() => {
  showActiveCronJobs();
}, 5000);

// =================================================================
// UTRZYMANIE PROCESU
// =================================================================

// Funkcja do graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Otrzymano sygnał SIGINT, zatrzymuję CRON jobs...");

  const tasks = cron.getTasks();
  tasks.forEach((task, name) => {
    task.stop();
    console.log(`⏹️  Zatrzymano: ${name}`);
  });

  console.log("👋 CRON daemon zatrzymany");
  process.exit(0);
});

console.log("🔄 CRON daemon uruchomiony. Naciśnij Ctrl+C aby zatrzymać.");

// Eksportuj funkcje dla użycia w innych plikach
export { croneScrapperCns, showActiveCronJobs, stopCronJob, startCronJob };
