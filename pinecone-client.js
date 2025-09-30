import dotenv from "dotenv";
import { Pinecone } from "@pinecone-database/pinecone";

dotenv.config();

// Prosty wrapper na Pinecone v3: inicjalizacja, ensureIndex, upsert i query
export class PineconeClient {
  constructor() {
    this.apiKey = process.env.PINECONE_API_KEY;
    this.indexName = process.env.PINECONE_INDEX_NAME || "chat-embeddings";
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
}
