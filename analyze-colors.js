import fs from 'fs';

try {
  const data = JSON.parse(fs.readFileSync('data/scraped_data.json', 'utf8'));
  const produkty = data.filter(d => d.type === 'product');

  console.log('🎨 ANALIZA KOLORÓW ROWERÓW TABOU:');
  console.log('=====================================');

  const wszystkieKolory = new Map();

  produkty.forEach(produkt => {
    if (produkt.colors && produkt.colors.length > 0) {
      produkt.colors.forEach(kolor => {
        if (kolor && kolor.trim()) {
          const colorKey = kolor.toLowerCase().trim();
          wszystkieKolory.set(colorKey, (wszystkieKolory.get(colorKey) || 0) + 1);
        }
      });
    }
  });

  console.log(`📊 Produktów z kolorami: ${produkty.filter(p => p.colors && p.colors.length > 0).length} z ${produkty.length}`);
  console.log('');

  if (wszystkieKolory.size > 0) {
    console.log('🏆 TOP KOLORY (według popularności):');
    const sortowaneKolory = Array.from(wszystkieKolory.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    
    sortowaneKolory.forEach((kolor, index) => {
      console.log(`${index + 1}. ${kolor[0]} - ${kolor[1]} razy`);
    });
  } else {
    console.log('❌ Nie znaleziono informacji o kolorach');
  }

  // Pokaż też przykłady produktów z kolorami
  console.log('\n📋 PRZYKŁADY PRODUKTÓW Z KOLORAMI:');
  produkty.filter(p => p.colors && p.colors.length > 0).slice(0, 5).forEach(produkt => {
    console.log(`• ${produkt.name}: ${produkt.colors.join(', ')}`);
  });

} catch (error) {
  console.error('Błąd:', error.message);
}