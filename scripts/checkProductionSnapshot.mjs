import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs } from 'firebase/firestore';

const args = parseArgs(process.argv.slice(2));
const db = await initAuthedFirestore(args);

const snap = await getDocs(collection(db, 'productions'));
const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

for (const date of ['2026-06-25', '2026-06-26']) {
  const prods = all.filter(p => p.date === date && p.status !== 'deleted');
  console.log(`\n=== ${date} 생산 ${prods.length}건 ===`);
  prods.forEach(p => {
    const chicken = (p.ingredientsSnapshot || []).filter(i => ['닭가슴살','닭정육'].includes(i.name));
    if (chicken.length === 0) return;
    console.log(`  ${p.recipeName} qty=${p.productionUnitQty}${p.productionUnitName||''}: `
      + chicken.map(i => `${i.name}=${i.requiredQtyG}g`).join(', '));
  });
}
