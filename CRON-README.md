# 🕐 CRON JOB - Automatyczny Scraping CNS

## 📋 Opis

System automatycznego scrapingu dla cnstomatologii.pl z użyciem CRON JOB.
Uruchamia się automatycznie o **12:00** i **23:59** każdego dnia.

## 🚀 Sposoby uruchomienia

### 1. **Jako część serwera** (zalecane)

```bash
npm start
```

Cron jest wbudowany w server.js i uruchamia się automatycznie.

### 2. **Jako oddzielny proces cron**

```bash
npm run cron
```

Uruchamia oddzielny daemon z CRON jobami.

### 3. **Ręczne uruchomienie przez API**

```bash
curl -X POST http://localhost:3000/api/run-cron
```

## ⏰ Harmonogram

| Godzina   | Opis               | Cron Expression |
| --------- | ------------------ | --------------- |
| **12:00** | Codzienny scraping | `0 12 * * *`    |
| **23:59** | Codzienny scraping | `59 23 * * *`   |

## 📊 Monitoring i Logi

### 1. **Sprawdzenie logów CRON**

```bash
curl http://localhost:3000/api/cron-logs
```

### 2. **Plik logów**

```
data/cron-logs.json
```

### 3. **Status w konsoli**

Logi pojawiają się bezpośrednio w konsoli serwera.

## 🔧 Konfiguracja CRON

### Wyrażenia CRON

```
┌───────────── minuta (0 - 59)
│ ┌─────────── godzina (0 - 23)
│ │ ┌───────── dzień miesiąca (1 - 31)
│ │ │ ┌─────── miesiąc (1 - 12)
│ │ │ │ ┌───── dzień tygodnia (0 - 7) (niedziela = 0 lub 7)
│ │ │ │ │
* * * * *
```

### Przykłady harmonogramów

```javascript
// Co godzinę
cron.schedule('0 * * * *', () => { ... });

// Co 6 godzin
cron.schedule('0 */6 * * *', () => { ... });

// Poniedziałek-Piątek o 9:00
cron.schedule('0 9 * * 1-5', () => { ... });

// W niedzielę o 14:30
cron.schedule('30 14 * * 0', () => { ... });

// Co minutę (testy)
cron.schedule('* * * * *', () => { ... });
```

## 🛠️ Funkcje

### `croneScrapperCns()`

Główna funkcja wykonująca:

1. **Scraping sitemap** - `npm run scrape:cns`
2. **Scraping pages** - `node cnstomatologii/cnstomatologii-pages-scraper.js`
3. **Generowanie embeddingów** - `npm run embed:cns`
4. **Upload do Pinecone** - `npm run pinecone:upload:cns`
5. **Zapisywanie logów** - `data/cron-logs.json`

### Dodatkowe funkcje

- `showActiveCronJobs()` - lista aktywnych zadań
- `stopCronJob(name)` - zatrzymanie zadania
- `startCronJob(name)` - uruchomienie zadania

## 📝 Struktura logów

```json
{
  "timestamp": "2025-10-02T12:00:00.000Z",
  "status": "success",
  "type": "cron-scraping-cns",
  "message": "Automatyczny scraping CNS zakończony pomyślnie"
}
```

## 🔧 API Endpointy

### GET `/api/cron-logs`

Pobierz historię logów CRON (ostatnie 50).

### POST `/api/run-cron`

Ręczne uruchomienie scraping CNS.

### GET `/api/status`

Status serwera (zawiera info o CRON).

## 🐛 Rozwiązywanie problemów

### 1. **CRON nie uruchamia się**

```bash
# Sprawdź czy serwer działa
curl http://localhost:3000/api/status

# Sprawdź logi
curl http://localhost:3000/api/cron-logs
```

### 2. **Błędy w logach**

Sprawdź `data/cron-logs.json` - zawiera szczegóły błędów.

### 3. **Testowanie harmonogramu**

Odkomentuj w `cron-example.js` sekcję testową (co minutę).

### 4. **Strefa czasowa**

CRON używa `Europe/Warsaw`. Sprawdź aktualny czas:

```javascript
console.log(
  new Date().toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
  })
);
```

## 🔄 Zatrzymywanie CRON

### W trybie serwera

```bash
Ctrl+C  # Zatrzymuje serwer i wszystkie cron jobs
```

### W trybie oddzielnego procesu

```bash
Ctrl+C  # Graceful shutdown z zatrzymaniem wszystkich zadań
```

## 📦 Wymagane pakiety

```json
{
  "node-cron": "^4.2.1",
  "express": "^4.19.2"
}
```

## 🚨 Ważne uwagi

1. **Backup** - Cron używa `--replace` więc tworzy automatyczne backupy
2. **Logi** - Ograniczone do 50 ostatnich wpisów
3. **Timezone** - Ustawiona na Europe/Warsaw
4. **Błędy** - Nie przerywają działania serwera
5. **Równoległość** - Jeden scraping na raz (nie nakładają się)

## 📈 Przykład użycia

```javascript
import cron from "node-cron";

// Uruchom funkcję o 12:00 każdego dnia
cron.schedule(
  "0 12 * * *",
  () => {
    console.log("🕐 Uruchamiam scraping o 12:00");
    croneScrapperCns();
  },
  {
    scheduled: true,
    timezone: "Europe/Warsaw",
  }
);
```
