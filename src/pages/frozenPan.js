import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, query, orderBy, getDoc, writeBatch
} from 'firebase/firestore';
import { getTodayKST as getToday } from '../utils/date.js';
import { getActiveFreezeDryRecipes, getRecipeOptionsHtml } from '../utils/recipe.js';
import { blockIfClosed } from '../utils/closingGuard.js';
import { currentUserRole } from '../app.js';
import { round2, breadToSilicon, breadToFrozenPan } from '../utils/number.js';
import { showPromptModal, showConfirmModal } from '../utils/modal.js';
import { recordActivity } from '../services/activityLogs.js';
import { renderFreezeOpInTab } from './freezeOp.js';


let freezeDryRecipes = [];
let activeTab = 'breadPan';  // 'breadPan' | 'frozenPan' — 묶음 3D 추가

export async function renderFrozenPan() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>동결판 재고 로딩 중...</p></div>`;
  freezeDryRecipes = await getActiveFreezeDryRecipes();
  await loadStaffCache();
  activeTab = 'breadPan';  // 진입 시 default 탭 리셋
  await refreshFrozenPanLayout();
}

async function loadFrozenPanRows() {
  const q = query(collection(db, 'frozenPanStock'), orderBy('date', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadFrozenPanLots() {
  const snap = await getDocs(collection(db, 'frozenPanLots'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(l => !l.closed && Number(l.remaining || 0) > 0);
}

async function loadBreadPanLots() {
  const snap = await getDocs(collection(db, 'breadPanLots'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => !l.closed);
}

async function loadBreadPanLogs() {
  const q = query(collection(db, 'breadPanLogs'), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadFrozenPanLogs() {
  const q = query(collection(db, 'frozenPanLogs'), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function refreshFrozenPanLayout() {
  const rows = await loadFrozenPanRows();
  const lots = await loadFrozenPanLots();
  const breadPanLots = await loadBreadPanLots();
  const breadPanLogs = await loadBreadPanLogs();
  const frozenPanLogs = await loadFrozenPanLogs();
  renderFrozenPanLayout(rows, lots, breadPanLots, breadPanLogs, frozenPanLogs);
}

function renderFrozenPanLayout(rows, lots, breadPanLots, breadPanLogs, frozenPanLogs) {
  const content = document.getElementById('mainContent');

  // 묶음 3 정책: 옛 type='work' 행은 화면에서 숨김 (DB는 묶음 10에서 일괄 wipe 예정)
  rows = rows.filter(r => r.type !== 'work');

  // 동결판 제품별 lot 집계 (source 포함)
  const lotSummary = {};
  lots.forEach(l => {
    if (!lotSummary[l.productName]) lotSummary[l.productName] = [];
    lotSummary[l.productName].push({
      date: l.date,
      remaining: l.remaining,
      source: l.source || null,  // 묶음 3H 추가
    });
  });

  // 빵판 제품별 lot 집계
  const breadLotSummary = {};
  breadPanLots.forEach(l => {
    if (!breadLotSummary[l.productName]) breadLotSummary[l.productName] = [];
    breadLotSummary[l.productName].push({ date: l.date, remaining: l.remaining });
  });

  // 합계 — 빵판 / 실리콘 / 동결판
  const totalBreadPan = round2(breadPanLots.reduce((sum, l) => sum + (l.remaining || 0), 0));
  const totalSilicon = breadToSilicon(totalBreadPan);
  const totalPan = lots.reduce((sum, l) => sum + (l.remaining || 0), 0);

  content.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <h2 class="page-title">동결판 재고</h2>
      </div>

      <!-- 합계 요약 -->
      <div class="form-section" style="background:white;border-radius:8px;padding:16px 20px;margin-bottom:16px;border:1px solid #e8e8e8;">
        <div class="stat-row">
          <div class="stat-item">
            <span class="stat-label">현재 빵판</span>
            <span class="stat-value" style="font-size:20px;color:#1a1a1a">${totalBreadPan}개</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">실리콘 환산</span>
            <span class="stat-value" style="font-size:14px;color:#888">${totalSilicon}판</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">현재 총 동결판</span>
            <span class="stat-value" style="font-size:20px;color:${totalPan < 10 ? '#e53e3e' : '#1a1a1a'}">${totalPan}판</span>
          </div>
        </div>
      </div>

      <!-- 탭 nav -->
      <div class="tab-nav" style="display:flex;gap:0;border-bottom:2px solid #e8e8e8;margin-bottom:16px;">
        <button class="tab-btn" data-tab="breadPan"
          style="padding:10px 20px;background:${activeTab === 'breadPan' ? '#fff' : '#f5f5f5'};border:1px solid #e8e8e8;border-bottom:${activeTab === 'breadPan' ? '2px solid white' : 'none'};margin-bottom:-2px;font-size:14px;cursor:pointer;font-weight:${activeTab === 'breadPan' ? '600' : '400'};color:${activeTab === 'breadPan' ? '#1a1a1a' : '#888'};">
          빵판 재고
        </button>
        <button class="tab-btn" data-tab="frozenPan"
          style="padding:10px 20px;background:${activeTab === 'frozenPan' ? '#fff' : '#f5f5f5'};border:1px solid #e8e8e8;border-bottom:${activeTab === 'frozenPan' ? '2px solid white' : 'none'};margin-bottom:-2px;font-size:14px;cursor:pointer;font-weight:${activeTab === 'frozenPan' ? '600' : '400'};color:${activeTab === 'frozenPan' ? '#1a1a1a' : '#888'};">
          동결판 재고
        </button>
        <button class="tab-btn" data-tab="freezeOp"
          style="padding:10px 20px;background:${activeTab === 'freezeOp' ? '#fff' : '#f5f5f5'};border:1px solid #e8e8e8;border-bottom:${activeTab === 'freezeOp' ? '2px solid white' : 'none'};margin-bottom:-2px;font-size:14px;cursor:pointer;font-weight:${activeTab === 'freezeOp' ? '600' : '400'};color:${activeTab === 'freezeOp' ? '#1a1a1a' : '#888'};">
          동결가동
        </button>
      </div>

      <!-- 탭 콘텐츠 -->
      ${activeTab === 'breadPan' ? renderBreadPanTab(breadLotSummary, breadPanLogs)
        : activeTab === 'frozenPan' ? renderFrozenPanTab(rows, lotSummary, frozenPanLogs)
        : '<div id="freezeOpContent" style="padding:4px 0;">로딩 중...</div>'}
    </div>
  `;

  // 탭 nav 이벤트
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      renderFrozenPanLayout(rows, lots, breadPanLots, breadPanLogs, frozenPanLogs);
    });
  });

  // 탭별 이벤트 바인딩
  if (activeTab === 'breadPan') {
    bindBreadPanTabEvents(rows, lots);
  } else if (activeTab === 'frozenPan') {
    bindFrozenPanTabEvents(rows, lots);
  } else {
    renderFreezeOpInTab();
  }
}

function getSourceBadge(source) {
  if (!source) return '';

  const config = {
    tenderIn:    { label: '텐더', color: '#1f6fb2', bg: '#e8f3fc' },
    preprocess:  { label: '전처리', color: '#2d7a3a', bg: '#e8f5ea' },
    adjust:      { label: '조정', color: '#b97a1f', bg: '#fdf3e0' },
  }[source];

  if (!config) return '';

  return `<span style="display:inline-block;font-size:10px;background:${config.bg};color:${config.color};padding:1px 6px;border-radius:3px;margin-left:4px;font-weight:500;vertical-align:middle;">${config.label}</span>`;
}

