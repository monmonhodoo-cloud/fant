import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, query, orderBy, getDoc, setDoc, writeBatch
} from 'firebase/firestore';
import Sortable from 'sortablejs';
import { currentUserRole } from '../app.js';
import { getTodayKST as getToday } from '../utils/date.js';
import { getActiveFreezeDryRecipes, getRecipeOptionsHtml } from '../utils/recipe.js';
import { blockIfClosed } from '../utils/closingGuard.js';
import { showConfirmModal } from '../utils/modal.js';
import { recordActivity } from '../services/activityLogs.js';

let freezeDryRecipes = [];
const QTY_EPSILON = 0.000001;

export async function renderFrozenSep() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>동결 분리작업 로딩 중...</p></div>`;
  await loadStaffCache();
  freezeDryRecipes = await getActiveFreezeDryRecipes();
  const [stocks, logs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs(), loadSepProductOrder()]);
  renderFrozenSepLayout(stocks, logs);
}

async function loadFrozenSepStocks() {
  const q = query(collection(db, 'frozenSeparation'), orderBy('date', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.closed);
}

async function loadFrozenSepLogs() {
  const q = query(collection(db, 'frozenSeparationLogs'), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function getSummary(stocks) {
  const summary = {};
  stocks.forEach(s => {
    if (!summary[s.productName]) {
      summary[s.productName] = { notSeparated: 0, separated: 0, noSplit: 0 };
    }
    summary[s.productName][s.stockType] += Number(s.remaining || 0);
  });
  return summary;
}

function normalizeQty(qty) {
  return Math.round((Number(qty) || 0) * 1000000) / 1000000;
}

function formatQty(qty) {
  return normalizeQty(qty).toLocaleString('ko-KR', {
    maximumFractionDigits: 3,
  });
}

function parseQtyInput(id = 'm_qty') {
  const qty = Number(document.getElementById(id).value);
  return Number.isFinite(qty) ? qty : NaN;
}

function canDeleteFrozenSepStock() {
  return currentUserRole === 'admin' || currentUserRole === 'office';
}

function getStockTypeLabel(stockType) {
  if (stockType === 'notSeparated') return '분리X';
  if (stockType === 'separated') return '분리O';
  return '소분X';
}

function getStockTypeTagClass(stockType) {
  if (stockType === 'notSeparated') return 'tag-cat';
  if (stockType === 'separated') return 'tag-raw';
  return 'tag-freezeDry';
}

// 로그 1건이 (제품, 재고종류)별 잔량에 미치는 영향 [{stockType, delta}]
function getLogEffects(log) {
  const qty = Number(log.qty || 0);
  switch (log.type) {
    case 'incoming': return [{ stockType: log.toStockType, delta: qty }];
    case 'separate': return [
      { stockType: log.fromStockType, delta: -qty },
      { stockType: log.toStockType, delta: qty },
    ];
    case 'out': return [{ stockType: log.fromStockType, delta: -qty }];
    case 'adjust': return [{ stockType: log.fromStockType, delta: qty }];   // qty = signed delta
    case 'delete': return [{ stockType: log.fromStockType, delta: qty }];   // qty stored negative
    default: return [];
  }
}

// 현재 잔량에서 로그를 역순으로 걸어가며 각 로그 시점의 "작업 후 잔량" 계산.
// logs: timestamp desc 정렬. 반환: log.id -> { [stockType]: balanceAfter }
function computeBalancesAfter(stocks, logs) {
  const bal = {};
  stocks.forEach(s => {
    const key = `${s.productName}|${s.stockType}`;
    bal[key] = normalizeQty((bal[key] || 0) + Number(s.remaining || 0));
  });

  const result = {};
  for (const log of logs) {
    const effects = getLogEffects(log);
    const after = {};
    effects.forEach(e => {
      if (!e.stockType) return;
      const key = `${log.productName}|${e.stockType}`;
      after[e.stockType] = normalizeQty(bal[key] || 0);
      // 이 로그 이전 상태로 되돌리기
      bal[key] = normalizeQty((bal[key] || 0) - e.delta);
    });
    result[log.id] = after;
  }
  return result;
}

function getLogTypeLabel(type) {
  return { incoming: '입고', separate: '분리', out: '출고', adjust: '조정', delete: '삭제' }[type] || type;
}

function getLogTypeColor(type) {
  return {
    incoming: '#2d7a3a', separate: '#1f6fb2', out: '#b97a1f',
    adjust: '#8a5fbf', delete: '#e53e3e',
  }[type] || '#555';
}

// 재고 종류별 색상 (뱃지 / 진행률 바)
const STOCK_TYPE_STYLE = {
  notSeparated: { bar: '#EF9F27', bg: '#fdf3e0', text: '#b97a1f' },
  separated:    { bar: '#1D9E75', bg: '#e8f5ea', text: '#2d7a3a' },
  noSplit:      { bar: '#378ADD', bg: '#e8f0fc', text: '#2d4a8a' },
};

// 펼침 상태 (재렌더 간 유지)
const expandedSepProducts = new Set();

// 뷰 모드: 'daily' (일별 현황) | 'product' (제품별 이력)
let sepViewMode = 'daily';

// 제품 열 순서 (settings/frozenSepProductOrder, 전 계정 공유)
let sepProductOrder = [];

async function loadSepProductOrder() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'frozenSepProductOrder'));
    sepProductOrder = snap.exists() ? (snap.data().order || []) : [];
  } catch (err) {
    console.error('loadSepProductOrder:', err);
    sepProductOrder = [];
  }
}

function sortProductNames(names) {
  return [...names].sort((a, b) => {
    const ia = sepProductOrder.indexOf(a);
    const ib = sepProductOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'ko');
  });
}

// 날짜별 마감 잔량 스냅샷 계산 — 현재 잔량에서 로그를 날짜 역순으로 걷어냄
// 반환: { dates: [desc], snapshots: {date: {product|stockType: qty}}, staffByDate: {date: '...'} }
function computeDailySnapshots(stocks, logs) {
  const bal = {};
  stocks.forEach(s => {
    const key = `${s.productName}|${s.stockType}`;
    bal[key] = normalizeQty((bal[key] || 0) + Number(s.remaining || 0));
  });

  const logDates = [...new Set(logs.map(l => l.date).filter(Boolean))].sort().reverse();
  const today = getToday();
  const dates = logDates.includes(today) ? logDates : [today, ...logDates.filter(d => d < today)];

  // 날짜 내림차순으로 걷어내기 위한 로그 정렬 (date desc)
  const sorted = [...logs].filter(l => l.date).sort((a, b) => b.date.localeCompare(a.date));
  let idx = 0;

  const snapshots = {};
  const staffByDate = {};
  for (const d of dates) {
    // d보다 나중 날짜의 로그를 현재 잔량에서 제거
    while (idx < sorted.length && sorted[idx].date > d) {
      const log = sorted[idx];
      getLogEffects(log).forEach(e => {
        if (!e.stockType) return;
        const key = `${log.productName}|${e.stockType}`;
        bal[key] = normalizeQty((bal[key] || 0) - e.delta);
      });
      idx++;
    }
    snapshots[d] = { ...bal };
    const dayStaff = [...new Set(logs.filter(l => l.date === d).map(l => l.staffName).filter(Boolean))];
    staffByDate[d] = dayStaff.join(', ');
  }
  return { dates, snapshots, staffByDate };
}

function renderFrozenSepLayout(stocks, logs = []) {
  const content = document.getElementById('mainContent');
  const canDelete = canDeleteFrozenSepStock();
  const balances = computeBalancesAfter(stocks, logs);

  // 제품 목록: 재고 + 이력에 등장하는 모든 제품
  const productNames = sortProductNames([...new Set([
    ...stocks.map(s => s.productName),
    ...logs.map(l => l.productName).filter(Boolean),
  ])]);

  content.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <h2 class="page-title">동결 분리작업</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn-secondary" id="btnAdjust">수동 조정</button>
          <button class="btn-secondary" id="btnOut">출고</button>
          <button class="btn-secondary" id="btnSeparate">분리 작업</button>
          <button class="btn-primary" id="btnIncoming">+ 원물 입고</button>
        </div>
      </div>

      <!-- 뷰 전환 탭 -->
      <div style="display:flex;gap:0;border-bottom:2px solid #e8e8e8;margin-bottom:16px;">
        <button class="sep-view-tab" data-view="daily"
          style="padding:10px 20px;background:${sepViewMode === 'daily' ? '#fff' : '#f5f5f5'};border:1px solid #e8e8e8;border-bottom:${sepViewMode === 'daily' ? '2px solid white' : 'none'};margin-bottom:-2px;font-size:14px;cursor:pointer;font-weight:${sepViewMode === 'daily' ? '600' : '400'};color:${sepViewMode === 'daily' ? '#1a1a1a' : '#888'};">
          일별 현황
        </button>
        <button class="sep-view-tab" data-view="product"
          style="padding:10px 20px;background:${sepViewMode === 'product' ? '#fff' : '#f5f5f5'};border:1px solid #e8e8e8;border-bottom:${sepViewMode === 'product' ? '2px solid white' : 'none'};margin-bottom:-2px;font-size:14px;cursor:pointer;font-weight:${sepViewMode === 'product' ? '600' : '400'};color:${sepViewMode === 'product' ? '#1a1a1a' : '#888'};">
          제품별 이력
        </button>
      </div>

      ${sepViewMode === 'daily'
        ? renderDailyMatrix(stocks, logs, productNames)
        : `<div style="display:flex;flex-direction:column;gap:12px;">
            ${productNames.length === 0
              ? '<div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:32px;text-align:center;color:#aaa;font-size:13px;">등록된 재고/이력 없음</div>'
              : productNames.map(name => renderProductCard(name, stocks, logs, balances, canDelete)).join('')}
          </div>`}
    </div>
  `;

  document.getElementById('btnIncoming').addEventListener('click', () => showIncomingModal(stocks));
  document.getElementById('btnSeparate').addEventListener('click', () => showSeparateModal(stocks));
  document.getElementById('btnOut').addEventListener('click', () => showOutModal(stocks));
  document.getElementById('btnAdjust').addEventListener('click', () => showAdjustModal(stocks));

  // 제품 열 드래그 정렬 (admin/office만)
  const headRow = document.getElementById('sepMatrixHeadRow');
  if (headRow && canDelete) {
    new Sortable(headRow, {
      animation: 150,
      draggable: '.sep-col-th',
      direction: 'horizontal',
      onEnd: async () => {
        const newOrder = [...headRow.querySelectorAll('.sep-col-th')].map(th => th.dataset.product);
        sepProductOrder = newOrder;
        try {
          await setDoc(doc(db, 'settings', 'frozenSepProductOrder'), {
            order: newOrder, updatedAt: new Date(),
          });
        } catch (err) {
          console.error('saveSepProductOrder:', err);
          alert('순서 저장 실패: ' + err.message);
        }
        renderFrozenSepLayout(stocks, logs);
      },
    });
  }

  // 뷰 전환
  document.querySelectorAll('.sep-view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      sepViewMode = btn.dataset.view;
      renderFrozenSepLayout(stocks, logs);
    });
  });

  // 카드 펼침/접힘
  document.querySelectorAll('.sep-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const name = header.dataset.product;
      if (expandedSepProducts.has(name)) expandedSepProducts.delete(name);
      else expandedSepProducts.add(name);
      renderFrozenSepLayout(stocks, logs);
    });
  });

  document.querySelectorAll('.btnDeleteFrozenSep').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const stock = stocks.find(s => s.id === btn.dataset.id);
      if (stock) deleteFrozenSepStock(stock);
    });
  });
}

