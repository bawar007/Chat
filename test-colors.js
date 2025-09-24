import axios from 'axios';
import * as cheerio from 'cheerio';

async function testColorExtraction() {
  try {
    console.log('Testowanie ekstrakcji kolorów...');
    const response = await axios.get('https://www.tabou.pl/produkt/rower-mlodziezowy-tabou-venom-lite-w/');
    const $ = cheerio.load(response.data);
    
    // Test naszej ekstrakcji kolorów
    const bodyText = $('body').text();
    
    // 1. Aktualny kolor - sprawdź różne wzorce
    console.log('\nSzukanie aktualnego koloru:');
    let currentColorMatch = bodyText.match(/Kolorystyka:\s*([^\n\r]+)/i);
    console.log('Wzorzec "Kolorystyka:":', currentColorMatch ? currentColorMatch[1].trim() : 'nie znaleziono');
    
    currentColorMatch = bodyText.match(/Kolor:\s*([^\n\r]+)/i);
    console.log('Wzorzec "Kolor:":', currentColorMatch ? currentColorMatch[1].trim() : 'nie znaleziono');
    
    currentColorMatch = bodyText.match(/Wybierz kolor[:\s]*([^\n\r]+)/i);
    console.log('Wzorzec "Wybierz kolor":', currentColorMatch ? currentColorMatch[1].trim() : 'nie znaleziono');
    
    // Sprawdź czy w HTML jest informacja o aktualnie wybranym kolorze
    const selectedColor = $('.variations .value .selected, .wvs-selected').text().trim();
    console.log('Wybrany kolor z CSS:', selectedColor || 'nie znaleziono');
    
    // 2. Kolory z obrazków
    const colorImages = $('img[alt]').filter((i, el) => {
      const alt = $(el).attr('alt');
      return alt && (alt.includes('/') || alt.includes('black') || alt.includes('white') || 
                     alt.includes('blue') || alt.includes('red') || alt.includes('green') || 
                     alt.includes('pink'));
    });
    
    const availableColors = [];
    colorImages.each((i, el) => {
      const alt = $(el).attr('alt');
      if (alt && alt.trim() && !availableColors.includes(alt.trim())) {
        availableColors.push(alt.trim());
      }
    });
    
    console.log('Dostępne kolory z obrazków:', availableColors);
    
    // 3. Kolory z selektorów WooCommerce
    const colorSelectors = $('.wvs-color-variable-item, .variable-item-color, .color-option');
    const wooColors = [];
    colorSelectors.each((i, el) => {
      const title = $(el).attr('title') || $(el).attr('data-title') || $(el).text().trim();
      if (title && !wooColors.includes(title)) {
        wooColors.push(title);
      }
    });
    
    console.log('Kolory z selektorów WooCommerce:', wooColors);
    
    // 4. Sprawdź czy są jakieś inne elementy z kolorami
    console.log('\nDodatkowe testy:');
    const allImages = $('img[alt*="color"], img[alt*="kolor"], img[src*="color"], img[src*="kolor"]');
    console.log('Obrazki z słowem "color/kolor":', allImages.length);
    
    const variationElements = $('.variations img, .product-variations img');
    console.log('Obrazki w sekcji wariantów:', variationElements.length);
    
  } catch (error) {
    console.error('Błąd:', error.message);
  }
}

testColorExtraction();