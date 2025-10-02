import dotenv from "dotenv";
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "fs";
import path from "path";

dotenv.config();

// Funkcja do określania ścieżki backup na podstawie namespace
function getBackupPath(namespace, filename) {
  let backupDir;

  if (namespace.includes("cnstomatologii")) {
    backupDir = "data/cnstomatologii/backups";
  } else if (namespace.includes("tabou")) {
    backupDir = "data/tabou/backups";
  } else if (namespace.includes("products")) {
    backupDir = "data/tabou/backups";
  } else if (namespace.includes("pages")) {
    backupDir = "data/tabou/backups";
  } else {
    backupDir = "data/backups";
  }

  // Utwórz katalog jeśli nie istnieje
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  return path.join(backupDir, filename);
}

// Prosty wrapper na Pinecone v3: inicjalizacja, ensureIndex, upsert i query
export class PineconeClient {
  constructor(options = {}) {
    this.apiKey = process.env.PINECONE_API_KEY;
    this.indexName =
      options.indexName || process.env.PINECONE_INDEX_NAME || "chat-embeddings";
    this.dimension = parseInt(process.env.PINECONE_DIM || "1536", 10);
    this.metric = process.env.PINECONE_METRIC || "cosine";
    this.namespace = process.env.PINECONE_NAMESPACE || "default";
    this.pc = null;
    this.index = null; // referencja do Index (pc.index(name))
  }

  async initialize() {
    if (!this.apiKey) {
      throw new Error("Brak PINECONE_API_KEY w .env");
    }
    if (!this.indexName) {
      throw new Error("Brak PINECONE_INDEX_NAME w .env");
    }

    this.pc = new Pinecone({ apiKey: this.apiKey });

    // Ensure index exists
    await this.ensureIndex();

    // Utwórz referencję do indeksu (bez namespace – dodajemy go przy operacjach)
    this.index = this.pc.index(this.indexName);
    return true;
  }

