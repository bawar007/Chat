import axios from "axios";
import * as cheerio from "cheerio";

async function testColorExtraction() {
  const url = "https://www.tabou.pl/produkt/rower-mlodziezowy-tabou-venom-lite-w/";
  
  try {
    console.log("Testuję ekstrakcję kolorów z:", url);
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    
    const allColors = new Set();
    const product = {};
    
    // 1. Znajdź listę kolorów w strukturze WooCommerce (.color-attribute-select)
    const colorList = $('.color-attribute-select[data-group="kolorystyka"]');
    console.log("Znaleziono color-attribute-select:", colorList.length);
    
    if (colorList.length > 0) {
      colorList.find('li.select-color').each((i, li) => {
        const $li = $(li);
        const img = $li.find('img');
        const alt = img.attr('alt');
        const dataValue = $li.attr('data-variant-value');
        const isActive = $li.hasClass('active');
        
        console.log(`Kolor ${i+1}:`, {
          alt: alt,
          dataValue: dataValue,
          isActive: isActive,
          src: img.attr('src')
        });
        
        if (alt) {
          allColors.add(alt.trim());
          if (isActive) {
            product.selectedColor = alt.trim();
          }
        } else if (dataValue) {
          const colorName = dataValue.replace(/-/g, ' / ');
          allColors.add(colorName);
          if (isActive) {
            product.selectedColor = colorName;
          }
        }
      });
    }
    
    // 2. Sprawdź inne selektory
    if (allColors.size === 0) {
      console.log("Sprawdzam inne selektory...");
      
      const variations = $('.variations .value ul li img[alt]');
      console.log("Variations img[alt]:", variations.length);
      variations.each((i, el) => {
        console.log(`Variation ${i}:`, $(el).attr('alt'));
      });
      
      const wvsColors = $('.wvs-color-variable-item, .variable-item-color');
      console.log("WVS color elements:", wvsColors.length);
      wvsColors.each((i, el) => {
        const title = $(el).attr('title') || $(el).attr('data-title');
        console.log(`WVS ${i}:`, title);
      });
    }
    
    // 3. Sprawdź czy gdzieś jest HTML z kolorami
    console.log("\nSprawdzam HTML:");
    const html = response.data;
    const colorListMatch = html.match(/<ul class="color-attribute-select"[^>]*>(.*?)<\/ul>/s);
    if (colorListMatch) {
      console.log("Znaleziono strukturę color-attribute-select!");
      console.log("Fragment HTML:", colorListMatch[0].substring(0, 500) + "...");
    }
    
    console.log("\n=== WYNIKI ===");
    console.log("Wszystkie kolory:", Array.from(allColors));
    console.log("Wybrany kolor:", product.selectedColor);
    
  } catch (error) {
    console.error("Błąd:", error.message);
  }
}

testColorExtraction();