// 동결제품 카테고리 마이그레이션 (1차, 생산앱 단독)
// 1) active=true 11건: target/kind backfill (이름 prefix → target, kind='product')
// 2) active=false 잔재: frozenLogs 활성 이력 0건인 것만 삭제 (이력 있으면 보존+경고)
// dry-run 기본, --execute로 적용
import { initAuthedFirestore, parseArgs } from './firestoreConfig.mjs';
import { collection, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.has('execute');
const db = await initAuthedFirestore(args);

function inferTarget(name = '') {
  if (name.startsWith('고양이 ')) return 'cat';
  if (name.startsWith('강아지 ')) return 'dog';
  return 'common';
}

const frozenSnap = await getDocs(collection(db, 'frozenProducts'));
const frozenProducts = frozenSnap.docs.map(d => ({ id: d.id, ...d.data() }));

// frozenLogs 활성 이력 카운트 (productId별)
const logSnap = await getDocs(collection(db, 'frozenLogs'));
const activeLogCount = {};
logSnap.docs.forEach(d => {
  const l = d.data();
  if (l.status === 'deleted') return;
  activeLogCount[l.productId] = (activeLogCount[l.productId] || 0) + 1;
});

console.log(`=== ${dryRun ? 'DRY-RUN' : 'EXECUTE'}: 동결제품 카테고리 마이그레이션 ===\n`);

const toBackfill = frozenProducts.filter(p => p.active !== false);
const toDelete = frozenProducts.filter(p => p.active === false);

console.log(`--- [1] target/kind backfill 대상 (active=true ${toBackfill.length}건) ---`);
for (const p of toBackfill) {
  const target = inferTarget(p.name);
  console.log(`  "${p.name}" → target=${target}, kind=product`);
  if (!dryRun) {
    await updateDoc(doc(db, 'frozenProducts', p.id), { target, kind: 'product', updatedAt: new Date() });
  }
}

console.log(`\n--- [2] 삭제 검토 대상 (active=false ${toDelete.length}건) ---`);
let deleted = 0, blocked = 0;
for (const p of toDelete) {
  const cnt = activeLogCount[p.id] || 0;
  if (cnt === 0) {
    console.log(`  🗑️  "${p.name}" (id=${p.id}) — 이력 0건 → 삭제`);
    deleted++;
    if (!dryRun) await deleteDoc(doc(db, 'frozenProducts', p.id));
  } else {
    console.log(`  ⚠️  "${p.name}" (id=${p.id}) — 이력 ${cnt}건 → 보존(비활성 유지)`);
    blocked++;
  }
}

console.log(`\n=== 요약 ===`);
console.log(`backfill: ${toBackfill.length}건`);
console.log(`삭제: ${deleted}건 / 이력으로 보존: ${blocked}건`);
console.log(dryRun ? `\n(dry-run) 적용하려면 --execute` : `\n적용 완료.`);
