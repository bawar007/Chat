// Test konkretnego zapytania do serwera
import fetch from "node-fetch";

async function testProductQuery() {
  try {
    console.log("🧪 Testowanie zapytania o ROCKET CS ALU...");

    const response = await fetch("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Rower dziecięcy TABOU ROCKET CS ALU kolory",
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    console.log("✅ Odpowiedź serwera:");
    console.log(data.response);
    console.log("\n📊 Metadane:");
    console.log(`- Źródeł: ${data.sources}`);
    console.log(`- Typy: ${data.types ? data.types.join(", ") : "brak"}`);
  } catch (error) {
    console.error("❌ Błąd:", error.message);
  }
}

testProductQuery();
