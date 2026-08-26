// 양제비추리/토끼내장 전처리 lot 정리: 잘못된 lot을 closed(remaining=0) 처리
// 보존: 6/10 lot만 (양제비추리 11500, 토끼내장 250)
import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs, doc, updateDoc, query, where } from 'firebase/firestore';

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.has('execute');
const db = await initAuthedFirestore(args);

// 정리(closed) 대상 lot
const CLEANUP_LOTS = [
  { id: 'Ec2HCLfVHJftCApyywqY', name: '양제비추리', was: 25000 },
  { id: 'QqSWzauaHJUzlleN3LcI', name: '양제비추리', was: -39000 },
  { id: '7Rq04NXysUw2zr9yTD1O', name: '토끼내장', was: 1000 },
  { id: 'udvLNKNwxnI30ZM99NJL', name: '토끼내장', was: -4000 },
];

const TARGETS = { '양제비추리': 'eKSjeQUQtEnn4Y44bd46', '토끼내장': 'g5ulJ54XA2WQWnBqYNk7' };

console.log(`=== ${dryRun ? 'DRY-RUN' : 'EXECUTE'}: 전처리 lot 정리 ===\n`);
for (const lot of CLEANUP_LOTS) {
  console.log(`  closed 처리: ${lot.name} lot ${lot.id} (remaining ${lot.was} → 0)`);
  if (!dryRun) {
    await updateDoc(doc(db, 'meatStocks', lot.id), {
      remaining: 0, closed: true, updatedAt: new Date(),
      note: '전처리 잔량 오류 정리(음수/오등록 lot)',
    });
  }
}

console.log(`\n=== 정리 후 예상 잔량 ===`);
for (const [name, meatTypeId] of Object.entries(TARGETS)) {
  const snap = await getDocs(query(
    collection(db, 'meatStocks'),
    where('meatTypeId', '==', meatTypeId),
    where('stage', '==', 'processed'),
  ));
  const cleanupIds = new Set(CLEANUP_LOTS.map(l => l.id));
  let sum = 0;
  snap.docs.forEach(d => {
    const r = cleanupIds.has(d.id) ? 0 : Number(d.data().remaining || 0);
    sum += r;
  });
  console.log(`  ${name}: ${sum}g = ${(sum/1000).toFixed(2)}kg`);
}
console.log(dryRun ? `\n(dry-run) 적용하려면 --execute` : `\n적용 완료.`);
