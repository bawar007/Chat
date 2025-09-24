import fs from 'fs';

try {
  console.log('🔍 ANALIZA DOKUMENTÓW Z KOLORAMI:');
  console.log('================================');

  // Sprawdź główny plik
  const mainDocs = JSON.parse(fs.readFileSync('data/tabou.json', 'utf8'));
  console.log(`Główny plik: ${mainDocs.length} dokumentów`);

  // Sprawdź pierwszy plik części
  const partDocs = JSON.parse(fs.readFileSync('data/tabou_part1.json', 'utf8'));
  console.log(`Part1: ${partDocs.length} dokumentów`);

  const allDocs = [...mainDocs, ...partDocs];

  const docsWithColors = allDocs.filter(doc => 
    doc.text.toLowerCase().includes('kolor') || 
    (doc.metadata && doc.metadata.colors && doc.metadata.colors.length > 0)
  );

  console.log(`\nDokumentów z kolorami: ${docsWithColors.length} z ${allDocs.length}`);

  if (docsWithColors.length > 0) {
    console.log('\nPrzykładowe dokumenty:');
    docsWithColors.slice(0, 3).forEach((doc, i) => {
      console.log(`${i+1}. Tekst: ${doc.text.substring(0, 100)}...`);
      if (doc.metadata && doc.metadata.colors) {
        console.log(`   Kolory: ${doc.metadata.colors.slice(0, 3).join(', ')}`);
      }
      console.log(`   Typ: ${doc.metadata?.type}`);
      console.log('---');
    });
  }

  // Sprawdź konkretnie produkty
  const productDocs = allDocs.filter(doc => doc.metadata?.type === 'product');
  console.log(`\nProdukty: ${productDocs.length}`);
  
  if (productDocs.length > 0) {
    console.log('Przykład produktu:');
    const example = productDocs[0];
    console.log('Tekst:', example.text.substring(0, 200));
    console.log('Metadata keys:', Object.keys(example.metadata || {}));
    if (example.metadata?.colors) {
      console.log('Kolory:', example.metadata.colors);
    }
  }

} catch (error) {
  console.error('Błąd:', error.message);
}