  async ensureIndex() {
    // Sprawdź listę indeksów i czy istnieje nasz indeks
    const list = await this.pc.listIndexes();
    const exists =
      list.indexes?.some((i) => i.name === this.indexName) || false;
    if (exists) {
      return true;
    }

    // Utwórz indeks
    console.log(
      `📦 Tworzę indeks '${this.indexName}' (dim=${this.dimension}, metric=${this.metric})`
    );
    await this.pc.createIndex({
      name: this.indexName,
      dimension: this.dimension,
      metric: this.metric,
      spec: {
        serverless: {
          cloud: "aws",
          region: process.env.PINECONE_REGION || "us-east-1",
        },
      },
    });

    // Poczekaj aż indeks będzie gotowy
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const d = await this.pc.describeIndex(this.indexName);
      if (d?.status?.ready) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      console.warn("⚠️ Indeks nie zgłosił statusu 'ready', kontynuuję...");
    } else {
      console.log("✅ Indeks jest gotowy");
    }
    return true;
  }

  // Upsert w batchu; vectors: [{ id, values, metadata }]
  async upsertVectors(vectors, namespace) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;
    if (!Array.isArray(vectors) || vectors.length === 0) return { upserted: 0 };

    const idx = this.index.namespace(ns);
    const res = await idx.upsert(vectors);
    const upserted = res?.upsertedCount || vectors.length;
    return { upserted };
  }

  // Proste wyszukiwanie semantyczne po wektorze zapytania
  async semanticSearch(queryVector, topK = 10, filter = undefined, namespace) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;
    const idx = this.index.namespace(ns);

    const res = await idx.query({
      topK,
      vector: queryVector,
      filter,
      includeValues: false,
      includeMetadata: true,
    });

    return res; // { matches: [{ id, score, metadata }, ...] }
  }

  async deleteByFilter(filter, namespace) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;
    const idx = this.index.namespace(ns);
    return idx.deleteMany({ filter });
  }

  // Nowe metody dla backup i replace
  async listVectorsByPrefix(prefix, namespace, limit = 1000) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;
    const idx = this.index.namespace(ns);

    try {
      // Używamy query z dummyVector żeby pobrać ID-ki z prefixem
      const dummyVector = new Array(this.dimension).fill(0.1);
      const results = await idx.query({
        topK: limit,
        vector: dummyVector,
        filter: { id: { $regex: `^${prefix}` } },
        includeValues: true,
        includeMetadata: true,
      });
      return results.matches || [];
    } catch (error) {
      console.warn(
        `Nie można pobrać wektorów z prefixem ${prefix}:`,
        error.message
      );
      return [];
    }
  }

  async deleteNamespace(namespace) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;
    const idx = this.index.namespace(ns);

    try {
      // Delete wszystkie wektory w namespace
      await idx.deleteAll();
      console.log(`🗑️ Usunięto wszystkie wektory z namespace: ${ns}`);
      return true;
    } catch (error) {
      console.error(`Błąd podczas usuwania namespace ${ns}:`, error.message);
      return false;
    }
  }

  async backupNamespace(namespace, backupFile) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;

    try {
      console.log(`📦 Tworzę backup namespace '${ns}'...`);

      // Pobierz statystyki namespace
      const stats = await this.index.describeIndexStats();
      const namespaceStats = stats.namespaces?.[ns];

      if (!namespaceStats || namespaceStats.recordCount === 0) {
        console.log(`⚠️ Namespace '${ns}' jest pusty, pomijam backup`);
        return { vectors: [], count: 0 };
      }

      console.log(
        `📊 Namespace '${ns}' zawiera ${namespaceStats.recordCount} wektorów`
      );

      // Dla celów backup - pobierzemy próbkę wektorów (Pinecone ma ograniczenia na query)
      const dummyVector = new Array(this.dimension).fill(0.1);
      const results = await this.index.namespace(ns).query({
        topK: Math.min(namespaceStats.recordCount, 1000), // Max 1000 na raz
        vector: dummyVector,
        includeValues: true,
        includeMetadata: true,
      });

      const vectors = results.matches || [];

      if (backupFile) {
        // Użyj getBackupPath jeśli backupFile to tylko nazwa pliku, nie pełna ścieżka
        const finalBackupPath =
          backupFile.includes("/") || backupFile.includes("\\")
            ? backupFile
            : getBackupPath(ns, backupFile);

        const backupData = {
          timestamp: new Date().toISOString(),
          namespace: ns,
          indexName: this.indexName,
          count: vectors.length,
          totalCount: namespaceStats.recordCount,
          vectors: vectors,
        };

        fs.writeFileSync(finalBackupPath, JSON.stringify(backupData, null, 2));
        console.log(
          `💾 Backup zapisany: ${finalBackupPath} (${vectors.length} wektorów)`
        );
      }

      return {
        vectors,
        count: vectors.length,
        totalCount: namespaceStats.recordCount,
      };
    } catch (error) {
      console.error(`Błąd podczas backup namespace ${ns}:`, error.message);
      throw error;
    }
  }

  async replaceNamespace(namespace, vectors, createBackup = true) {
    if (!this.index)
      throw new Error("PineconeClient nie jest zainicjalizowany");
    const ns = namespace || this.namespace;

    try {
      // 1. Utwórz backup jeśli requested
      if (createBackup) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFilename = `backup_${ns}_${timestamp}.json`;
        const backupPath = getBackupPath(ns, backupFilename);
        await this.backupNamespace(ns, backupPath);
      }

      // 2. Usuń obecne dane
      await this.deleteNamespace(ns);

      // 3. Poczekaj chwilę na propagację
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 4. Wgraj nowe dane
      if (vectors && vectors.length > 0) {
        console.log(`📤 Wgrywam ${vectors.length} nowych wektorów...`);
        const result = await this.upsertVectors(vectors, ns);
        console.log(
          `✅ Zastąpiono namespace '${ns}' - ${result.upserted} wektorów`
        );
        return result;
      } else {
        console.log(`✅ Namespace '${ns}' został wyczyszczony`);
        return { upserted: 0 };
      }
    } catch (error) {
      console.error(`Błąd podczas replace namespace ${ns}:`, error.message);
      throw error;
    }
  }
}
