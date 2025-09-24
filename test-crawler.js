// Test crawlera na pojedynczym produkcie - ulepszone selektory
import axios from 'axios';
import * as cheerio from 'cheerio';

async function testSingleProduct(url) {
  try {
    console.log(`\n🧪 TESTOWANIE PRODUKTU: ${url}`);
    console.log('='.repeat(80));
    
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const $ = cheerio.load(response.data);
    
    // Test manualny selektorów
    console.log('🔍 TESTOWANIE NOWYCH SELEKTORÓW:');
    
    // Test nazwy
    const nameSelectors = [
      "h1",
      ".product-title, .product-name",
      ".entry-title, .page-title"
    ];
    
    console.log('\n📛 NAZWA:');
    nameSelectors.forEach(selector => {
      const element = $(selector).first();
      if (element.length > 0) {
        console.log(`  ✅ ${selector}: "${element.text().trim()}"`);
      } else {
        console.log(`  ❌ ${selector}: nie znaleziono`);
      }
    });
    
    // Test ceny - NOWE selektory
    const priceSelectors = [
      '.price .woocommerce-Price-amount bdi', // GŁÓWNY dla WooCommerce
      '.price .woocommerce-Price-amount',
      '.price .amount',
      '.product-price .amount',
      '.woocommerce-price-amount'
    ];
    
    console.log('\n💰 CENA (NOWE SELEKTORY):');
    priceSelectors.forEach(selector => {
      const element = $(selector).first();
      if (element.length > 0) {
        console.log(`  ✅ ${selector}: "${element.text().trim()}"`);
      } else {
        console.log(`  ❌ ${selector}: nie znaleziono`);
      }
    });
    
    // Test wzorców tekstowych dla ceny
    const bodyText = $('body').text();
    const priceMatch = bodyText.match(/Cena\s*(\d+[\d\s,.]*)?\s*zł/i);
    if (priceMatch) {
      console.log(`  ✅ Wzorzec "Cena X zł": "${priceMatch[0].trim()}"`);
    } else {
      console.log(`  ❌ Wzorzec "Cena X zł": nie znaleziono`);
    }
    
    // Test dostępności - NOWE selektory z .stock
    const availabilitySelectors = [
      '.stock', // 🎯 GŁÓWNY dla Tabou.pl
      '.woocommerce-variation-availability',
      '.product-availability',
      '.stock-status',
      '.availability'
    ];
    
    console.log('\n📦 DOSTĘPNOŚĆ (NOWE SELEKTORY):');
    availabilitySelectors.forEach(selector => {
      const element = $(selector).first();
      if (element.length > 0) {
        console.log(`  ✅ ${selector}: "${element.text().trim()}"`);
      } else {
        console.log(`  ❌ ${selector}: nie znaleziono`);
      }
    });
    
    // Test wzorców tekstowych dla dostępności
    const availMatch = bodyText.match(/Dostępny\s*\(\d+\/\d+\s+wariantów\)/i);
    if (availMatch) {
      console.log(`  ✅ Wzorzec wariantów: "${availMatch[0].trim()}"`);
    } else {
      console.log(`  ❌ Wzorzec wariantów: nie znaleziono`);
    }
    
    // Test kolorów
    console.log('\n🎨 KOLORY:');
    const colorList = $('.color-attribute-select[data-group="kolorystyka"]');
    if (colorList.length > 0) {
      console.log(`  ✅ Znaleziono listę kolorów (${colorList.length} elementów)`);
      colorList.find('li.select-color').each((i, li) => {
        const img = $(li).find('img');
        const alt = img.attr('alt');
        if (alt) {
          console.log(`    - Kolor: "${alt}"`);
        }
      });
    } else {
      console.log(`  ❌ Lista kolorów nie znaleziona`);
    }
    
    // Podsumowanie
    console.log('\n📊 PODSUMOWANIE EFEKTYWNOŚCI SELEKTORÓW:');
    const workingSelectors = [];
    
    // Sprawdź które selektory działają
    if ($('.stock').length > 0) workingSelectors.push('✅ .stock (dostępność)');
    if ($('.price .woocommerce-Price-amount bdi').length > 0) workingSelectors.push('✅ .price .woocommerce-Price-amount bdi (cena)');
    if ($('h1').length > 0) workingSelectors.push('✅ h1 (nazwa)');
    if ($('.color-attribute-select').length > 0) workingSelectors.push('✅ .color-attribute-select (kolory)');
    
    if (workingSelectors.length > 0) {
      console.log('Działające selektory:');
      workingSelectors.forEach(selector => console.log(`  ${selector}`));
    } else {
      console.log('❌ Żaden z nowych selektorów nie działa!');
    }
    
    console.log('\n' + '='.repeat(80));
    
  } catch (error) {
    console.error(`❌ Błąd testowania ${url}:`, error.message);
  }
}

// Testuj kilka kluczowych produktów
const testUrls = [
  'https://www.tabou.pl/produkt/rower-dzieciecy-tabou-rocket-cs-alu/',
  'https://www.tabou.pl/produkt/rower-dzieciecy-tabou-miss-cs/',
  'https://www.tabou.pl/produkt/rower-dzieciecy-royal-by-tabou-space/'
];

async function runTests() {
  console.log('🚀 TEST NOWYCH SELEKTORÓW CRAWLERA\n');
  console.log('Testujemy selektory:');
  console.log('• .stock (dostępność) 🎯');
  console.log('• .price .woocommerce-Price-amount bdi (cena)');
  console.log('• Wzorce tekstowe');
  console.log('');
  
  for (const url of testUrls) {
    await testSingleProduct(url);
    
    // Pauza między testami
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n✅ TESTY ZAKOŃCZONE');
  console.log('\n💡 Sprawdź które selektory działają najlepiej');
  console.log('   i zaktualizuj crawler.js odpowiednio!');
}

runTests();
