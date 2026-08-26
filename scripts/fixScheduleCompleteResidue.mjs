// QC 완료 처리 실패 잔재 정리 스크립트
// checkScheduleCompleteResidue.mjs 로 찾은 고아 ledger들을 정리한다.
//
// 기본 = dry-run (아무것도 안 바꿈). 실제 반영은 --apply.
//   node scripts/fixScheduleCompleteResidue.mjs --email ... --password ...          (dry-run)
//   node scripts/fixScheduleCompleteResidue.mjs --email ... --password ... --apply  (실제 반영)
//
// 처리 규칙:
// - meatStocks 신규생성 lot: remaining === initialQty (미사용) → remaining 0 / closed / status deleted + meatLogs 정정 기록
//                            remaining !== initialQty (일부 사용) → 건드리지 않고 수동 검토 목록에 출력
// - bagTypes / eggStock delta: currentQty 에서 delta 차감 (음수 되면 경고만, 그래도 차감)
// - ledger: status 'rolledBack' 처리

import {
  doc, getDoc, updateDoc, addDoc, collection, serverTimestamp,
} from 'firebase/firestore';
import { initAuthedFirestore, parseArgs, readCollection } from './firestoreConfig.mjs';

const args = parseArgs(process.argv.slice(2));
const APPLY = args.get('apply') === true;
const db = await initAuthedFirestore(args);

console.log(APPLY ? '*** APPLY 모드 — 실제 데이터를 수정합니다 ***\n' : '--- dry-run (수정 없음) ---\n');

const ledgerDocs = await readCollection(db, 'stockLedger');
const ledgers = ledgerDocs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(l => l.actionType === 'scheduleComplete' && l.status === 'active');

const residues = [];
for (const l of ledgers) {
  if (!l.actionId) continue;
  const schedSnap = await getDoc(doc(db, 'schedules', l.actionId));
  const sched = schedSnap.exists() ? schedSnap.data() : null;
  const isLinked = sched && sched.status === 'completed' && sched.ledgerId === l.id;
  if (!isLinked) residues.push(l);
}

console.log(`정리 대상 고아 ledger: ${residues.length}건\n`);

const manualReview = [];
let lotClosed = 0, stockAdjusted = 0, ledgerRolled = 0;

for (const l of residues) {
  console.log(`ledger ${l.id} (${l.date})`);
  for (const item of l.items || []) {
    if (item.collection === 'meatStocks' && item.isNewDoc) {
      const lotSnap = await getDoc(doc(db, 'meatStocks', item.docId));
      if (!lotSnap.exists()) { console.log(`  meatStocks/${item.docId} 이미 없음 — 건너뜀`); continue; }
      const lot = lotSnap.data();
      if (lot.status === 'deleted' || lot.closed) { console.log(`  meatStocks/${item.docId} 이미 마감/삭제됨 — 건너뜀`); continue; }
      const initial = Number(lot.initialQtyG || 0);
      const remaining = Number(lot.remaining || 0);
      if (remaining !== initial) {
        manualReview.push({ ledgerId: l.id, lotId: item.docId, label: item.label, initial, remaining });
        console.log(`  ⚠️ meatStocks/${item.docId} ${item.label}: 일부 사용됨 (초기 ${initial}g → 잔량 ${remaining}g) — 수동 검토 필요, 건너뜀`);
        continue;
      }
      console.log(`  meatStocks/${item.docId} ${item.label}: 미사용 중복 lot → 삭제 처리 (${initial}g)`);
      if (APPLY) {
        await updateDoc(doc(db, 'meatStocks', item.docId), {
          remaining: 0, closed: true, status: 'deleted',
          note: `${lot.note || ''} [QC권한오류 중복입고 정리]`.trim(),
          updatedAt: new Date(),
        });
        await addDoc(collection(db, 'meatLogs'), {
          type: 'adjust',
          date: l.date || new Date().toISOString().slice(0, 10),
          meatTypeId: lot.meatTypeId || '',
          meatNameSnapshot: lot.meatNameSnapshot || '',
          stage: lot.stage || 'frozen',
          meatStockId: item.docId,
          delta: -initial,
          before: initial,
          after: 0,
          staff: 'system',
          uid: null,
          reason: `QC 권한오류 중복입고 정리 (ledger ${l.id})`,
          batchId: `fixResidue-${l.id}`,
          timestamp: serverTimestamp(),
        });
      }
      lotClosed++;
    } else if (item.collection === 'bagTypes' || item.collection === 'eggStock') {
      // 공유 카운터 — 그동안 실사 보정이 반영됐을 수 있어 소급 차감 위험. 수량은 건드리지 않고 목록만.
      console.log(`  ${item.collection}/${item.docId} ${item.label}: 과거 중복 증가 ${item.delta} — 수량 자동 조정 안 함 (실사로 수동 확인)`);
      manualReview.push({ ledgerId: l.id, lotId: item.docId, label: item.label, note: `${item.collection} 과거 중복 증가 ${item.delta} — 실사 대조 필요` });
      stockAdjusted++;
    } else if (item.collection === 'meatStocks' && !item.isNewDoc) {
      console.log(`  meatStocks/${item.docId} (기존 lot 증가분) — 수동 검토 필요`);
      manualReview.push({ ledgerId: l.id, lotId: item.docId, label: item.label, note: '기존 lot delta' });
    }
  }
  if (APPLY) {
    await updateDoc(doc(db, 'stockLedger', l.id), {
      status: 'rolledBack',
      rolledBackAt: new Date(),
      rollbackReason: 'QC 권한오류 잔재 정리',
    });
  }
  ledgerRolled++;
}

console.log(`\n=== 요약 (${APPLY ? '반영됨' : 'dry-run'}) ===`);
console.log(`중복 lot 삭제 처리: ${lotClosed}건`);
console.log(`bagTypes/eggStock 수동확인 대상(수량 미변경): ${stockAdjusted}건`);
console.log(`ledger rolledBack: ${ledgerRolled}건`);
if (manualReview.length > 0) {
  console.log(`\n⚠️ 수동 검토 필요 ${manualReview.length}건 (일부 사용된 lot — 자동 삭제 안 함):`);
  manualReview.forEach(m => console.log(`  ledger ${m.ledgerId} / meatStocks ${m.lotId} ${m.label} ${m.initial !== undefined ? `초기 ${m.initial}g 잔량 ${m.remaining}g` : m.note}`));
}

process.exit(0);
