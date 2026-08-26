// 닭염통 meatStocks meatTypeId 마이그레이션
// HR05Si1qydQ8JUDhoxUx (삭제된 duplicate) → rPcRFMSHnBVHY3s7NyoI (살아있는 ID)
import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs, query, where, updateDoc, doc } from 'firebase/firestore';

const FROM_ID = 'HR05Si1qydQ8JUDhoxUx';
const TO_ID = 'rPcRFMSHnBVHY3s7NyoI';

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.has('execute');
const db = await initAuthedFirestore(args);

console.log(`=== ${dryRun ? 'DRY-RUN' : 'EXECUTE'}: 닭염통 meatStocks ID migration ===`);
console.log(`from: ${FROM_ID}`);
console.log(`to:   ${TO_ID}\n`);

const snap = await getDocs(query(collection(db, 'meatStocks'), where('meatTypeId', '==', FROM_ID)));
console.log(`Found ${snap.docs.length} matching meatStocks documents:`);
snap.docs.forEach(d => {
  const { meatNameSnapshot, stage, remaining, incomingDate } = d.data();
  console.log(JSON.stringify({ id: d.id, meatNameSnapshot, stage, remaining, incomingDate }));
});

if (!dryRun) {
  await Promise.all(snap.docs.map(d => updateDoc(doc(db, 'meatStocks', d.id), { meatTypeId: TO_ID })));
  console.log(`\nMigration complete. ${snap.docs.length} documents updated.`);
} else {
  console.log(`\nDry-run complete. ${snap.docs.length} documents would be updated.`);
  console.log('Pass --execute to apply.');
}