// 일별 현황 매트릭스 — 행: 날짜, 열: 제품 × 재고종류, 셀: 그날 마감 잔량
function renderDailyMatrix(stocks, logs, productNames) {
  if (productNames.length === 0) {
    return '<div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:32px;text-align:center;color:#aaa;font-size:13px;">등록된 재고/이력 없음</div>';
  }

  const { dates, snapshots, staffByDate } = computeDailySnapshots(stocks, logs);

  // 제품별로 등장하는 재고 종류 수집 (분리O → 분리X → 소분X 순)
  const TYPE_ORDER = ['separated', 'notSeparated', 'noSplit'];
  const productTypes = {};
  productNames.forEach(p => { productTypes[p] = new Set(); });
  stocks.forEach(s => productTypes[s.productName]?.add(s.stockType));
  logs.forEach(l => {
    getLogEffects(l).forEach(e => {
      if (e.stockType) productTypes[l.productName]?.add(e.stockType);
    });
  });
  const columns = []; // [{product, stockType}]
  productNames.forEach(p => {
    const types = TYPE_ORDER.filter(t => productTypes[p].has(t));
    (types.length ? types : ['notSeparated']).forEach(t => columns.push({ product: p, stockType: t }));
  });

  // 제품 헤더 색상 (연한 파스텔 순환)
  const PRODUCT_HEADER_BG = ['#fdf3e0', '#e8f0fc', '#e8f5ea', '#f3ecfa', '#fbeaea', '#e9f6f4'];

  const canDrag = canDeleteFrozenSepStock();
  const productHeaderCells = productNames.map((p, i) => {
    const span = TYPE_ORDER.filter(t => productTypes[p].has(t)).length || 1;
    return `<th colspan="${span}" class="sep-col-th" data-product="${p}" style="background:${PRODUCT_HEADER_BG[i % PRODUCT_HEADER_BG.length]};font-size:12px;padding:8px 6px;border:1px solid #e0e0e0;text-align:center;min-width:${span * 58}px;${canDrag ? 'cursor:grab;' : ''}" ${canDrag ? 'title="드래그로 순서 변경"' : ''}>${p}</th>`;
  }).join('');

  const typeHeaderCells = columns.map(c => {
    const style = STOCK_TYPE_STYLE[c.stockType] || STOCK_TYPE_STYLE.notSeparated;
    return `<th style="background:${style.bg};color:${style.text};font-size:11px;padding:5px 4px;border:1px solid #e0e0e0;text-align:center;">${getStockTypeLabel(c.stockType)}</th>`;
  }).join('');

  const bodyRows = dates.map(d => {
    const snap = snapshots[d] || {};
    const cells = columns.map(c => {
      const v = snap[`${c.product}|${c.stockType}`] || 0;
      return `<td style="border:1px solid #eee;text-align:center;padding:8px 4px;font-size:12.5px;${v > QTY_EPSILON ? 'font-weight:600;color:#333;' : 'color:#ddd;'}">${v > QTY_EPSILON ? formatQty(v) : ''}</td>`;
    }).join('');
    return `
      <tr>
        <td style="border:1px solid #eee;text-align:center;padding:8px 6px;font-size:12px;font-weight:600;color:#555;white-space:nowrap;">${d.slice(5).replace('-', '/')}</td>
        <td style="border:1px solid #eee;text-align:center;padding:8px 6px;font-size:12px;color:#888;white-space:nowrap;">${staffByDate[d] || '-'}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return `
    <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr id="sepMatrixHeadRow">
            <th rowspan="2" style="background:#fbfaf5;font-size:12px;padding:8px;border:1px solid #e0e0e0;min-width:56px;">날짜</th>
            <th rowspan="2" style="background:#fbfaf5;font-size:12px;padding:8px;border:1px solid #e0e0e0;min-width:80px;">작업 담당자</th>
            ${productHeaderCells}
          </tr>
          <tr>${typeHeaderCells}</tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p style="font-size:11px;color:#aaa;margin-top:8px;">각 칸은 해당 날짜 마감 시점의 잔량입니다. 현재 재고에서 작업 이력을 역산해 계산됩니다.</p>
  `;
}

function renderProductCard(name, stocks, logs, balances, canDelete) {
  const expanded = expandedSepProducts.has(name);
  const myStocks = stocks.filter(s => s.productName === name);
  const myLogs = logs.filter(l => l.productName === name);

  // 현재 잔량 (재고종류별)
  const current = {};
  myStocks.forEach(s => {
    current[s.stockType] = normalizeQty((current[s.stockType] || 0) + Number(s.remaining || 0));
  });

  // 누적 합계
  let cumIn = 0, cumSep = 0, cumOut = 0, cumAdjust = 0;
  myLogs.forEach(l => {
    const q = Number(l.qty || 0);
    if (l.type === 'incoming') cumIn += q;
    else if (l.type === 'separate') cumSep += q;
    else if (l.type === 'out') cumOut += q;
    else if (l.type === 'adjust' || l.type === 'delete') cumAdjust += q;
  });

  const cumParts = [`누적 입고 <b style="font-weight:600;color:#333;">${formatQty(cumIn)}개</b>`];
  if (cumSep > 0) cumParts.push(`분리 완료 <b style="font-weight:600;color:#333;">${formatQty(cumSep)}개</b>`);
  cumParts.push(`출고 <b style="font-weight:600;color:#333;">${formatQty(cumOut)}개</b>`);
  if (Math.abs(cumAdjust) > QTY_EPSILON) cumParts.push(`조정 <b style="font-weight:600;color:#333;">${cumAdjust > 0 ? '+' : ''}${formatQty(cumAdjust)}개</b>`);

  const badges = Object.entries(current)
    .filter(([, v]) => v > QTY_EPSILON)
    .map(([st, v]) => {
      const style = STOCK_TYPE_STYLE[st] || STOCK_TYPE_STYLE.notSeparated;
      return `<span style="background:${style.bg};color:${style.text};font-size:11px;padding:3px 10px;border-radius:10px;white-space:nowrap;">${getStockTypeLabel(st)} ${formatQty(v)}</span>`;
    }).join('');

  // 진행률 바 (현재 잔량 구성비)
  const totalCurrent = Object.values(current).reduce((s, v) => s + v, 0);
  const barSegments = totalCurrent > QTY_EPSILON
    ? Object.entries(current)
        .filter(([, v]) => v > QTY_EPSILON)
        .map(([st, v]) => {
          const style = STOCK_TYPE_STYLE[st] || STOCK_TYPE_STYLE.notSeparated;
          const pct = (v / totalCurrent) * 100;
          return { st, pct, color: style.bar };
        })
    : [];

  const barHtml = barSegments.length > 0 ? `
    <div style="padding:0 18px 8px;">
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:#f5f5f5;">
        ${barSegments.map(seg => `<div style="width:${seg.pct}%;background:${seg.color};"></div>`).join('')}
      </div>
      <div style="display:flex;gap:14px;margin-top:5px;font-size:11px;color:#999;">
        ${barSegments.map(seg => `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${seg.color};margin-right:4px;"></span>${getStockTypeLabel(seg.st)} ${Math.round(seg.pct)}%</span>`).join('')}
      </div>
    </div>
  ` : '';

  // 통장식 이력 (이전 → 이후)
  const ledgerRows = myLogs.map(log => {
    const qty = Number(log.qty || 0);
    const after = balances[log.id] || {};
    const effects = getLogEffects(log);

    let desc = '';
    if (log.type === 'incoming') desc = `${getStockTypeLabel(log.toStockType)} +${formatQty(qty)}개`;
    else if (log.type === 'separate') desc = `분리X → 분리O ${formatQty(qty)}개`;
    else if (log.type === 'out') desc = `${getStockTypeLabel(log.fromStockType)} -${formatQty(qty)}개`;
    else if (log.type === 'adjust') desc = `${getStockTypeLabel(log.fromStockType)} ${qty >= 0 ? '+' : ''}${formatQty(qty)}개`;
    else if (log.type === 'delete') desc = `${getStockTypeLabel(log.fromStockType)} ${formatQty(qty)}개`;

    const flowText = effects
      .filter(e => e.stockType && after[e.stockType] !== undefined)
      .map(e => {
        const afterV = after[e.stockType];
        const beforeV = normalizeQty(afterV - e.delta);
        return `${getStockTypeLabel(e.stockType)} ${formatQty(beforeV)} → <b style="font-weight:600;color:#333;">${formatQty(afterV)}</b>`;
      }).join(' · ') || '-';

    return `
      <tr style="border-top:1px solid #f0f0f0;">
        <td style="padding:7px 0;color:#999;font-size:12px;width:76px;">${(log.date || '').slice(5) || '-'}</td>
        <td style="width:48px;"><span style="color:${getLogTypeColor(log.type)};font-weight:600;font-size:12px;">${getLogTypeLabel(log.type)}</span></td>
        <td style="font-size:12.5px;">${desc}</td>
        <td style="text-align:right;color:#888;font-size:12px;">${flowText}</td>
        <td style="text-align:right;color:#999;font-size:12px;width:64px;">${log.staffName || '-'}</td>
      </tr>
    `;
  }).join('');

  // 현재 lot 상세 (삭제 버튼 포함)
  const lotRows = myStocks.map(s => `
    <tr style="border-top:1px solid #f0f0f0;">
      <td style="padding:6px 0;color:#999;font-size:12px;width:90px;">${s.date}</td>
      <td style="width:60px;"><span class="tag ${getStockTypeTagClass(s.stockType)}" style="font-size:10px;">${getStockTypeLabel(s.stockType)}</span></td>
      <td style="font-size:12.5px;font-weight:600;">${formatQty(s.remaining)}개 <span style="font-weight:400;font-size:11px;color:#999;">/ 최초 ${formatQty(s.initialQty)}개</span></td>
      <td style="color:#999;font-size:12px;">${s.staffName || '-'}</td>
      <td style="color:#999;font-size:12px;">${s.note || '-'}</td>
      ${canDelete ? `<td style="text-align:right;width:52px;"><button class="btn-del-row btnDeleteFrozenSep" data-id="${s.id}">삭제</button></td>` : ''}
    </tr>
  `).join('');

  return `
    <div style="background:white;border:1px solid #e8e8e8;border-radius:12px;overflow:hidden;">
      <div class="sep-card-header" data-product="${name}" style="padding:14px 18px;display:flex;align-items:center;gap:14px;cursor:pointer;user-select:none;">
        <span style="font-size:13px;color:#bbb;transform:rotate(${expanded ? '90deg' : '0deg'});transition:transform 0.15s;">▶</span>
        <span style="font-size:15px;font-weight:600;min-width:150px;">${name}</span>
        <span style="font-size:12px;color:#888;">${cumParts.join(' · ')}</span>
        <span style="margin-left:auto;display:flex;gap:6px;">${badges || '<span style="font-size:11px;color:#ccc;">재고 없음</span>'}</span>
      </div>
      ${expanded ? `
        ${barHtml}
        <div style="border-top:1px solid #f0f0f0;padding:10px 18px 14px;">
          <div style="font-size:12px;font-weight:600;color:#888;margin-bottom:4px;">작업 이력</div>
          <table style="width:100%;font-size:12.5px;border-collapse:collapse;">
            ${ledgerRows || '<tr><td style="padding:8px 0;color:#ccc;font-size:12px;">이력 없음</td></tr>'}
          </table>
        </div>
        ${myStocks.length > 0 ? `
          <div style="border-top:1px solid #f0f0f0;padding:10px 18px 14px;background:#fafafa;">
            <div style="font-size:12px;font-weight:600;color:#888;margin-bottom:4px;">현재 lot</div>
            <table style="width:100%;font-size:12.5px;border-collapse:collapse;">
              ${lotRows}
            </table>
          </div>
        ` : ''}
      ` : ''}
    </div>
  `;
}

async function deleteFrozenSepStock(stock) {
  if (!canDeleteFrozenSepStock()) {
    alert('삭제 권한이 없습니다.');
    return;
  }

  if (await blockIfClosed(stock.date)) return;

  const initialQty = Number(stock.initialQty || 0);
  const remainingQty = Number(stock.remaining || 0);
  if (remainingQty <= 0) {
    alert('삭제할 남은 수량이 없습니다.');
    return;
  }
  if (Math.abs(initialQty - remainingQty) > QTY_EPSILON) {
    alert('이미 일부 사용된 항목은 바로 삭제할 수 없습니다.\n관련 출고/분리 작업을 먼저 되돌리거나 수동 조정을 사용해주세요.');
    return;
  }

  const staff = window.prompt('삭제 담당자 이름을 입력해주세요.');
  if (!staff || !staff.trim()) return;

  const stockTypeLabel = getStockTypeLabel(stock.stockType);
  const ok = await showConfirmModal({
    title: '동결 분리작업 삭제',
    message: `${stock.productName} / ${stockTypeLabel} / ${formatQty(remainingQty)}개 항목을 삭제합니다.\n잘못 입력한 항목일 때만 진행해주세요.`,
    confirmText: '삭제',
    cancelText: '취소',
    danger: true,
  });
  if (!ok) return;

  const batch = writeBatch(db);
  const stockRef = doc(db, 'frozenSeparation', stock.id);
  const logRef = doc(collection(db, 'frozenSeparationLogs'));
  const now = new Date();
  const deleteStaff = staff.trim();

  batch.update(stockRef, {
    remaining: 0,
    closed: true,
    status: 'deleted',
    deletedAt: now,
    deletedBy: deleteStaff,
    updatedAt: now,
  });
  batch.set(logRef, {
    date: getToday(),
    timestamp: now,
    type: 'delete',
    productName: stock.productName,
    fromStockType: stock.stockType,
    qty: -remainingQty,
    staffName: deleteStaff,
    note: 'wrong input delete',
    sourceStockId: stock.id,
  });

  await batch.commit();

  await recordActivity({
    action: 'frozenSep',
    subAction: 'delete',
    date: getToday(),
    staff: deleteStaff,
    message: `동결 분리작업 삭제 — ${stock.productName} ${formatQty(remainingQty)}개 (${stockTypeLabel}) / 담당: ${deleteStaff}`,
    details: {
      frozenSeparationId: stock.id,
      productName: stock.productName,
      qty: remainingQty,
      stockType: stock.stockType,
      note: stock.note || null,
    },
  });

  const [newStocks, newLogs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs()]);
  renderFrozenSepLayout(newStocks, newLogs);
  alert('삭제 완료!');
}

function showIncomingModal(stocks) {
  showModal(`
    <h3 class="modal-title">원물 입고</h3>
    <div class="form-group">
      <label>제품명 *</label>
      <select id="m_name" onchange="updateSepGuide()">${getRecipeOptionsHtml(freezeDryRecipes)}</select>
    </div>
    <!-- [묶음 5C] 분리 필요/불필요 운영자 입력 제거 → 레시피 설정으로 자동 결정 + 안내 표시 -->
    <div class="form-group" id="m_sepGuide" style="background:#f7f7f7;border-radius:6px;padding:10px 12px;font-size:13px;color:#555;">
      제품을 선택하면 자동으로 결정됩니다.
    </div>
    <div class="form-group">
      <label>수량(개) *</label>
      <input type="number" id="m_qty" placeholder="예: 0.2" min="0" step="0.01" />
    </div>
    <div class="form-group">
      <label>날짜</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'office'])}
      </select>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="비고" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveIncoming">입고</button>
    </div>
  `);

  // [묶음 5C] 제품 선택 시 안내 텍스트 자동 업데이트
  // freezeDryRecipes에서 displayName으로 찾아서 requiresSeparation 보고 결정
  window.updateSepGuide = function() {
    const name = document.getElementById('m_name').value;
    const guideEl = document.getElementById('m_sepGuide');
    if (!name) {
      guideEl.innerHTML = '제품을 선택하면 자동으로 결정됩니다.';
      guideEl.style.color = '#555';
      return;
    }
    const recipe = freezeDryRecipes.find(r => r.displayName === name);
    if (!recipe) {
      guideEl.innerHTML = '⚠️ 레시피를 찾을 수 없습니다.';
      guideEl.style.color = '#c0392b';
      return;
    }
    if (recipe.requiresSeparation) {
      guideEl.innerHTML = `📌 이 제품은 <b>분리 작업이 필요</b>합니다 → <b style="color:#c0392b;">분리X</b>로 입고됩니다.`;
      guideEl.style.color = '#555';
    } else {
      guideEl.innerHTML = `📌 이 제품은 분리 작업이 불필요합니다 → <b style="color:#2d4a8a;">소분X</b>로 입고됩니다.`;
      guideEl.style.color = '#555';
    }
  };
  // 초기 1회 호출 (첫 옵션이 placeholder면 비고, 자동 선택된 게 있으면 안내 표시)
  updateSepGuide();

  document.getElementById('btnSaveIncoming').addEventListener('click', async () => {
    const name = document.getElementById('m_name').value.trim();
    const qty = parseQtyInput();
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value;

    if (!name || !Number.isFinite(qty) || qty <= 0 || !date) { alert('제품명, 수량, 날짜는 필수입니다.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }
    if (await blockIfClosed(date)) return;

    // [묶음 5C] 분리 필요 여부 자동 결정 (운영자 입력 대신 레시피 설정 사용)
    const recipe = freezeDryRecipes.find(r => r.displayName === name);
    if (!recipe) { alert('레시피를 찾을 수 없습니다. 레시피 관리에서 등록 여부를 확인해주세요.'); return; }
    const sepNeeded = recipe.requiresSeparation === true;

    const stockType = sepNeeded ? 'notSeparated' : 'noSplit';
    const stockTypeLabel = sepNeeded ? '분리X' : '소분X';

    const sepRef = await addDoc(collection(db, 'frozenSeparation'), {
      date, productName: name,
      stockType,
      initialQty: qty, remaining: qty,
      staffName: staff, note, closed: false,
      createdAt: new Date(), updatedAt: new Date(),
    });

    await addDoc(collection(db, 'frozenSeparationLogs'), {
      date, timestamp: new Date(),
      type: 'incoming', productName: name,
      toStockType: stockType,
      qty, staffName: staff, note,
    });

    // [묶음 5A] 사무 로그 발행 — 분리작업 원물 입고
    await recordActivity({
      action: 'frozenSep',
      subAction: 'incoming',
      date,
      staff,
      message: `분리작업 입고 — ${name} +${formatQty(qty)}개 (${stockTypeLabel}) / 담당: ${staff}`,
      details: {
        frozenSeparationId: sepRef.id,
        productName: name,
        qty,
        stockType,
        sepNeeded,
        autoDecided: true,  // [묶음 5C] 자동 결정 표시
        note: note || null,
      },
    });

    closeModal();
    const [newStocks, newLogs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs()]);
    renderFrozenSepLayout(newStocks, newLogs);
    alert('입고 완료!');
  });
}

function showSeparateModal(stocks) {
  const notSepStocks = stocks.filter(s => s.stockType === 'notSeparated');
  const products = [...new Set(notSepStocks.map(s => s.productName))];

  showModal(`
    <h3 class="modal-title">분리 작업</h3>
    <div class="form-group">
      <label>제품 *</label>
      <select id="m_product">
        <option value="">선택</option>
        ${products.map(p => {
          const total = notSepStocks
            .filter(s => s.productName === p)
            .reduce((sum, s) => sum + Number(s.remaining || 0), 0);
          return `<option value="${p}">${p} (분리X: ${formatQty(total)}개)</option>`;
        }).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>수량(개) *</label>
      <input type="number" id="m_qty" placeholder="예: 0.2" min="0" step="0.01" />
    </div>
    <div class="form-group">
      <label>날짜</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveSeparate">작업 완료</button>
    </div>
  `);

  document.getElementById('btnSaveSeparate').addEventListener('click', async () => {
    const productName = document.getElementById('m_product').value;
    const qty = parseQtyInput();
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;

    if (!productName || !Number.isFinite(qty) || qty <= 0 || !date) { alert('제품, 수량, 날짜는 필수입니다.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }
    if (await blockIfClosed(date)) return;

    const productStocks = notSepStocks
      .filter(s => s.productName === productName)
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalAvail = productStocks.reduce((sum, s) => sum + Number(s.remaining || 0), 0);

    if (qty - totalAvail > QTY_EPSILON) { alert(`분리X 재고가 부족합니다. (현재: ${formatQty(totalAvail)}개)`); return; }

    // FIFO 차감
    let remaining = qty;
    for (const s of productStocks) {
      if (remaining <= 0) break;
      const currentRemaining = Number(s.remaining || 0);
      const deduct = Math.min(currentRemaining, remaining);
      const after = normalizeQty(currentRemaining - deduct);
      await updateDoc(doc(db, 'frozenSeparation', s.id), {
        remaining: after,
        closed: after <= QTY_EPSILON,
        updatedAt: new Date(),
      });
      remaining = normalizeQty(remaining - deduct);
    }

    // 분리O 추가
    const sepRef = await addDoc(collection(db, 'frozenSeparation'), {
      date, productName,
      stockType: 'separated',
      initialQty: qty, remaining: qty,
      staffName: staff, note: '', closed: false,
      createdAt: new Date(), updatedAt: new Date(),
    });

    await addDoc(collection(db, 'frozenSeparationLogs'), {
      date, timestamp: new Date(),
      type: 'separate', productName,
      fromStockType: 'notSeparated',
      toStockType: 'separated',
      qty, staffName: staff,
    });

    // [묶음 5A] 사무 로그 발행 — 분리 작업 (분리X → 분리O 전환)
    await recordActivity({
      action: 'frozenSep',
      subAction: 'separate',
      date,
      staff,
      message: `분리 작업 — ${productName} ${formatQty(qty)}개 (분리X → 분리O) / 담당: ${staff}`,
      details: {
        newSeparatedId: sepRef.id,
        productName,
        qty,
        fromStockType: 'notSeparated',
        toStockType: 'separated',
      },
    });

    closeModal();
    const [newStocks, newLogs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs()]);
    renderFrozenSepLayout(newStocks, newLogs);
    alert('분리 작업 완료!');
  });
}

function showOutModal(stocks) {
  const outStocks = stocks.filter(s => s.stockType === 'separated' || s.stockType === 'noSplit');
  const products = [...new Set(outStocks.map(s => s.productName))];

  showModal(`
    <h3 class="modal-title">출고</h3>
    <div class="form-group">
      <label>제품 *</label>
      <select id="m_product" onchange="updateOutType()">
        <option value="">선택</option>
        ${products.map(p => `<option value="${p}">${p}</option>`).join('')}
      </select>
    </div>
    <!-- [묶음 5C] 재고 종류 운영자 입력 제거 → 레시피 설정으로 자동 결정 + 재고 안내 -->
    <div class="form-group" id="m_outGuide" style="background:#f7f7f7;border-radius:6px;padding:10px 12px;font-size:13px;color:#555;">
      제품을 선택하면 자동으로 결정됩니다.
    </div>
    <div class="form-group">
      <label>수량(개) *</label>
      <input type="number" id="m_qty" placeholder="예: 0.2" min="0" step="0.01" />
    </div>
    <div class="form-group">
      <label>날짜</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveOut">출고</button>
    </div>
  `);

  // [묶음 5C] 출고 재고 종류 자동 결정 + 안내 표시
  // 분리 필요 제품 → 분리O 재고에서 출고 / 분리 불필요 제품 → 소분X 재고에서 출고
  window.updateOutType = function() {
    const productName = document.getElementById('m_product').value;
    const guideEl = document.getElementById('m_outGuide');
    if (!productName) {
      guideEl.innerHTML = '제품을 선택하면 자동으로 결정됩니다.';
      guideEl.style.color = '#555';
      return;
    }
    const recipe = freezeDryRecipes.find(r => r.displayName === productName);
    if (!recipe) {
      guideEl.innerHTML = '⚠️ 레시피를 찾을 수 없습니다.';
      guideEl.style.color = '#c0392b';
      return;
    }
    const stockType = recipe.requiresSeparation ? 'separated' : 'noSplit';
    const stockTypeLabel = recipe.requiresSeparation ? '분리O' : '소분X';
    const labelColor = recipe.requiresSeparation ? '#2d7a3a' : '#2d4a8a';

    // 해당 재고 종류 잔량 계산 (사전 경고용)
    const avail = outStocks
      .filter(s => s.productName === productName && s.stockType === stockType)
      .reduce((sum, s) => sum + Number(s.remaining || 0), 0);

    if (avail <= QTY_EPSILON) {
      const hint = recipe.requiresSeparation
        ? '먼저 분리 작업이 필요합니다.'
        : '소분X 재고가 없습니다.';
      guideEl.innerHTML = `⚠️ <b style="color:${labelColor};">${stockTypeLabel}</b> 재고 없음 — ${hint}`;
      guideEl.style.color = '#c0392b';
    } else {
      guideEl.innerHTML = `📌 <b style="color:${labelColor};">${stockTypeLabel}</b> 재고에서 출고됩니다 (현재 ${formatQty(avail)}개 보유)`;
      guideEl.style.color = '#555';
    }
  };
  updateOutType();

  document.getElementById('btnSaveOut').addEventListener('click', async () => {
    const productName = document.getElementById('m_product').value;
    const qty = parseQtyInput();
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;

    if (!productName || !Number.isFinite(qty) || qty <= 0 || !date) { alert('제품, 수량, 날짜는 필수입니다.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }
    if (await blockIfClosed(date)) return;

    // [묶음 5C] 재고 종류 자동 결정 (운영자 입력 대신 레시피 설정 사용)
    const recipe = freezeDryRecipes.find(r => r.displayName === productName);
    if (!recipe) { alert('레시피를 찾을 수 없습니다. 레시피 관리에서 등록 여부를 확인해주세요.'); return; }
    const stockType = recipe.requiresSeparation ? 'separated' : 'noSplit';
    const stockTypeLabel = recipe.requiresSeparation ? '분리O' : '소분X';

    const targetStocks = outStocks
      .filter(s => s.productName === productName && s.stockType === stockType)
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalAvail = targetStocks.reduce((sum, s) => sum + Number(s.remaining || 0), 0);

    if (qty - totalAvail > QTY_EPSILON) {
      const hint = recipe.requiresSeparation
        ? '\n\n분리 작업을 먼저 진행해주세요.'
        : '';
      alert(`${stockTypeLabel} 재고가 부족합니다. (현재: ${formatQty(totalAvail)}개)${hint}`);
      return;
    }

    let remaining = qty;
    for (const s of targetStocks) {
      if (remaining <= 0) break;
      const currentRemaining = Number(s.remaining || 0);
      const deduct = Math.min(currentRemaining, remaining);
      const after = normalizeQty(currentRemaining - deduct);
      await updateDoc(doc(db, 'frozenSeparation', s.id), {
        remaining: after,
        closed: after <= QTY_EPSILON,
        updatedAt: new Date(),
      });
      remaining = normalizeQty(remaining - deduct);
    }

    await addDoc(collection(db, 'frozenSeparationLogs'), {
      date, timestamp: new Date(),
      type: 'out', productName,
      fromStockType: stockType,
      qty, staffName: staff,
    });

    // [묶음 5A] 사무 로그 발행 — 분리작업 출고
    await recordActivity({
      action: 'frozenSep',
      subAction: 'out',
      date,
      staff,
      message: `분리작업 출고 — ${productName} -${formatQty(qty)}개 (${stockTypeLabel}) / 담당: ${staff}`,
      details: {
        productName,
        qty,
        fromStockType: stockType,
        autoDecided: true,  // [묶음 5C] 자동 결정 표시
      },
    });

    closeModal();
    const [newStocks, newLogs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs()]);
    renderFrozenSepLayout(newStocks, newLogs);
    alert('출고 완료!');
  });
}

function showAdjustModal(stocks) {
  const products = [...new Set(stocks.map(s => s.productName))];

  showModal(`
    <h3 class="modal-title">수동 조정</h3>
    <div class="form-group">
      <label>제품 *</label>
      <select id="m_product">
        <option value="">선택</option>
        ${products.map(p => `<option value="${p}">${p}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>재고 종류 *</label>
      <select id="m_stockType">
        <option value="notSeparated">분리X</option>
        <option value="separated">분리O</option>
        <option value="noSplit">소분X</option>
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>조정 유형</label>
        <select id="m_adjustType">
          <option value="plus">+ 증가</option>
          <option value="minus">- 감소</option>
        </select>
      </div>
      <div class="form-group">
        <label>수량(개) *</label>
        <input type="number" id="m_qty" placeholder="예: 0.2" min="0" step="0.01" />
      </div>
    </div>
    <div class="form-group">
      <label>사유 *</label>
      <input type="text" id="m_reason" placeholder="조정 사유" />
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
      <button class="btn-primary" id="btnSaveAdjust">조정</button>
    </div>
  `);

  document.getElementById('btnSaveAdjust').addEventListener('click', async () => {
    const productName = document.getElementById('m_product').value;
    const stockType = document.getElementById('m_stockType').value;
    const adjustType = document.getElementById('m_adjustType').value;
    const qty = parseQtyInput();
    const reason = document.getElementById('m_reason').value.trim();
    const staff = document.getElementById('m_staff').value;

    if (!productName || !Number.isFinite(qty) || qty <= 0 || !reason || !staff) { alert('모든 필수 항목을 입력해주세요.'); return; }
    const today = getToday();
    if (await blockIfClosed(today)) return;

    const delta = adjustType === 'plus' ? qty : -qty;
    const targetStocks = stocks
      .filter(s => s.productName === productName && s.stockType === stockType)
      .sort((a, b) => a.date.localeCompare(b.date));

    // [음수 차단] 기존 lot이 있으면 그 lot의 잔량 + delta가 음수면 차단.
    // 신규 생성 분기는 마이너스로 신규 생성 자체를 차단해야 함.
    if (targetStocks.length > 0) {
      const s = targetStocks[0];
      const currentRemaining = Number(s.remaining || 0);
      const after = normalizeQty(currentRemaining + delta);
      if (after < -QTY_EPSILON) {
        alert(`조정 후 잔량이 ${formatQty(after)}개가 됩니다.\n수동조정으로 음수 재고를 만들 수 없습니다.\n현재 ${formatQty(currentRemaining)}개에서 최대 ${formatQty(currentRemaining)}개까지만 감소 가능합니다.`);
        return;
      }
      await updateDoc(doc(db, 'frozenSeparation', s.id), {
        remaining: after,
        closed: after <= QTY_EPSILON,
        updatedAt: new Date(),
      });
    } else {
      // 기존 lot 없는데 마이너스 조정 → 음수로 신규 생성 시도 → 차단
      if (delta < 0) {
        alert(`해당 제품/구분의 재고가 없습니다.\n수동조정으로 음수 재고를 만들 수 없습니다.`);
        return;
      }
      await addDoc(collection(db, 'frozenSeparation'), {
        date: getToday(), productName, stockType,
        initialQty: delta, remaining: delta,
        staffName: staff, note: reason, closed: false,
        createdAt: new Date(), updatedAt: new Date(),
      });
    }

    await addDoc(collection(db, 'frozenSeparationLogs'), {
      date: getToday(), timestamp: new Date(),
      type: 'adjust', productName,
      fromStockType: stockType,
      qty: delta, staffName: staff, reason,
    });
    
    const stockTypeLabel = getStockTypeLabel(stockType);
    const sign = delta >= 0 ? '+' : '';
    await recordActivity({
      action: 'frozenSep',
      subAction: 'adjust',
      date: today,
      staff,
      message: `동결 분리작업 수동조정 — ${productName} (${stockTypeLabel}) ${sign}${formatQty(delta)}개 / 사유: ${reason} / 담당: ${staff}`,
      details: {
        productName,
        stockType,
        delta,
        reason,
      },
    });

    closeModal();
    const [newStocks, newLogs] = await Promise.all([loadFrozenSepStocks(), loadFrozenSepLogs()]);
    renderFrozenSepLayout(newStocks, newLogs);
    alert('조정 완료!');
  });
}

// 유틸

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

  overlay.addEventListener('click', (e) => {
    // 외부 클릭 닫힘 비활성화 (묶음 1F: 모달 사라짐 이슈 우회)
  });
}

window.closeModal = function() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.remove();
};
