// Test czy serwer poprawnie priorytetyzuje produkty
import fetch from 'node-fetch';

async function testColorQuery() {
  try {
    console.log('🧪 Testowanie pytania o kolory...');
    
    const response = await fetch('http://localhost:3000/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Jakie są popularne kolory rowerów TABOU?'
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Odpowiedź otrzymana:');
    console.log(data.response);
    
  } catch (error) {
    console.error('❌ Błąd:', error.message);
  }
}

testColorQuery();