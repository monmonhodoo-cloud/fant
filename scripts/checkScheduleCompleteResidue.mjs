// QC 완료 처리 실패(schedules write 거부)로 남은 부분 쓰기 잔재 점검 (읽기 전용)
// 흐름: meatStocks → meatLogs → stockLedger → schedules(실패 지점)
// → stockLedger(scheduleComplete) 중 대응 schedule이 완료 상태가 아닌 것 = 잔재
//
// 실행: node scripts/checkScheduleCompleteResidue.mjs [--email ... --password ...]

import { doc, getDoc } from 'firebase/firestore';
import { initAuthedFirestore, parseArgs, readCollection } from './firestoreConfig.mjs';

const args = parseArgs(process.argv.slice(2));
const db = await initAuthedFirestore(args);

const ledgerDocs = await readCollection(db, 'stockLedger');
const ledgers = ledgerDocs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(l => l.actionType === 'scheduleComplete');

console.log(`stockLedger scheduleComplete 총 ${ledgers.length}건`);

const residues = [];
for (const l of ledgers) {
  if (!l.actionId) continue;
  const schedSnap = await getDoc(doc(db, 'schedules', l.actionId));
  const sched = schedSnap.exists() ? schedSnap.data() : null;
  const completed = sched && sched.status === 'completed';
  // 완료된 schedule이라도 ledgerId가 이 ledger가 아니면(재시도 성공 케이스) 이 ledger는 잔재
  const isLinked = completed && sched.ledgerId === l.id;
  if (!isLinked && l.status === 'active') {
    residues.push({
      ledgerId: l.id,
      date: l.date,
      scheduleId: l.actionId,
      scheduleStatus: sched ? sched.status : '(schedule 없음)',
      scheduleLinkedLedger: sched ? sched.ledgerId || null : null,
      items: (l.items || []).map(it => ({
        collection: it.collection,
        docId: it.docId,
        label: it.label,
        delta: it.delta,
        isNewDoc: it.isNewDoc || false,
      })),
    });
  }
}

if (residues.length === 0) {
  console.log('\n잔재 없음 — 실패한 완료 시도로 생성된 고아 ledger가 없습니다.');
} else {
  console.log(`\n⚠️ 잔재 ${residues.length}건 발견:\n`);
  for (const r of residues) {
    console.log(`- ledger ${r.ledgerId} (${r.date}) / schedule ${r.scheduleId} 상태=${r.scheduleStatus} 연결ledger=${r.scheduleLinkedLedger}`);
    for (const it of r.items) {
      console.log(`    ${it.collection}/${it.docId} ${it.label} delta=${it.delta}${it.isNewDoc ? ' [신규생성 lot]' : ''}`);
    }
  }
  console.log('\n각 잔재의 meatStocks 신규생성 lot은 중복 입고이므로 삭제/마감 대상입니다.');
}

process.exit(0);