function renderBreadPanTab(breadLotSummary, breadPanLogs) {
  const lotEntries = Object.entries(breadLotSummary);
  return `
    <div class="page-header" style="margin-bottom:12px;">
      <span style="font-size:14px;color:#555;font-weight:600;">빵판 lot 잔량</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" id="btnBreadPanAdjust">+ 수동 조정</button>
        <button class="btn-secondary" id="btnAddWorkRow">+ 작업 행 추가</button>
        <button class="btn-primary" id="btnBreadPanIncoming">+ 빵판 입고</button>
      </div>
    </div>

    <!-- 빵판 lot 잔량 -->
    <div class="form-section" style="background:white;border-radius:8px;padding:16px 20px;margin-bottom:16px;border:1px solid #e8e8e8;">
      ${lotEntries.length === 0 ? '<div style="color:#aaa;text-align:center;padding:8px;">빵판 lot 없음</div>' : `
        <div class="stat-row">
          ${lotEntries.map(([name, lotList]) => `
            <div class="stat-item">
              <span class="stat-label">${name}</span>
              <div>
                ${lotList.sort((a,b) => a.date.localeCompare(b.date)).map(l => `
                  <div style="font-size:12px;color:#555">${round2(l.remaining)}개 <span style="color:#aaa">(${l.date})</span></div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <!-- 빵판 이력 -->
    <div class="table-wrap" style="background:white;border-radius:8px;border:1px solid #e8e8e8;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr>
            <th>날짜</th>
            <th>구분</th>
            <th>제품</th>
            <th>수량</th>
            <th>담당자</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          ${breadPanLogs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
            breadPanLogs.map(l => renderBreadPanLogRow(l)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderBreadPanLogRow(log) {
  const typeLabel = {
    incoming: '입고',
    preprocess: '전처리',
    adjust: '수동조정',
    rollback: '롤백',
  }[log.type] || log.type;

  const typeColor = {
    incoming: 'tag-raw',       // 파란색
    preprocess: '',            // 회색
    adjust: 'tag-cat',         // 노란색
    rollback: 'tag-cat',
  }[log.type] || '';

  const qtyColor = log.qty > 0 ? '#2d7a3a' : '#e53e3e';
  const qtySign = log.qty > 0 ? '+' : '';

  // 비고 — preprocess는 expected/actual 표시, 아니면 note/reason
  let noteText = '-';
  if (log.type === 'preprocess' && log.expectedFrozenQty != null && log.actualFrozenQty != null) {
    const diffText = log.diff > 0 ? `+${log.diff}` : log.diff < 0 ? `${log.diff}` : '0';
    noteText = `이론 ${log.expectedFrozenQty} / 실측 ${log.actualFrozenQty} (차 ${diffText})`;
  } else if (log.note) {
    noteText = log.note;
  } else if (log.reason) {
    noteText = log.reason;
  }

  // 제품명 옆에 차감/조정 대상 lot 입고일 표시 (입고 자기 자신은 제외)
  const lotDateLabel = (log.lotDate && log.type !== 'incoming')
    ? `<span style="font-size:11px;color:#999;margin-left:4px;">(입고 ${log.lotDate})</span>`
    : '';

  return `
    <tr>
      <td>${log.date || '-'}</td>
      <td><span class="tag ${typeColor}" style="${log.type === 'preprocess' ? 'background:#f0f0f0;color:#666' : ''}">${typeLabel}</span></td>
      <td>${log.productName || '-'}${lotDateLabel}</td>
      <td style="color:${qtyColor};font-weight:500;">${qtySign}${log.qty || 0}개</td>
      <td>${log.staffName || '-'}</td>
      <td style="font-size:12px;color:#666;">${noteText}</td>
    </tr>
  `;
}

function renderFrozenPanTab(rows, lotSummary, frozenPanLogs) {
  const lotEntries = Object.entries(lotSummary);
  return `
    <div class="page-header" style="margin-bottom:12px;">
      <span style="font-size:14px;color:#555;font-weight:600;">동결판 lot 잔량</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" id="btnFrozenPanAdjust">+ 수동 조정</button>
        <button class="btn-primary" id="btnTenderIn">+ 텐더동결 입고</button>
      </div>
    </div>

    <!-- 동결판 lot 잔량 -->
    <div class="form-section" style="background:white;border-radius:8px;padding:16px 20px;margin-bottom:16px;border:1px solid #e8e8e8;">
      ${lotEntries.length === 0 ? '<div style="color:#aaa;text-align:center;padding:8px;">동결판 lot 없음</div>' : `
        <div class="stat-row">
          ${lotEntries.map(([name, lotList]) => `
            <div class="stat-item">
              <span class="stat-label">${name}</span>
              <div>
                ${lotList.sort((a,b) => a.date.localeCompare(b.date)).map(l => `
                  <div style="font-size:12px;color:#555">${l.remaining}판 <span style="color:#aaa">(${l.date})</span>${getSourceBadge(l.source)}</div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <!-- 발주 테이블 -->
    <div style="font-size:14px;color:#555;font-weight:600;margin-bottom:8px;">발주 내역</div>
    <div class="table-wrap" style="background:white;border-radius:8px;border:1px solid #e8e8e8;overflow:hidden;margin-bottom:16px;">
      <table class="data-table">
        <thead>
          <tr>
            <th>날짜</th>
            <th>구분</th>
            <th>담당자</th>
            <th>내용</th>
            <th>상태</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">발주 내역 없음</td></tr>` :
            rows.map(r => renderPanRow(r)).join('')}
        </tbody>
      </table>
    </div>

    <!-- 동결판 이력 -->
    <div style="font-size:14px;color:#555;font-weight:600;margin-bottom:8px;">동결판 이력</div>
    <div class="table-wrap" style="background:white;border-radius:8px;border:1px solid #e8e8e8;overflow:hidden;">
      <table class="data-table">
        <thead>
          <tr>
            <th>날짜</th>
            <th>구분</th>
            <th>제품</th>
            <th>수량</th>
            <th>담당자</th>
            <th>비고</th>
          </tr>
        </thead>
        <tbody>
          ${frozenPanLogs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
            frozenPanLogs.map(l => renderFrozenPanLogRow(l)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderFrozenPanLogRow(log) {
  const typeLabel = {
    tenderIn: '텐더동결 입고',
    preprocess: '전처리 입고',
    orderDeduct: '발주 차감',
    orderRollback: '발주 복원',
    adjust: '수동조정',
  }[log.type] || log.type;

  const typeColor = {
    tenderIn: 'tag-raw',           // 파란색
    preprocess: 'tag-raw',         // 파란색
    orderDeduct: '',               // 회색 (차감)
    orderRollback: 'tag-cat',      // 노란색 (복원)
    adjust: 'tag-cat',             // 노란색
  }[log.type] || '';

  const qtyColor = log.qty > 0 ? '#2d7a3a' : '#e53e3e';
  const qtySign = log.qty > 0 ? '+' : '';

  // 비고
  let noteText = '-';
  if (log.note) {
    noteText = log.note;
  } else if (log.reason) {
    noteText = log.reason;
  }

  return `
    <tr>
      <td>${log.date || '-'}</td>
      <td><span class="tag ${typeColor}" style="${log.type === 'orderDeduct' ? 'background:#f0f0f0;color:#666' : ''}">${typeLabel}</span></td>
      <td>${log.productName || '-'}</td>
      <td style="color:${qtyColor};font-weight:500;">${qtySign}${log.qty || 0}판</td>
      <td>${log.staffName || '-'}</td>
      <td style="font-size:12px;color:#666;">${noteText}</td>
    </tr>
  `;
}

function bindBreadPanTabEvents(rows, lots) {
  const btnIncoming = document.getElementById('btnBreadPanIncoming');
  if (btnIncoming) btnIncoming.addEventListener('click', () => showBreadPanIncomingModal());

  const btnAdjust = document.getElementById('btnBreadPanAdjust');
  if (btnAdjust) btnAdjust.addEventListener('click', () => showBreadPanAdjustModal());

  const btnWorkRow = document.getElementById('btnAddWorkRow');
  if (btnWorkRow) btnWorkRow.addEventListener('click', () => showWorkRowModal(rows, lots));
}

function bindFrozenPanTabEvents(rows, lots) {
  const btnTender = document.getElementById('btnTenderIn');
  if (btnTender) btnTender.addEventListener('click', () => showTenderInModal());

  const btnAdjust = document.getElementById('btnFrozenPanAdjust');
  if (btnAdjust) btnAdjust.addEventListener('click', () => showFrozenPanAdjustModal());

  // 발주 확인 버튼
  document.querySelectorAll('.btn-order-confirm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rowId = btn.dataset.id;
      const row = rows.find(r => r.id === rowId);
      if (!row) return;
      if (await blockIfClosed(row.date)) return;

      // [묶음 5B] 발주 확인 담당자 입력 받기
      const staff = await showStaffPickerModal({
        title: '발주 확인 — 담당자 선택',
        message: '발주 확인을 진행할 담당자를 선택해주세요.',
        groups: ['senior', 'office'],
      });
      if (!staff) return;  // 취소 또는 미선택 시 중단

      await confirmOrder(row, lots, staff);
    });
  });

  // 발주 삭제 버튼
  document.querySelectorAll('.btn-order-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const __c = await showConfirmModal({ title:'발주 행 삭제', message:'발주 행을 삭제하시겠습니까?', confirmText:'삭제', danger:true }); if (!__c) return;
      const targetRow = rows.find(r => r.id === btn.dataset.id);
      if (targetRow && await blockIfClosed(targetRow.date)) return;
      await updateDoc(doc(db, 'frozenPanStock', btn.dataset.id), { status: 'cancelled' });
      await refreshFrozenPanLayout();
    });
  });

  // 발주 취소 버튼
  document.querySelectorAll('.btn-order-cancel').forEach(btn => {
    btn.addEventListener('click', async () => {
      const __c = await showConfirmModal({ title:'발주 확인 취소', message:'발주 확인을 취소하시겠습니까?\n차감된 동결판 재고가 복원됩니다.', confirmText:'확인', danger:true }); if (!__c) return;
      const rowId = btn.dataset.id;
      const row = rows.find(r => r.id === rowId);
      if (!row) return;
      if (await blockIfClosed(row.date)) return;

      // [묶음 5B] 발주 취소 담당자 입력 받기 (사유는 cancelOrder 내부에서 받음)
      const staff = await showStaffPickerModal({
        title: '발주 취소 — 담당자 선택',
        message: '발주 취소를 진행할 담당자를 선택해주세요.',
        groups: ['senior', 'office'],
      });
      if (!staff) return;

      await cancelOrder(row, lots, staff);
    });
  });
}

function showTenderInModal() {
  // 동결텐더 = 분리 작업 불필요한 동결건조 레시피 (requiresSeparation === false)
  const tenderRecipes = freezeDryRecipes.filter(r => r.requiresSeparation !== true);

  if (tenderRecipes.length === 0) {
    alert('동결텐더 레시피가 없습니다.\n\n레시피 관리 메뉴에서 동결건조 레시피의 "분리 작업 필요" 옵션을 끈 레시피를 추가해주세요.');
    return;
  }

  showModal(`
    <h3 class="modal-title">텐더동결 입고</h3>
    <div class="form-row">
      <div class="form-group">
        <label>제품 *</label>
        <select id="m_recipe">
          <option value="">선택</option>
          ${tenderRecipes.map(r => `<option value="${r.displayName}">${r.displayName}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>동결판 수 *</label>
        <input type="number" id="m_qty" step="1" min="1" placeholder="예: 5" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>날짜</label>
        <input type="date" id="m_date" value="${getToday()}" />
      </div>
      <div class="form-group">
        <label>담당자 *</label>
        <select id="m_staff">
          <option value="">선택</option>
          ${getStaffOptions(['senior', 'office'])}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="(선택)" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveTenderIn">저장</button>
    </div>
  `);

  document.getElementById('btnSaveTenderIn').addEventListener('click', async () => {
    const productName = document.getElementById('m_recipe').value.trim();
    const qty = parseInt(document.getElementById('m_qty').value) || 0;
    const date = document.getElementById('m_date').value;
    const staffName = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value.trim();

    if (!productName) { alert('제품을 선택해주세요.'); return; }
    if (qty <= 0) { alert('동결판 수는 0보다 커야 합니다.'); return; }
    if (!date) { alert('날짜를 입력해주세요.'); return; }
    if (!staffName) { alert('담당자를 선택해주세요.'); return; }

    if (await blockIfClosed(date)) return;

    const now = new Date();

    try {
      // 1. frozenPanLots 신규 lot
      const lotRef = await addDoc(collection(db, 'frozenPanLots'), {
        productName,
        date,
        staffName,
        initialQty: qty,
        remaining: qty,
        closed: false,
        source: 'tenderIn',
        sourceRefId: null,  // tenderIn은 logId로 대체 (아래 setUpdate)
        note: note || null,
        createdAt: now,
        updatedAt: now,
      });

      // 2. frozenPanLogs 기록
      const logRef = await addDoc(collection(db, 'frozenPanLogs'), {
        type: 'tenderIn',
        date,
        productName,
        qty,
        before: 0,
        after: qty,
        lotId: lotRef.id,
        staffName,
        uid: null,
        note: note || null,
        reason: null,
        batchId: null,
        ledgerId: null,
        timestamp: now,
      });

      // 3. lot의 sourceRefId를 logId로 갱신 (추적용)
      await updateDoc(doc(db, 'frozenPanLots', lotRef.id), {
        sourceRefId: logRef.id,
      });

      // 4. stockLedger 저장
      await addDoc(collection(db, 'stockLedger'), {
        actionType: 'frozenPanTenderIn',
        actionId: logRef.id,
        timestamp: now,
        date,
        status: 'active',
        items: [{
          collection: 'frozenPanLots',
          docId: lotRef.id,
          field: 'remaining',
          delta: qty,
          before: 0,
          after: qty,
          label: `${productName} 동결판 (텐더동결 입고)`,
          stockUpdatedAtSnapshot: now,
          isNewDoc: true,
        }],
      });

      closeModal();
      await refreshFrozenPanLayout();
      alert('텐더동결 입고 완료!');

    } catch (err) {
      console.error('showTenderInModal 저장 에러:', err);
      alert(`저장 중 오류가 발생했습니다.\n\n${err.message}`);
    }
  });
}

function showBreadPanIncomingModal() {
  const breadPanRecipes = freezeDryRecipes.filter(r => r.requiresSeparation === true);

  if (breadPanRecipes.length === 0) {
    alert('동결생식 레시피가 없습니다.\n\n레시피 관리 메뉴에서 동결건조 레시피의 "분리 작업 필요" 옵션을 켜주세요.');
    return;
  }

  showModal(`
    <h3 class="modal-title">빵판 입고</h3>
    <div class="form-row">
      <div class="form-group">
        <label>레시피 *</label>
        <select id="m_recipe">
          <option value="">선택</option>
          ${breadPanRecipes.map(r => `<option value="${r.displayName}">${r.displayName}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>빵판 수 * (소수 2자리)</label>
        <input type="number" id="m_qty" step="0.01" min="0.01" placeholder="예: 4.5" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>날짜</label>
        <input type="date" id="m_date" value="${getToday()}" />
      </div>
      <div class="form-group">
        <label>담당자 *</label>
        <select id="m_staff">
          <option value="">선택</option>
          ${getStaffOptions(['senior', 'office'])}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="(선택)" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveBreadPanIncoming">저장</button>
    </div>
  `);

  document.getElementById('btnSaveBreadPanIncoming').addEventListener('click', async () => {
    const productName = document.getElementById('m_recipe').value.trim();
    const qty = round2(parseFloat(document.getElementById('m_qty').value) || 0);
    const date = document.getElementById('m_date').value;
    const staffName = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value.trim();

    if (!productName) { alert('레시피를 선택해주세요.'); return; }
    if (qty <= 0) { alert('빵판 수는 0보다 커야 합니다.'); return; }
    if (!date) { alert('날짜를 입력해주세요.'); return; }
    if (!staffName) { alert('담당자를 선택해주세요.'); return; }

    if (await blockIfClosed(date)) return;

    const now = new Date();

    // 1. breadPanLots 신규 lot
    const lotRef = await addDoc(collection(db, 'breadPanLots'), {
      productName,
      date,
      staffName,
      initialQty: qty,
      remaining: qty,
      closed: false,
      note: note || null,
      createdAt: now,
      updatedAt: now,
    });

    // 2. breadPanLogs 기록
    await addDoc(collection(db, 'breadPanLogs'), {
      type: 'incoming',
      date,
      productName,
      qty,
      before: 0,
      after: qty,
      lotId: lotRef.id,
      lotDate: date,  // ★ 신규 — 입고는 자기 자신이 lot 시작일
      expectedFrozenQty: null,
      actualFrozenQty: null,
      diff: null,
      staffName,
      uid: null,
      note: note || null,
      reason: null,
      batchId: null,
      ledgerId: null,
      timestamp: now,
    });

    closeModal();
    await refreshFrozenPanLayout();
    alert('빵판 입고 완료!');
  });
}

async function showBreadPanAdjustModal() {
  // 활성 lot 로드
  const allBreadLots = await loadBreadPanLots();

  if (allBreadLots.length === 0) {
    alert('조정할 빵판 lot이 없습니다.\n빵판 입고를 먼저 진행해주세요.');
    return;
  }

  // 제품별 lot 그룹핑 (드롭다운에 lot ID + 잔량 표시)
  const lotOptions = allBreadLots
    .sort((a, b) => {
      const nameDiff = a.productName.localeCompare(b.productName);
      if (nameDiff !== 0) return nameDiff;
      return a.date.localeCompare(b.date);
    })
    .map(l => `<option value="${l.id}">${l.productName} / ${l.date} / 잔량 ${l.remaining}개</option>`)
    .join('');

  showModal(`
    <h3 class="modal-title">빵판 수동 조정</h3>
    <div class="form-group">
      <label>대상 lot *</label>
      <select id="m_lot">
        <option value="">선택</option>
        ${lotOptions}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>조정 유형 *</label>
        <select id="m_adjustType">
          <option value="plus">+ 증가</option>
          <option value="minus">- 감소</option>
        </select>
      </div>
      <div class="form-group">
        <label>수량 * (소수 2자리)</label>
        <input type="number" id="m_qty" step="0.01" min="0.01" placeholder="예: 0.5" />
      </div>
    </div>
    <div class="form-group">
      <label>사유 *</label>
      <input type="text" id="m_reason" placeholder="예: 실측 차이 보정 / 분실" />
    </div>
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveBreadPanAdjust">저장</button>
    </div>
  `);

  document.getElementById('btnSaveBreadPanAdjust').addEventListener('click', async () => {
    const lotId = document.getElementById('m_lot').value;
    const adjustType = document.getElementById('m_adjustType').value;
    const qtyInput = round2(parseFloat(document.getElementById('m_qty').value) || 0);
    const reason = document.getElementById('m_reason').value.trim();
    const staffName = document.getElementById('m_staff').value;

    if (!lotId) { alert('대상 lot을 선택해주세요.'); return; }
    if (qtyInput <= 0) { alert('수량은 0보다 커야 합니다.'); return; }
    if (!reason) { alert('사유를 입력해주세요.'); return; }
    if (!staffName) { alert('담당자를 선택해주세요.'); return; }

    // 부호 적용
    const delta = adjustType === 'plus' ? qtyInput : -qtyInput;

    // lot 현재값 조회
    const lotSnap = await getDoc(doc(db, 'breadPanLots', lotId));
    if (!lotSnap.exists()) { alert('lot을 찾을 수 없습니다.'); return; }
    const lot = lotSnap.data();
    const lotDate = lot.date;

    if (await blockIfClosed(getToday())) return;

    const before = lot.remaining || 0;
    const after = round2(before + delta);

    // [음수 차단] 정책 변경 — 모든 수동조정에서 음수 잔량 불허
    if (after < 0) {
      alert(`조정 후 잔량이 ${after}개가 됩니다.\n수동조정으로 음수 재고를 만들 수 없습니다.\n현재 ${before}개에서 최대 ${before}개까지만 감소 가능합니다.`);
      return;
    }

    const now = new Date();
    const today = getToday();

    // 1. lot 갱신
    await updateDoc(doc(db, 'breadPanLots', lotId), {
      remaining: after,
      closed: after <= 0.005,
      updatedAt: now,
    });

    // 2. breadPanLogs 기록
    await addDoc(collection(db, 'breadPanLogs'), {
      type: 'adjust',
      date: today,
      productName: lot.productName,
      qty: delta,
      before,
      after,
      lotId,
      lotDate: lot.date,  // ★ 신규 — 조정 대상 lot의 입고일
      expectedFrozenQty: null,
      actualFrozenQty: null,
      diff: null,
      staffName,
      uid: null,
      note: null,
      reason,
      batchId: null,
      ledgerId: null,
      timestamp: now,
    });

    closeModal();
    await refreshFrozenPanLayout();
    alert('수동 조정 완료!');
  });
}

async function showFrozenPanAdjustModal() {
  const allFrozenLots = await loadFrozenPanLots();

  if (allFrozenLots.length === 0) {
    alert('조정할 동결판 lot이 없습니다.\n동결판 입고를 먼저 진행해주세요.');
    return;
  }

  const lotOptions = allFrozenLots
    .sort((a, b) => {
      const nameDiff = a.productName.localeCompare(b.productName);
      if (nameDiff !== 0) return nameDiff;
      return a.date.localeCompare(b.date);
    })
    .map(l => `<option value="${l.id}">${l.productName} / ${l.date} / 잔량 ${l.remaining}개</option>`)
    .join('');

  showModal(`
    <h3 class="modal-title">동결판 수동 조정</h3>
    <div class="form-group">
      <label>대상 lot *</label>
      <select id="m_lot">
        <option value="">선택</option>
        ${lotOptions}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>조정 유형 *</label>
        <select id="m_adjustType">
          <option value="plus">+ 증가</option>
          <option value="minus">- 감소</option>
        </select>
      </div>
      <div class="form-group">
        <label>수량 * (정수)</label>
        <input type="number" id="m_qty" step="1" min="1" placeholder="예: 5" />
      </div>
    </div>
    <div class="form-group">
      <label>사유 *</label>
      <input type="text" id="m_reason" placeholder="예: 실측 차이 보정 / 분실" />
    </div>
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveFrozenPanAdjust">저장</button>
    </div>
  `);

  document.getElementById('btnSaveFrozenPanAdjust').addEventListener('click', async () => {
    const lotId = document.getElementById('m_lot').value;
    const adjustType = document.getElementById('m_adjustType').value;
    const qtyInput = parseInt(document.getElementById('m_qty').value, 10);
    const reason = document.getElementById('m_reason').value.trim();
    const staffName = document.getElementById('m_staff').value;

    if (!lotId) { alert('대상 lot을 선택해주세요.'); return; }
    if (!Number.isInteger(qtyInput) || qtyInput <= 0) { alert('수량은 0보다 큰 정수여야 합니다.'); return; }
    if (!reason) { alert('사유를 입력해주세요.'); return; }
    if (!staffName) { alert('담당자를 선택해주세요.'); return; }

    const delta = adjustType === 'plus' ? qtyInput : -qtyInput;
    const lotSnap = await getDoc(doc(db, 'frozenPanLots', lotId));
    if (!lotSnap.exists()) { alert('lot을 찾을 수 없습니다.'); return; }

    const lot = lotSnap.data();
    if (await blockIfClosed(getToday())) return;

    const before = Number(lot.remaining || 0);
    const after = before + delta;
    if (after < 0) {
      alert(`조정 후 잔량이 ${after}개가 됩니다.\n수동조정으로 음수 재고를 만들 수 없습니다.\n현재 ${before}개에서 최대 ${before}개까지만 감소 가능합니다.`);
      return;
    }

    const now = new Date();
    const today = getToday();
    const batch = writeBatch(db);

    batch.update(doc(db, 'frozenPanLots', lotId), {
      remaining: after,
      closed: after <= 0,
      updatedAt: now,
    });

    batch.set(doc(collection(db, 'frozenPanLogs')), {
      type: 'adjust',
      date: today,
      productName: lot.productName,
      qty: delta,
      before,
      after,
      lotId,
      staffName,
      uid: null,
      note: null,
      reason,
      batchId: null,
      ledgerId: null,
      timestamp: now,
    });

    await batch.commit();
    closeModal();
    await refreshFrozenPanLayout();
    alert('수동 조정 완료!');
  });
}

function renderPanRow(r) {
  if (r.status === 'cancelled') return '';
  const canCancelOrder = currentUserRole === 'admin' || currentUserRole === 'office';

  // 묶음 3 정책: 발주 행만 표시 (옛 work 행은 renderFrozenPanLayout에서 필터링됨)
  const isConfirmed = r.status === 'confirmed';

  const total = (r.items || []).reduce((sum, i) => sum + (i.orderPanQty || 0), 0);
  const color = total === 45 ? '#2d7a3a' : total > 45 ? '#e53e3e' : '#e67e22';
  const contentHtml = `
    ${(r.items || []).map(i => `<span style="font-size:11px;margin-right:8px">${i.productName}: ${i.orderPanQty}판</span>`).join('')}
    <span style="font-weight:600;color:${color}">총 ${total}판</span>
  `;

  let actionHtml = '';
  if (!isConfirmed) {
    actionHtml = `
      <button class="btn-primary btn-order-confirm" data-id="${r.id}" style="font-size:11px;padding:3px 10px;">발주 확인</button>
      <button class="btn-del-row btn-order-delete" data-id="${r.id}">삭제</button>
    `;
  } else {
    actionHtml = canCancelOrder
      ? `<button class="btn-secondary btn-order-cancel" data-id="${r.id}" style="font-size:11px;padding:3px 10px;">발주 취소</button>`
      : '';
  }

  return `
    <tr style="background:#fffdf0">
      <td>${r.date}</td>
      <td><span class="tag tag-cat">발주</span></td>
      <td>${r.staffName || '-'}</td>
      <td>${contentHtml}</td>
      <td>
        ${isConfirmed ? '<span style="color:#2d7a3a;font-size:12px">✅ 확인완료</span>' :
          '<span style="color:#e67e22;font-size:12px">⏳ 대기중</span>'}
      </td>
      <td style="white-space:nowrap">${actionHtml}</td>
    </tr>
  `;
}

async function showWorkRowModal(rows, lots) {
  // 빵판 lot 다시 로드 (최신 잔량 반영)
  const allBreadLots = await loadBreadPanLots();

  // 동결생식 레시피만 (분리 작업 필요한 것만)
  const breadPanRecipes = freezeDryRecipes.filter(r => r.requiresSeparation === true);

  if (breadPanRecipes.length === 0) {
    alert('동결생식 레시피가 없습니다.\n\n레시피 관리 메뉴에서 동결건조 레시피의 "분리 작업 필요" 옵션을 켜주세요.');
    return;
  }

  // 제품별 잔량 합계 + 가장 오래된 lot의 잔량 (default 채울 용)
  const productSummary = {};
  breadPanRecipes.forEach(r => {
    const productLots = allBreadLots
      .filter(l => l.productName === r.displayName && l.remaining > 0.005)
      .sort((a, b) => a.date.localeCompare(b.date));
    const total = round2(productLots.reduce((sum, l) => sum + l.remaining, 0));
    const oldestRemaining = productLots.length > 0 ? productLots[0].remaining : 0;
    productSummary[r.displayName] = { total, oldestRemaining };
  });

  showModal(`
    <h3 class="modal-title">작업 행 추가 (빵판 → 동결판 전처리)</h3>
    <div class="form-row">
      <div class="form-group">
        <label>날짜 *</label>
        <input type="date" id="m_date" value="${getToday()}" />
      </div>
      <div class="form-group">
        <label>담당자 *</label>
        <select id="m_staff">
          <option value="">선택</option>
          ${getStaffOptions(['senior', 'office'])}
        </select>
      </div>
    </div>

    <div style="font-size:12px;color:#666;background:#f9f9f9;padding:10px;border-radius:6px;margin-bottom:12px;">
      <strong>환산</strong>: 빵판 1개 → 동결판 4/9개 (≈0.44)<br>
      <strong>FIFO 적용</strong>: 같은 제품에 여러 lot이 있으면 오래된 lot부터 차감됩니다.<br>
      <strong>실측</strong>: 이론값과 실제 산출 동결판 수가 다르면 차이가 별도 기록됩니다.
    </div>

    <div id="workItems">
      ${renderWorkItemRow(breadPanRecipes, productSummary)}
    </div>
    <button class="btn-secondary" id="btnAddWorkItem" style="margin-bottom:16px;">+ 제품 추가</button>

    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="(선택)" />
    </div>

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveWorkRow">저장</button>
    </div>
  `);

  bindWorkItemEvents(productSummary);
  refreshAvailableProducts();

  document.getElementById('btnAddWorkItem').addEventListener('click', () => {
    document.getElementById('workItems').insertAdjacentHTML(
      'beforeend',
      renderWorkItemRow(breadPanRecipes, productSummary)
    );
    bindWorkItemEvents(productSummary);
    refreshAvailableProducts();
  });

  document.getElementById('btnSaveWorkRow').addEventListener('click', async () => {
    await handleWorkRowSave();
  });
}

async function handleWorkRowSave() {
  const date = document.getElementById('m_date').value;
  const staffName = document.getElementById('m_staff').value;
  const note = document.getElementById('m_note').value.trim();

  // 입력 수집
  const items = Array.from(document.querySelectorAll('.work-item')).map(row => ({
    productName: row.querySelector('.wi-name').value.trim(),
    breadPanQty: round2(parseFloat(row.querySelector('.wi-bread').value) || 0),
    actualFrozenQty: parseInt(row.querySelector('.wi-actual').value) || 0,
  })).filter(i => i.productName);

  // 1. 기본 검증
  if (!date) { alert('날짜를 입력해주세요.'); return; }
  if (!staffName) { alert('담당자를 선택해주세요.'); return; }
  if (items.length === 0) { alert('제품을 1개 이상 입력해주세요.'); return; }

  for (const item of items) {
    if (item.breadPanQty <= 0) {
      alert(`${item.productName}: 출고 빵판 수가 입력되지 않았습니다.`);
      return;
    }
    if (item.actualFrozenQty <= 0) {
      alert(`${item.productName}: 실제 산출 동결판 수가 입력되지 않았습니다.`);
      return;
    }
  }

  // 2. 마감 가드
  if (await blockIfClosed(date)) return;

  // 3. 빵판 lot 재로드 (저장 직전 최신 잔량 확인)
  const allBreadLots = await loadBreadPanLots();

  // 4. 재고 부족 검증
  const shortages = [];
  for (const item of items) {
    const productLots = allBreadLots.filter(l => l.productName === item.productName);
    const totalAvail = round2(productLots.reduce((sum, l) => sum + l.remaining, 0));
    if (item.breadPanQty > totalAvail) {
      shortages.push(`${item.productName}: 잔량 ${totalAvail}개 / 요청 ${item.breadPanQty}개`);
    }
  }
  if (shortages.length > 0) {
    alert(`빵판 재고가 부족합니다.\n\n${shortages.join('\n')}`);
    return;
  }

  // 5. batchId 생성 (이 트랜잭션 전체를 묶는 ID)
  const batchId = `preprocess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date();
  const ledgerItems = [];

  try {
    // 6. 각 item 처리
    for (const item of items) {
      const expectedFrozenQty = breadToFrozenPan(item.breadPanQty);
      const diff = round2(item.actualFrozenQty - expectedFrozenQty);

      // 6-1. 빵판 lot FIFO 차감
      let toDeduct = item.breadPanQty;
      const productLots = allBreadLots
        .filter(l => l.productName === item.productName && l.remaining > 0.005)
        .sort((a, b) => a.date.localeCompare(b.date));

      for (const lot of productLots) {
        if (toDeduct <= 0.005) break;

        const deduct = round2(Math.min(lot.remaining, toDeduct));
        const before = lot.remaining;
        const after = round2(before - deduct);
        const stockUpdatedAt = new Date();

        // breadPanLots 갱신
        await updateDoc(doc(db, 'breadPanLots', lot.id), {
          remaining: after,
          closed: after <= 0.005,
          updatedAt: stockUpdatedAt,
        });

        // breadPanLogs 기록 (preprocess) — 한 lot당 1건
        // 첫 lot에만 expected/actual/diff 정보 (이론값은 item 전체 단위 기록)
        const isFirstLot = (lot.id === productLots[0].id);
        await addDoc(collection(db, 'breadPanLogs'), {
          type: 'preprocess',
          date,
          productName: item.productName,
          qty: -deduct,
          before,
          after,
          lotId: lot.id,
          lotDate: lot.date,  // ★ 신규 — 차감 대상 lot의 입고일 (어느 날 입고된 빵판이 빠졌는지)
          expectedFrozenQty: isFirstLot ? expectedFrozenQty : null,
          actualFrozenQty: isFirstLot ? item.actualFrozenQty : null,
          diff: isFirstLot ? diff : null,
          staffName,
          uid: null,
          note: note || null,
          reason: null,
          batchId,
          ledgerId: null,  // 아래 ledger 저장 후 일괄 갱신은 안 함 (단순화)
          timestamp: now,
        });

        // ledger items 누적
        ledgerItems.push({
          collection: 'breadPanLots',
          docId: lot.id,
          field: 'remaining',
          delta: -deduct,
          before,
          after,
          label: `${item.productName} 빵판 (${lot.date})`,
          stockUpdatedAtSnapshot: stockUpdatedAt,
        });

        toDeduct = round2(toDeduct - deduct);
      }

      // 6-2. 동결판 lot 신규 생성 (실측값으로)
      const newFrozenLotRef = await addDoc(collection(db, 'frozenPanLots'), {
        productName: item.productName,
        date,
        staffName,
        initialQty: item.actualFrozenQty,
        remaining: item.actualFrozenQty,
        closed: false,
        source: 'preprocess',
        sourceRefId: batchId,
        note: note || null,
        createdAt: now,
        updatedAt: now,
      });

      // frozenPanLogs 기록 (preprocess 입고)
      await addDoc(collection(db, 'frozenPanLogs'), {
        type: 'preprocess',
        date,
        productName: item.productName,
        qty: item.actualFrozenQty,
        before: 0,
        after: item.actualFrozenQty,
        lotId: newFrozenLotRef.id,
        staffName,
        uid: null,
        note: note || null,
        reason: null,
        batchId,
        ledgerId: null,
        timestamp: now,
      });

      // ledger items 누적 (frozenPanLots 신규 생성)
      ledgerItems.push({
        collection: 'frozenPanLots',
        docId: newFrozenLotRef.id,
        field: 'remaining',
        delta: item.actualFrozenQty,
        before: 0,
        after: item.actualFrozenQty,
        label: `${item.productName} 동결판 (신규 생성)`,
        stockUpdatedAtSnapshot: now,
        isNewDoc: true,
      });
    }

    // 7. stockLedger 1건 저장
    const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
      actionType: 'breadToFrozenPreprocess',
      actionId: batchId,
      timestamp: now,
      date,
      status: 'active',
      items: ledgerItems,
    });

    closeModal();
    await refreshFrozenPanLayout();
    alert('전처리 작업 저장 완료!');

  } catch (err) {
    console.error('handleWorkRowSave 에러:', err);
    alert(`저장 중 오류가 발생했습니다.\n\n${err.message}\n\n일부 데이터가 저장되었을 수 있으니 화면을 새로고침해서 확인해주세요.`);
  }
}

function renderWorkItemRow(breadPanRecipes, productSummary) {
  const recipeOptions = breadPanRecipes
    .map(r => `<option value="${r.displayName}">${r.displayName}</option>`)
    .join('');

  return `
    <div class="work-item">
      <div style="display:flex;gap:8px;align-items:center;">
        <select class="wi-name cell-input" style="flex:1;min-width:0;">
          <option value="">제품 선택</option>
          ${recipeOptions}
        </select>
        <button class="btn-del-row wi-del" type="button">×</button>
      </div>
      <div class="wi-stock-info" style="font-size:11px;color:#888;padding-left:2px;margin:6px 0;">제품을 선택하세요</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 60px;gap:8px;align-items:end;">
        <div>
          <label style="font-size:11px;color:#555;display:block;margin-bottom:2px;">출고 빵판 수 *</label>
          <input type="number" class="wi-bread cell-input" step="0.01" min="0.01" placeholder="빵판" />
        </div>
        <div>
          <label style="font-size:11px;color:#555;display:block;margin-bottom:2px;">이론 동결판 (×4/9)</label>
          <input type="number" class="wi-expected cell-input" readonly placeholder="-" />
        </div>
        <div>
          <label style="font-size:11px;color:#555;display:block;margin-bottom:2px;">실제 산출 동결판 *</label>
          <input type="number" class="wi-actual cell-input" step="1" min="0" placeholder="실측" />
        </div>
        <div>
          <label style="font-size:11px;color:#555;display:block;margin-bottom:2px;">차이</label>
          <span class="wi-diff" style="display:inline-block;line-height:32px;font-size:13px;color:#888;">-</span>
        </div>
      </div>
    </div>
  `;
}

function bindWorkItemEvents(productSummary) {
  document.querySelectorAll('.wi-del').forEach(btn => {
    btn.onclick = () => {
      btn.closest('.work-item').remove();
      refreshAvailableProducts();
    };
  });

  document.querySelectorAll('.work-item').forEach(item => {
    const nameEl = item.querySelector('.wi-name');
    const breadEl = item.querySelector('.wi-bread');
    const expectedEl = item.querySelector('.wi-expected');
    const actualEl = item.querySelector('.wi-actual');
    const diffEl = item.querySelector('.wi-diff');
    const stockInfoEl = item.querySelector('.wi-stock-info');

    // 제품 선택 시 잔량 표시 + default 빵판 수 채우기
    nameEl.onchange = () => {
      const productName = nameEl.value;
      const summary = productSummary[productName];

      if (!summary || summary.total <= 0) {
        stockInfoEl.textContent = productName ? '⚠️ 빵판 lot 없음' : '제품을 선택하세요';
        stockInfoEl.style.color = productName ? '#e53e3e' : '#888';
        breadEl.value = '';
        breadEl.max = '';
      } else {
        stockInfoEl.textContent = `현재 잔량 ${summary.total}개 (가장 오래된 lot ${summary.oldestRemaining}개)`;
        stockInfoEl.style.color = '#2d7a3a';
        // default: 가장 오래된 lot의 잔량 (B안 — 99% batch 전체 사용)
        breadEl.value = summary.oldestRemaining;
        breadEl.max = summary.total;
        recalcRow(item);
      }

      // 다른 카드에서 같은 제품 선택 못하도록 옵션 갱신
      refreshAvailableProducts();
    };

    // 빵판 수 변경 시 이론값 자동 계산
    breadEl.oninput = () => {
      recalcRow(item);
    };

    // 실측값 변경 시 차이 계산
    actualEl.oninput = () => {
      recalcRow(item);
    };
  });
}

function refreshAvailableProducts() {
  // 현재 선택된 제품 목록
  const selectedProducts = new Set();
  document.querySelectorAll('.work-item .wi-name').forEach(sel => {
    if (sel.value) selectedProducts.add(sel.value);
  });

  // 각 select의 옵션 disabled 처리
  document.querySelectorAll('.work-item .wi-name').forEach(sel => {
    const currentValue = sel.value;
    Array.from(sel.options).forEach(opt => {
      if (!opt.value) return; // 빈 placeholder 옵션은 항상 활성
      // 본인이 선택한 옵션은 활성, 다른 카드가 이미 선택한 옵션은 비활성
      opt.disabled = opt.value !== currentValue && selectedProducts.has(opt.value);
    });
  });
}

function recalcRow(item) {
  const breadEl = item.querySelector('.wi-bread');
  const expectedEl = item.querySelector('.wi-expected');
  const actualEl = item.querySelector('.wi-actual');
  const diffEl = item.querySelector('.wi-diff');

  const breadQty = round2(parseFloat(breadEl.value) || 0);
  const expected = breadToFrozenPan(breadQty);
  expectedEl.value = expected;

  const actual = parseInt(actualEl.value);
  if (isNaN(actual) || actualEl.value === '') {
    diffEl.textContent = '-';
    diffEl.style.color = '#888';
    return;
  }

  const diff = round2(actual - expected);
  const sign = diff > 0 ? '+' : '';
  diffEl.textContent = `${sign}${diff}`;

  if (diff === 0) {
    diffEl.style.color = '#2d7a3a';
  } else if (Math.abs(diff) <= 0.5) {
    diffEl.style.color = '#888';
  } else {
    diffEl.style.color = '#e67e22';
  }
}



async function confirmOrder(row, lots, staff) {
  const items = row.items || [];

  // 발주 확인 시점 재고 재검증 (등록 후 시간 경과로 재고 변동 가능)
  const shortages = [];
  for (const item of items) {
    const productLots = lots.filter(l => l.productName === item.productName);
    const totalAvail = productLots.reduce((sum, l) => sum + l.remaining, 0);
    if (item.orderPanQty > totalAvail) {
      shortages.push(`${item.productName}: 현재 재고 ${totalAvail}판 / 발주 ${item.orderPanQty}판`);
    }
  }
  if (shortages.length > 0) {
    alert(`재고가 부족하여 발주 확인할 수 없습니다.\n\n${shortages.join('\n')}\n\n발주를 삭제하거나 작업 행을 먼저 추가하세요.`);
    return;
  }

  // FIFO 차감 + ledger items 누적
  const ledgerItems = [];
  for (const item of items) {
    let remaining = item.orderPanQty;
    const productLots = lots
      .filter(l => l.productName === item.productName)
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const lot of productLots) {
      if (remaining <= 0) break;
      const deduct = Math.min(lot.remaining, remaining);
      const before = lot.remaining;
      const after = before - deduct;
      const stockUpdatedAt = new Date();

      await updateDoc(doc(db, 'frozenPanLots', lot.id), {
        remaining: after,
        closed: after <= 0,
        updatedAt: stockUpdatedAt,
      });

      ledgerItems.push({
        collection: 'frozenPanLots',
        docId: lot.id,
        field: 'remaining',
        delta: -deduct,
        before,
        after,
        label: `${item.productName} (${lot.date || '-'})`,
        stockUpdatedAtSnapshot: stockUpdatedAt,
      });

      remaining -= deduct;
    }
  }

  // ledger 저장
  let ledgerId = null;
  if (ledgerItems.length > 0) {
    const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
      actionType: 'frozenPanOrder',
      actionId: row.id,
      timestamp: new Date(),
      date: row.date || '',
      status: 'active',
      items: ledgerItems,
    });
    ledgerId = ledgerRef.id;
  }

  // [묶음 5B] confirmStaff 필드 추가 — 누가 발주 확인했는지 frozenPanStock에 영구 저장
  await updateDoc(doc(db, 'frozenPanStock', row.id), {
    status: 'confirmed',
    ledgerId,
    confirmStaff: staff,
    confirmedAt: new Date(),
    updatedAt: new Date(),
  });

  // [묶음 5B] 사무 로그 발행 — 동결판 발주 확인 (표준 recordActivity 통일)
  const itemsLabel = items.map(it => `${it.productName} ${it.orderPanQty}판`).join(', ');
  await recordActivity({
    action: 'frozenPan',
    subAction: 'orderConfirm',
    date: row.date || getToday(),
    staff,
    message: `동결판 발주 확인 — ${itemsLabel} / 담당: ${staff}`,
    details: {
      frozenPanStockId: row.id,
      orderDate: row.date || null,
      items,
      ledgerId,
    },
  });

  await refreshFrozenPanLayout();
  alert('발주 확인 완료!');
}

async function cancelOrder(row, lots, staff) {
  // [권한 매트릭스] production은 발주 취소 불가
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
    alert('발주 취소는 대표/사무실 계정만 가능합니다.');
    return;
  }

  const reason = await showPromptModal({
    title: '발주 취소',
    message: '취소 후에는 차감된 동결판 재고가 복원됩니다.',
    label: '취소 사유',
    placeholder: '예: 재고 부족, 일정 변경',
    required: true,
    multiline: true,
  });
  if (reason === null) return;

  // ledger 기반 정확 복원
  if (row.ledgerId) {
    const ledgerSnap = await getDoc(doc(db, 'stockLedger', row.ledgerId));
    if (ledgerSnap.exists() && ledgerSnap.data().status === 'active') {
      const ledgerItems = ledgerSnap.data().items || [];
      for (const item of ledgerItems) {
        const docSnap = await getDoc(doc(db, item.collection, item.docId));
        if (!docSnap.exists()) continue;
        const currentVal = docSnap.data()[item.field] || 0;

        if (currentVal !== item.after) {
          const ok = await showConfirmModal({
        title: '로그아웃 확인',
        message: '오늘 아직 마감되지 않았습니다.\n로그아웃해도 자동으로 마감되지 않습니다.\n\n로그아웃 하시겠습니까?',
        confirmText: '로그아웃',
      });
      if (!ok) return;
        }

        const restoredVal = currentVal - item.delta;
        await updateDoc(doc(db, item.collection, item.docId), {
          [item.field]: restoredVal,
          closed: restoredVal <= 0,
          updatedAt: new Date(),
        });
      }
      await updateDoc(doc(db, 'stockLedger', row.ledgerId), {
        status: 'rolledBack',
        rolledBackAt: new Date(),
      });
    }
  } else {
    // fallback: ledger 없는 기존 데이터 — 옛 분배 로직 (lot capacity 무시) 그대로 사용
    const items = row.items || [];
    for (const item of items) {
      const productLots = lots
        .filter(l => l.productName === item.productName && l.sourceRowId)
        .sort((a, b) => b.date.localeCompare(a.date));

      let toRestore = item.orderPanQty;
      for (const lot of productLots) {
        if (toRestore <= 0) break;
        const restore = Math.min(item.orderPanQty, toRestore);
        await updateDoc(doc(db, 'frozenPanLots', lot.id), {
          remaining: lot.remaining + restore,
          closed: false,
          updatedAt: new Date(),
        });
        toRestore -= restore;
      }
    }
  }

  // [묶음 5B] cancelStaff 필드 추가 — 누가 발주 취소했는지 frozenPanStock에 영구 저장
  await updateDoc(doc(db, 'frozenPanStock', row.id), {
    status: 'pending',
    cancelReason: reason,
    cancelStaff: staff,
    cancelledAt: new Date(),
    updatedAt: new Date(),
  });

  // [묶음 5B] 사무 로그 발행 — 동결판 발주 취소 (표준 recordActivity 통일)
  const items = row.items || [];
  const itemsLabel = items.map(it => `${it.productName} ${it.orderPanQty}판`).join(', ');
  await recordActivity({
    action: 'frozenPan',
    subAction: 'orderCancel',
    date: row.date || getToday(),
    staff,
    message: `동결판 발주 취소 — ${itemsLabel} / 사유: ${reason} / 담당: ${staff}`,
    details: {
      frozenPanStockId: row.id,
      orderDate: row.date || null,
      items,
      reason,
    },
  });

  await refreshFrozenPanLayout();
  alert('발주 취소 완료!');
}

// 유틸

// [묶음 5B] 담당자만 선택받는 미니 모달 (발주 확인/취소용)
// 프로젝트 표준 패턴: id="modalOverlay" + class="modal-box"
async function showStaffPickerModal({ title, message, groups }) {
  // staffCache 보장 (드롭다운이 비어있는 문제 방지)
  await loadStaffCache();

  return new Promise(resolve => {
    // 기존 모달 있으면 제거
    const existing = document.getElementById('modalOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modalOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:400px;padding:24px;">
        <h3 style="margin:0 0 12px 0;font-size:18px;font-weight:600;">${title}</h3>
        <p style="font-size:13px;color:#666;margin:0 0 20px 0;">${message}</p>
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:13px;font-weight:500;color:#333;margin-bottom:8px;">담당자 *</label>
          <select id="sp_staff" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:14px;">
            <option value="">선택</option>
            ${getStaffOptions(groups)}
          </select>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn-secondary" id="sp_cancel">취소</button>
          <button class="btn-primary" id="sp_ok">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (val) => {
      overlay.remove();
      resolve(val);
    };

    document.getElementById('sp_cancel').addEventListener('click', () => close(null));
    document.getElementById('sp_ok').addEventListener('click', () => {
      const staff = document.getElementById('sp_staff').value;
      if (!staff) { alert('담당자를 선택해주세요.'); return; }
      close(staff);
    });
  });
}

let staffCache = {};
async function loadStaffCache() {
  if (Object.keys(staffCache).length > 0) return;
  for (const key of ['senior', 'lead', 'office']) {
    const snap = await getDoc(doc(db, 'staffGroups', key));
    if (snap.exists()) staffCache[key] = snap.data().members || [];
  }
}

function getStaffOptions(groups) {
  let options = '';
  for (const g of groups) {
    const members = staffCache[g] || [];
    members.forEach(m => {
      options += `<option value="${m.name}">${m.name}</option>`;
    });
  }
  return options;
}

function showModal(html) {
  const existing = document.getElementById('modalOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'modalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(overlay);

  // 외부 클릭 닫힘 비활성화 (묶음 1F: 모달 사라짐 이슈 우회)
  // 명시적인 취소/저장 버튼으로만 닫힘
}

window.closeModal = function() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.remove();
};
