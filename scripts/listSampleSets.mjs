// 샘플세트(kind='sampleSet') frozenProducts 목록 — 재고앱 productMeta 등록용
import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs } from 'firebase/firestore';

const args = parseArgs(process.argv.slice(2));
const db = await initAuthedFirestore(args);

const snap = await getDocs(collection(db, 'frozenProducts'));
const sets = snap.docs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(p => p.kind === 'sampleSet');

console.log(`=== 샘플세트 ${sets.length}건 ===\n`);
if (sets.length === 0) {
  console.log('(등록된 샘플세트 없음 — 생산앱에서 아직 만들지 않음)');
} else {
  sets.forEach(s => {
    console.log(JSON.stringify({
      frozenProductId: s.id,
      productName: s.name,
      target: s.target || '(없음)',
      active: s.active !== false,
      components: (s.components || []).map(c => ({ frozenProductId: c.frozenProductId, qty: c.qty })),
    }, null, 2));
  });
}
