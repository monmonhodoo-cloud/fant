import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs } from 'firebase/firestore';

const args = parseArgs(process.argv.slice(2));
const db = await initAuthedFirestore(args);

const snap = await getDocs(collection(db, 'recipes'));
const recipes = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.active !== false);

const chickenRecipes = recipes.filter(r =>
  (r.ingredients || []).some(i => i.name?.includes('닭가슴살'))
);

console.log(`닭가슴살 포함 활성 레시피 ${chickenRecipes.length}건\n`);
chickenRecipes.forEach(r => {
  console.log(`=== ${r.displayName || r.name} ===`);
  (r.ingredients || []).slice(0, 5).forEach(ing => {
    console.log(JSON.stringify({
      name: ing.name,
      isProductionUnit: ing.isProductionUnit,
      baseWeightG: ing.baseWeightG,
      unitName: ing.unitName,
      weightDisplayUnit: ing.weightDisplayUnit,
    }));
  });
  console.log('');
});
