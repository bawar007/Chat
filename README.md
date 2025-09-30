/# Chat System z integracją Pinecone

System chatbot z wyszukiwaniem semantycznym produktów, obsługujący zarówno lokalne embeddingi jak i Pinecone jako bazę wektorową.

## 🚀 Funkcje

- **Scraping stron** - automatyczne pobieranie danych z witryn internetowych
- **Przetwarzanie danych** - czyszczenie i strukturyzacja danych produktów
- **Embeddingi OpenAI** - generowanie embeddingów z modelu text-embedding-3-small
- **Lokalne przechowywanie** - zapisywanie embeddingów w plikach JSON
- **CLI do embeddingów plików** - narzędzie `embed-file.js` do generowania embeddingów z dowolnego pliku (JSON/tekst)
- **Pinecone** - opcjonalna integracja z profesjonalną bazą wektorową
- **Semantic Search** - wyszukiwanie podobieństwa kosinusowego
- **Cache** - inteligentne cachowanie embeddingów i odpowiedzi

## 📁 Struktura plików

```
├── crawler.js           # Główny skrypt scraping i generowania embeddingów
├── server.js           # Serwer Express z API chatbota
├── pinecone-client.js  # Klient Pinecone do operacji wektorowych
├── parse-clean-data.js # Czyszczenie i strukturyzacja danych
├── data/
│   ├── clean-data.json      # Czyste dane produktów
│   ├── scraped_data.json    # Surowe dane ze scrapingu
│   └── embedding_build_stats.json # Statystyki embeddingów
├── public/
│   └── chat-widget.html     # Frontend chatbota
└── .env                     # Konfiguracja API keys
```

## ⚙️ Konfiguracja

### 1. Zmienne środowiskowe (.env)

```bash
# OpenAI - wymagane
OPENAI_API_KEY=your_openai_api_key_here

# Pinecone - opcjonalne (jeśli chcesz używać Pinecone)
PINECONE_API_KEY=your_pinecone_api_key_here
PINECONE_INDEX_NAME=chat-embeddings

# Opcjonalnie dla starszych wersji Pinecone
# PINECONE_ENVIRONMENT=your_environment_here
```

### 2. Instalacja zależności

```bash
npm install
```

## 📊 Pinecone - Setup

### 1. Rejestracja konta Pinecone

1. Idź na [pinecone.io](https://www.pinecone.io/)
2. Załóż darmowe konto
3. Stwórz nowy projekt
4. Wygeneruj API key

### 2. Stworzenie indeksu

W Pinecone Console:

- **Nazwa**: `chat-embeddings` (lub inna z .env)
- **Wymiary**: `1536` (dla text-embedding-3-small)
- **Metryka**: `cosine`
- **Cloud**: `gcp-starter` (darmowy tier)

### 3. Konfiguracja

Wklej swój API key do `.env`:

```bash
PINECONE_API_KEY=pcsk_xxxxx...
PINECONE_INDEX_NAME=chat-embeddings
```

## 🔄 Workflow

### Opcja A: Pełny lokalny workflow

```bash
# 1. Scraping danych
node crawler.js
# Wybierz opcję 1: "Tak, rozpocznij scraping stron"

# 2. Czyszczenie danych
node parse-clean-data.js

# 3. Generowanie lokalnych embeddingów
node crawler.js
# Wybierz opcję 5: "Rozpocznij embedding z pliku clean-data.json"

# 4. Start serwera
node server.js

### Generowanie embeddingów z pliku (CLI)

Możesz wygenerować embeddingi z dowolnego pliku (JSON lub czysty tekst) korzystając z `embed-file.js`.

Parametry:

- `--in, -i` – ścieżka do pliku wejściowego (wymagane)
- `--out, -o` – ścieżka do pliku wyjściowego (domyślnie `<plik_wej>_embbed.json`)
- `--field, -f` – dla JSON: nazwa pola z tekstem (domyślnie `text`, fallback: `specificationText`/`description`)
- `--chunk-size` – rozmiar chunku tekstu (domyślnie 1400 znaków)

Przykłady:

1) Tekstowy plik wejściowy:

   npm run embed:file -- --in notes.txt

2) JSON z tablicą obiektów i polem `specificationText`:

   npm run embed:file -- --in data/tabou-products.json --field specificationText

3) Wymuszony plik wyjściowy i mniejsze chunki:

   npm run embed:file -- --in data/tabou-products.json --field specificationText --out data/tabou-products_embbed.json --chunk-size 1000

Po wygenerowaniu, pliki `*_embbed.json` są automatycznie wczytywane przez serwer przy starcie.
```

### Opcja B: Workflow z Pinecone

```bash
# 1. Scraping danych
node crawler.js
# Wybierz opcję 1: "Tak, rozpocznij scraping stron"

# 2. Czyszczenie danych
node parse-clean-data.js

# 3. Upload do Pinecone
node crawler.js
# Wybierz opcję 6: "Prześlij embeddingi do Pinecone (z clean-data.json)"

# 4. Start serwera (automatycznie wykryje Pinecone)
node server.js
```

## 🔍 Logika wyszukiwania

System automatycznie wybiera między wyszukiwaniem:

1. **Pinecone** (jeśli skonfigurowany):

   - Profesjonalna baza wektorowa w chmurze
   - Skalowalna i szybka
   - Zaawansowane filtrowanie
   - Automatyczne sharding

2. **Lokalne embeddingi** (fallback):
   - Pliki JSON z embeddingami
   - Cache w pamięci z LRU
   - Filtrowanie typu dokumentu
   - Sortowanie po cenach

## 📈 Monitorowanie

### Logi serwera

```bash
✅ Pinecone client zainicjalizowany           # Pinecone gotowy
🔍 Używam Pinecone do wyszukiwania...         # Wyszukiwanie w Pinecone
🔍 Używam lokalnego wyszukiwania...           # Fallback do lokalnych plików
🎯 Filtrowanie do produktów tylko w Pinecone  # Filtry zastosowane
```

### Crawler logi

```bash
📊 Przygotowano X produktów do przesłania     # Produkty gotowe
✅ Batch 1/5 przesłany (100 embeddingów)     # Progress upload
✅ Embeddingi zostały pomyślnie przesłane do Pinecone!
```

## 🔧 Troubleshooting

### Błędy Pinecone

1. **"API key invalid"**

   ```bash
   # Sprawdź .env
   cat .env | grep PINECONE_API_KEY
   ```

2. **"Index not found"**

   ```bash
   # Sprawdź nazwę indeksu w Pinecone Console
   # Upewnij się że PINECONE_INDEX_NAME w .env jest poprawne
   ```

3. **"Dimension mismatch"**
   ```bash
   # Indeks musi mieć 1536 wymiarów dla text-embedding-3-small
   # Stwórz nowy indeks z właściwymi wymiarami
   ```

### Fallback do lokalnego

Jeśli Pinecone nie działa, system automatycznie przełączy się na lokalne embeddingi:

```bash
❌ Błąd Pinecone, fallback do lokalnego wyszukiwania: [error]
🔍 Używam lokalnego wyszukiwania...
```

## 💡 Zalety Pinecone vs Lokalne

### Pinecone ✅

- Skalowalna baza wektorowa w chmurze
- Szybkie wyszukiwanie nawet dla milionów wektorów
- Zaawansowane filtrowanie metadanych
- Automatyczne sharding i load balancing
- Backup i disaster recovery
- RESTful API

### Lokalne ✅

- Brak zależności zewnętrznych
- Pełna kontrola nad danymi
- Zero kosztów operacyjnych
- Szybkie dla małych zbiorów danych
- Offline capability

## 🎯 Optymalizacje

### Pinecone

- **Batch upload**: 100 wektorów na raz
- **Retry logic**: Automatyczne ponowienie przy błędach
- **Connection pooling**: Efektywne wykorzystanie połączeń
- **Metadata filtering**: Filtrowanie po typie, kategorii, dostępności

### Lokalne

- **LRU Cache**: Inteligentne cachowanie embeddingów
- **Pre-normalizacja**: Wektory znormalizowane przy starcie
- **Targeted scanning**: Ograniczanie skanowania do 400 dokumentów
- **Type filtering**: Filtrowanie general/FAQ dla zapytań produktowych

## 🚀 Skalowanie produkcyjne

Dla dużych zbiorów danych (>10k produktów) zalecamy Pinecone:

1. **Większy indeks**: Zwiększ plan Pinecone
2. **Batch processing**: Prześlij dane w większych batchach
3. **Monitoring**: Dodaj metryki wydajności
4. **Caching**: Redis dla cache odpowiedzi
5. **Load balancing**: Multiple server instances

## 📞 Support

W przypadku problemów sprawdź:

1. Logi w konsoli (`node server.js`)
2. Konfigurację .env
3. Status indeksu w Pinecone Console
4. Dostępność API OpenAI

## 📚 Strony informacyjne (FAQ, gwarancja)

Chcesz wzbogacić chatbota o treści nienależące do produktów (np. FAQ, warunki gwarancji, dostawa)?

1. Zbierz strony z sitemap:

- Wszystkie: `npm run scrape:pages`
- Testowo: `npm run scrape:pages:test`

Wynik: `data/tabou-pages.json` (z pominięciem stron: zamowienie, koszyk, blog, archiwum-produktow/archowum-produktow, huis, rowery, produkty, porownaj, moje-konto oraz kart produktów).

2. Zrób embeddingi stron:

- `node embed-file.js --in data/tabou-pages.json`

3. (Opcjonalnie) załaduj do Pinecone:

- `npm run pinecone:upload`

Dokumenty te będą miały `type: "page"`, więc mogą być filtrowane niezależnie od `product`.
