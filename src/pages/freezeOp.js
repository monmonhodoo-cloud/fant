import { db } from '../firebase.js';
import {
  collection, getDocs, doc, updateDoc, query, orderBy,
  writeBatch, increment
} from 'firebase/firestore';
import { getTodayKST as getToday } from '../utils/date.js';
import * as appState from '../app.js';
import { showConfirmModal } from '../utils/modal.js';

const SLOT_COLORS = [
  '#4299E1', '#48BB78', '#ED8936', '#9F7AEA', '#F56565',
  '#38B2AC', '#ECC94B', '#667EEA', '#FC8181', '#68D391',
  '#63B3ED', '#F6AD55', '#B794F4', '#FBD38D', '#90CDF4',
];
const TOTAL_SLOTS = 45;
const COLS = 3;

// Layout builder state (module-level — survives re-renders inside modal)
let _slots = new Array(TOTAL_SLOTS).fill(null);
let _activeProduct = null;
let _builderOrder = null;
let _colorMap = {};

// Tab mode flag — true when rendered inside frozenPan tab
let _tabMode = false;

function getContainer() {
  return _tabMode
    ? document.getElementById('freezeOpContent')
    : document.getElementById('mainContent');
}

function getCurrentProductionRole() {
  return appState.currentUserRole;
}

function canManageFreezeOp() {
  const role = getCurrentProductionRole();
  return role === 'admin' || role === 'office';
}

// ─── Entry points ─────────────────────────────────────────────────

export async function renderFreezeOp() {
  _tabMode = false;
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>동결가동 로딩 중...</p></div>`;
  const [orders, lots] = await Promise.all([loadFreezeOrders(), loadFrozenPanLots()]);
  if (document.getElementById('mainContent') !== content) return;
  renderPage(orders, lots, { container: content, tabMode: false });
}

export async function renderFreezeOpInTab() {
  _tabMode = true;
  const container = document.getElementById('freezeOpContent');
  if (!container) return;
  container.innerHTML = '<p style="color:#888;font-size:13px;padding:8px 0;">로딩 중...</p>';
  const [orders, lots] = await Promise.all([loadFreezeOrders(), loadFrozenPanLots()]);
  if (document.getElementById('freezeOpContent') !== container) return;
  renderPage(orders, lots, { container, tabMode: true });
}

// ─── Data loaders ─────────────────────────────────────────────────

async function loadFreezeOrders() {
  const snap = await getDocs(query(collection(db, 'freezeOrders'), orderBy('date', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadFrozenPanLots() {
  const snap = await getDocs(collection(db, 'frozenPanLots'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => !l.closed && Number(l.remaining || 0) > 0);
}

function buildStockMap(lots) {
  const map = {};
  lots.forEach(l => {
    map[l.productName] = (map[l.productName] || 0) + Number(l.remaining || 0);
  });
  return map;
}

async function reload() {
  const [orders, lots] = await Promise.all([loadFreezeOrders(), loadFrozenPanLots()]);
  renderPage(orders, lots, { container: getContainer(), tabMode: _tabMode });
}

// ─── Page render ──────────────────────────────────────────────────

function renderPage(orders, lots, options = {}) {
  const container = options.container || getContainer();
  if (!container) return;
  const tabMode = options.tabMode ?? _tabMode;
  const isAdmin = canManageFreezeOp();
  const stock = buildStockMap(lots);

  const createBtn = isAdmin
    ? '<button class="btn-primary" id="btnCreateOrder">+ 발주서 제작</button>'
    : '';

  const stockSection = `
    <div class="form-section" style="background:white;border-radius:8px;padding:14px 18px;margin-bottom:14px;border:1px solid #e8e8e8;">
      <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:8px;">현재 동결판 재고</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${Object.keys(stock).length === 0
          ? '<span style="color:#aaa;font-size:13px;">재고 없음</span>'
          : Object.entries(stock).map(([n, q]) =>
              `<span style="background:#f0f4ff;border:1px solid #c3d0f5;border-radius:6px;padding:4px 10px;font-size:12px;">${esc(n)} <strong>${q}판</strong></span>`
            ).join('')}
      </div>
    </div>
  `;

  const orderListHeader = tabMode
    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:14px;font-weight:600;">발주서 목록</div>
        ${createBtn}
       </div>`
    : `<div style="font-size:14px;font-weight:600;margin-bottom:14px;">발주서 목록</div>`;

  const orderSection = `
    <div class="form-section" style="background:white;border-radius:8px;padding:20px;border:1px solid #e8e8e8;">
      ${orderListHeader}
      ${orders.length === 0
        ? '<p style="color:#aaa;font-size:13px;text-align:center;padding:20px 0;">등록된 발주서 없음</p>'
        : `<div style="display:flex;flex-direction:column;gap:8px;">${orders.map(o => orderCardHtml(o, isAdmin)).join('')}</div>`}
    </div>
  `;

  container.innerHTML = tabMode
    ? stockSection + orderSection
    : `<div class="page-wrap">
        <div class="page-header">
          <h2 class="page-title">동결가동</h2>
          ${createBtn}
        </div>
        ${stockSection}
        ${orderSection}
       </div>`;

  if (isAdmin) {
    container.querySelector('#btnCreateOrder')?.addEventListener('click', () => showCreateModal(stock, lots));
    container.querySelectorAll('.btn-build-layout').forEach(btn => {
      btn.addEventListener('click', () => {
        const o = orders.find(x => x.id === btn.dataset.id);
        if (o) showBuilderModal(o);
      });
    });
    container.querySelectorAll('.btn-cancel-order').forEach(btn => {
      btn.addEventListener('click', async () => {
        const o = orders.find(x => x.id === btn.dataset.id);
        if (!o) return;
        const ok = await showConfirmModal({
          title: '발주서 취소',
          message: `${o.date} 발주서를 취소하시겠습니까?\n차감된 동결판 재고가 복구됩니다.`,
          confirmText: '취소 확정',
        });
        if (!ok) return;
        try {
          await cancelOrder(o);
          await reload();
          alert('발주서가 취소되었습니다.');
        } catch (err) {
          alert('취소 실패: ' + err.message);
        }
      });
    });
  }

  container.querySelectorAll('.btn-view-order').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = orders.find(x => x.id === btn.dataset.id);
      if (o) showDetailModal(o, isAdmin);
    });
  });
}

function orderCardHtml(order, isAdmin) {
  const isCancelled = order.status === 'cancelled';
  const hasLayout = !!order.layout;
  const total = (order.items || []).reduce((s, i) => s + Number(i.panCount || 0), 0);
  const summary = (order.items || [])
    .map(i => `${esc(i.productName)} ${i.panCount}판${i.isVirtual ? ' <span style="color:#e67e22;font-size:10px;">[가상]</span>' : ''}`)
    .join(' · ');

  const statusBadge = isCancelled
    ? '<span style="color:#e53e3e;font-weight:600;font-size:12px;">취소됨</span>'
    : hasLayout
      ? '<span style="color:#2d7a3a;font-weight:600;">✅ 배치완료</span>'
      : '<span style="color:#e67e22;font-weight:600;">⏳ 배치대기</span>';

  return `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px;background:#fafafa;opacity:${isCancelled ? '0.55' : '1'};">
      <div style="min-width:100px;font-size:13px;font-weight:600;">${esc(order.date)}</div>
      <div style="flex:1;font-size:12px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${summary}</div>
      <div style="min-width:55px;text-align:right;font-size:12px;color:#888;">총 ${total}판</div>
      <div style="min-width:75px;text-align:right;font-size:12px;">${statusBadge}</div>
      <div style="display:flex;gap:6px;white-space:nowrap;">
        <button class="btn-secondary btn-view-order" data-id="${order.id}" style="font-size:11px;padding:3px 10px;">발주서</button>
        ${!isCancelled && isAdmin ? `<button class="btn-primary btn-build-layout" data-id="${order.id}" style="font-size:11px;padding:3px 10px;">${hasLayout ? '배치판' : '배치판 생성'}</button>` : ''}
        ${!isCancelled && isAdmin ? `<button class="btn-secondary btn-cancel-order" data-id="${order.id}" style="font-size:11px;padding:3px 10px;color:#e53e3e;">취소</button>` : ''}
      </div>
    </div>
  `;
}

// ─── Create Order Modal ───────────────────────────────────────────

function showCreateModal(stock, lots) {
  const productOptionHtml = Object.entries(stock)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([n, q]) => `<option value="${esc(n)}">${esc(n)} (${q}판)</option>`)
    .join('');

  showModal(`
    <h3 class="modal-title">발주서 제작</h3>
    <div class="form-group">
      <label>동결건조 날짜 *</label>
      <input type="date" id="fo_date" value="${getToday()}" />
    </div>
    <div style="font-size:13px;font-weight:600;margin:12px 0 8px;">발주 항목</div>
    <div id="fo_items" style="margin-bottom:8px;"></div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button class="btn-secondary" id="fo_addStock" style="font-size:12px;">+ 재고 항목 추가</button>
      <button class="btn-secondary" id="fo_addVirtual" style="font-size:12px;color:#e67e22;">+ 가상 재고 추가</button>
    </div>
    <div style="font-size:13px;font-weight:600;margin-bottom:16px;">
      총합: <span id="fo_total" style="color:#e67e22;">0</span>판
      <span style="font-size:11px;color:#aaa;margin-left:6px;">(기준 45판)</span>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="fo_save">저장</button>
    </div>
  `);

  function recalcTotal() {
    let t = 0;
    document.querySelectorAll('#fo_items .fo-qty').forEach(el => { t += parseInt(el.value) || 0; });
    const el = document.getElementById('fo_total');
    if (el) { el.textContent = t; el.style.color = t > 45 ? '#e53e3e' : '#e67e22'; }
  }

  function addStockRow() {
    const row = document.createElement('div');
    row.className = 'fo-row';
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center;';
    row.innerHTML = `
      <select class="fo-name cell-input" style="flex:1;">
        <option value="">제품 선택</option>
        ${productOptionHtml}
      </select>
      <input type="number" class="fo-qty cell-input" placeholder="판수" style="width:80px;" min="1" />
      <span class="fo-hint" style="font-size:11px;color:#888;min-width:55px;"></span>
      <button class="fo-del btn-secondary" style="font-size:11px;padding:2px 8px;">✕</button>
    `;
    document.getElementById('fo_items').appendChild(row);
    row.querySelector('.fo-name').addEventListener('change', e => {
      row.querySelector('.fo-hint').textContent = e.target.value ? `재고 ${stock[e.target.value] || 0}판` : '';
    });
    row.querySelector('.fo-qty').addEventListener('input', recalcTotal);
    row.querySelector('.fo-del').addEventListener('click', () => { row.remove(); recalcTotal(); });
  }

  function addVirtualRow() {
    const row = document.createElement('div');
    row.className = 'fo-row fo-virtual';
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center;';
    row.innerHTML = `
      <input type="text" class="fo-name cell-input" placeholder="품목명 (가상 재고)" style="flex:1;" />
      <input type="number" class="fo-qty cell-input" placeholder="판수" style="width:80px;" min="1" />
      <span style="font-size:11px;color:#e67e22;min-width:55px;">가상 재고</span>
      <button class="fo-del btn-secondary" style="font-size:11px;padding:2px 8px;">✕</button>
    `;
    document.getElementById('fo_items').appendChild(row);
    row.querySelector('.fo-qty').addEventListener('input', recalcTotal);
    row.querySelector('.fo-del').addEventListener('click', () => { row.remove(); recalcTotal(); });
  }

  document.getElementById('fo_addStock').addEventListener('click', addStockRow);
  document.getElementById('fo_addVirtual').addEventListener('click', addVirtualRow);
  addStockRow();

  document.getElementById('fo_save').addEventListener('click', async () => {
    const date = document.getElementById('fo_date').value;
    if (!date) { alert('날짜를 입력해주세요.'); return; }

    const items = [];
    let hasErr = false;
    document.querySelectorAll('#fo_items .fo-row').forEach(row => {
      const isVirtual = row.classList.contains('fo-virtual');
      const name = (row.querySelector('.fo-name').value || '').trim();
      const qty = parseInt(row.querySelector('.fo-qty').value) || 0;
      if (!name || qty <= 0) return;
      if (!isVirtual) {
        const avail = stock[name] || 0;
        if (qty > avail) { alert(`${name}: 재고 ${avail}판 / 발주 ${qty}판 — 재고 부족`); hasErr = true; }
      }
      items.push({ productName: name, panCount: qty, isVirtual });
    });
    if (hasErr) return;
    if (items.length === 0) { alert('발주 항목을 추가해주세요.'); return; }

    const totalPans = items.reduce((s, i) => s + i.panCount, 0);
    if (totalPans > 45) {
      const ok = await showConfirmModal({
        title: '판수 초과',
        message: `총 ${totalPans}판은 45판 기준을 초과합니다. 그래도 저장하시겠습니까?`,
        confirmText: '저장',
      });
      if (!ok) return;
    }

    // FIFO 차감 계산
    let deductions;
    try {
      deductions = calcDeductions(items, lots);
    } catch (err) {
      alert(err.message); return;
    }

    const batch = writeBatch(db);
    // 차감 적용 (잔량 0이 되는 lot은 closed 처리)
    deductions.forEach(d => {
      const lot = lots.find(l => l.id === d.lotId);
      const fullyUsed = lot && Number(lot.remaining || 0) - d.amount <= 0;
      batch.update(doc(db, 'frozenPanLots', d.lotId), {
        remaining: increment(-d.amount),
        ...(fullyUsed ? { closed: true } : {}),
        updatedAt: new Date(),
      });
    });
    // 발주서 저장
    const orderRef = doc(collection(db, 'freezeOrders'));
    batch.set(orderRef, {
      date, items, totalPans, deductions,
      status: 'active',
      layout: null, layoutConfirmedAt: null, layoutConfirmedBy: null,
      createdAt: new Date(), createdBy: getCurrentProductionRole() || '',
    });
    await batch.commit();

    closeModal();
    await reload();
    alert('발주서 저장 완료! 동결판 재고가 차감되었습니다.');
  });
}

// ─── Order Detail Modal (read-only for QC, also admin) ──────────

function showDetailModal(order, isAdmin) {
  const total = (order.items || []).reduce((s, i) => s + Number(i.panCount || 0), 0);
  const rowsHtml = (order.items || []).map(i => `
    <tr>
      <td>${esc(i.productName)}</td>
      <td>${i.isVirtual ? '<span style="color:#e67e22;font-size:11px;">가상 재고</span>' : '실 재고'}</td>
      <td style="text-align:right;font-weight:600;">${i.panCount}판</td>
    </tr>
  `).join('');

  const layoutSection = order.layout
    ? `<div style="font-size:13px;font-weight:600;margin:16px 0 10px;">동결건조기 자리 배치</div>${buildLayoutGridHtml(order.layout, order.items)}`
    : `<p style="color:#aaa;font-size:13px;margin-top:12px;">배치판 미생성</p>`;

  showModal(`
    <h3 class="modal-title">발주서 — ${esc(order.date)}</h3>
    <table class="data-table" style="margin-bottom:8px;">
      <thead><tr><th>제품</th><th>구분</th><th>판수</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="border-top:2px solid #e0e0e0;font-weight:700;">
          <td colspan="2">합계</td>
          <td style="text-align:right;">${total}판</td>
        </tr>
      </tbody>
    </table>
    ${layoutSection}
    <div class="modal-actions">
      ${isAdmin && !order.layout ? `<button class="btn-primary" id="dv_toBuilder">배치판 생성 →</button>` : ''}
      ${order.layout ? `<button class="btn-secondary" id="dv_print">🖨 인쇄</button>` : ''}
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `, true);

  if (isAdmin && !order.layout) {
    document.getElementById('dv_toBuilder')?.addEventListener('click', () => {
      closeModal();
      showBuilderModal(order);
    });
  }
  if (order.layout) {
    document.getElementById('dv_print')?.addEventListener('click', () => {
      const colorMap = buildColorMapFromItems(order.items);
      printLayout(order, order.layout, colorMap);
    });
  }
}

// ─── Layout Grid HTML (read-only) ────────────────────────────────

function buildColorMapFromItems(items) {
  const map = {};
  (items || []).forEach((item, idx) => {
    map[item.productName] = SLOT_COLORS[idx % SLOT_COLORS.length];
  });
  return map;
}

function buildLayoutGridHtml(slots, items) {
  const colorMap = buildColorMapFromItems(items);

  const legendHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      ${(items || []).map((item, idx) => {
        const color = SLOT_COLORS[idx % SLOT_COLORS.length];
        const assigned = (slots || []).filter(s => s === item.productName).length;
        return `<div style="display:flex;align-items:center;gap:4px;font-size:12px;">
          <div style="width:12px;height:12px;border-radius:3px;background:${color};flex-shrink:0;"></div>
          <span>${esc(item.productName)}</span>
          <span style="color:#888;">${assigned}/${item.panCount}판</span>
        </div>`;
      }).join('')}
    </div>
  `;

  let gridHtml = `<div style="display:grid;grid-template-columns:repeat(3,60px);gap:3px;margin-bottom:12px;">`;
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const productName = slots ? slots[i] : null;
    const color = productName ? colorMap[productName] : null;
    const row = Math.floor(i / COLS) + 1;
    const col = (i % COLS) + 1;
    gridHtml += `
      <div style="
        width:60px;height:40px;border-radius:4px;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
        border:1px solid ${color ? 'transparent' : '#e0e0e0'};
        background:${color || '#f5f5f5'};
      ">
        <span style="font-size:8px;color:${color ? 'rgba(255,255,255,0.6)' : '#ccc'};">${String(row).padStart(2,'0')}-${col}</span>
        ${productName ? `<span style="font-size:7px;color:white;font-weight:700;text-align:center;line-height:1.1;max-width:56px;overflow:hidden;white-space:nowrap;">${esc(productName.slice(0, 9))}</span>` : ''}
      </div>
    `;
  }
  gridHtml += `</div>`;

  return legendHtml + gridHtml;
}

// ─── Layout Builder Modal (admin only) ───────────────────────────

function showBuilderModal(order) {
  _slots = order.layout ? [...order.layout] : new Array(TOTAL_SLOTS).fill(null);
  _activeProduct = null;
  _builderOrder = order;
  _colorMap = buildColorMapFromItems(order.items);

  showModal(`
    <h3 class="modal-title">배치판 생성 — ${esc(order.date)}</h3>
    <p style="font-size:12px;color:#888;margin-bottom:12px;">품목을 클릭해 선택 후, 오른쪽 칸을 눌러 배치합니다. 배치된 칸을 다시 클릭하면 해제됩니다.</p>
    <div style="display:flex;gap:24px;align-items:flex-start;">
      <div style="min-width:170px;">
        <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:8px;">품목</div>
        <div id="bp_products"></div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:#555;margin-bottom:6px;">배치판 (15줄 × 3칸)</div>
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:600;color:#555;margin-bottom:4px;padding:0 2px;">
          <span>← 도어쪽</span>
          <span>기계 내부쪽 →</span>
        </div>
        <div id="bp_grid"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-secondary" id="bp_reset">초기화</button>
      <button class="btn-secondary" id="bp_print">🖨 인쇄</button>
      <button class="btn-primary" id="bp_confirm">배치 확정</button>
    </div>
  `, true, '1060px');

  renderBuilderProducts();
  renderBuilderGrid();

  document.getElementById('bp_print').addEventListener('click', () => printLayout(order, _slots, _colorMap));

  document.getElementById('bp_reset').addEventListener('click', async () => {
    const ok = await showConfirmModal({ title: '초기화', message: '배치를 모두 초기화할까요?', confirmText: '초기화' });
    if (!ok) return;
    _slots = new Array(TOTAL_SLOTS).fill(null);
    _activeProduct = null;
    renderBuilderProducts();
    renderBuilderGrid();
  });

  document.getElementById('bp_confirm').addEventListener('click', async () => {
    const assigned = _slots.filter(Boolean).length;
    if (assigned === 0) { alert('배치된 항목이 없습니다.'); return; }
    const ok = await showConfirmModal({
      title: '배치 확정',
      message: `${assigned}/45칸 배치 상태로 확정하시겠습니까?`,
      confirmText: '확정',
    });
    if (!ok) return;

    await updateDoc(doc(db, 'freezeOrders', order.id), {
      layout: _slots,
      layoutConfirmedAt: new Date(),
      layoutConfirmedBy: getCurrentProductionRole() || '',
      updatedAt: new Date(),
    });

    closeModal();
    await reload();
    alert('배치 확정 완료!');
  });
}

function renderBuilderProducts() {
  const el = document.getElementById('bp_products');
  if (!el) return;
  const items = _builderOrder.items || [];

  el.innerHTML = items.map(item => {
    const color = _colorMap[item.productName] || '#ccc';
    const assigned = _slots.filter(s => s === item.productName).length;
    const remaining = item.panCount - assigned;
    const isActive = _activeProduct === item.productName;

    return `
      <div class="bp-product" data-name="${esc(item.productName)}" style="
        border:2px solid ${isActive ? color : '#e0e0e0'};
        border-radius:8px;padding:8px 10px;margin-bottom:8px;cursor:pointer;
        background:${isActive ? color + '18' : 'white'};
      ">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
          <div style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;">${esc(item.productName)}</span>
        </div>
        <div style="font-size:11px;color:#888;">${assigned}/${item.panCount}판</div>
        ${remaining > 0
          ? `<div style="font-size:10px;color:${color};font-weight:600;">${remaining}판 남음</div>`
          : `<div style="font-size:10px;color:#2d7a3a;font-weight:600;">✓ 완료</div>`}
      </div>
    `;
  }).join('');

  el.querySelectorAll('.bp-product').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      _activeProduct = _activeProduct === name ? null : name;
      renderBuilderProducts();
      renderBuilderGrid();
    });
  });
}

function renderBuilderGrid() {
  const el = document.getElementById('bp_grid');
  if (!el) return;

  const activeItem = _builderOrder.items?.find(i => i.productName === _activeProduct);
  const assignedActive = _activeProduct ? _slots.filter(s => s === _activeProduct).length : 0;
  const canPlace = activeItem ? assignedActive < activeItem.panCount : false;
  const activeColor = _activeProduct ? _colorMap[_activeProduct] : null;

  let html = `<div style="display:grid;grid-template-columns:repeat(3,66px);gap:3px;">`;
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const row = Math.floor(i / COLS) + 1;
    const col = (i % COLS) + 1;
    const slotProduct = _slots[i];
    const slotColor = slotProduct ? _colorMap[slotProduct] : null;
    const isActiveSlot = slotProduct === _activeProduct && _activeProduct !== null;

    let bg = slotColor || '#f0f0f0';
    let border = slotColor ? '1px solid transparent' : '1px solid #ddd';
    let cursor = 'default';
    let opacity = '1';

    if (_activeProduct) {
      if (isActiveSlot) {
        border = `2px solid ${activeColor}`;
        cursor = 'pointer';
      } else if (!slotProduct && canPlace) {
        bg = activeColor + '18';
        border = `1px dashed ${activeColor}`;
        cursor = 'pointer';
      } else if (slotProduct && !isActiveSlot) {
        opacity = '0.4';
      }
    }

    html += `
      <div class="bp-slot" data-idx="${i}" style="
        width:66px;height:44px;border-radius:4px;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
        border:${border};background:${bg};opacity:${opacity};
        cursor:${cursor};user-select:none;
      ">
        <span style="font-size:8px;color:${slotColor ? 'rgba(255,255,255,0.6)' : '#bbb'};">${String(row).padStart(2,'0')}-${col}</span>
        ${slotProduct ? `<span style="font-size:7px;color:white;font-weight:700;text-align:center;line-height:1.1;max-width:62px;overflow:hidden;white-space:nowrap;">${esc(slotProduct.slice(0, 9))}</span>` : ''}
      </div>
    `;
  }
  html += `</div>`;
  el.innerHTML = html;

  el.querySelectorAll('.bp-slot').forEach(slot => {
    slot.addEventListener('click', () => {
      if (!_activeProduct) return;
      const idx = parseInt(slot.dataset.idx);
      if (_slots[idx] === _activeProduct) {
        _slots[idx] = null;
      } else if (!_slots[idx] && canPlace) {
        _slots[idx] = _activeProduct;
      } else {
        return;
      }
      renderBuilderProducts();
      renderBuilderGrid();
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function showModal(html, wide = false, maxWidth = null) {
  const existing = document.getElementById('modalOverlay');
  if (existing) existing.remove();
  const mw = maxWidth ? maxWidth : wide ? '780px' : '';
  const overlay = document.createElement('div');
  overlay.id = 'modalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="${mw ? `max-width:${mw};` : ''}max-height:92vh;overflow-y:auto;">${html}</div>`;
  document.body.appendChild(overlay);
}

window.closeModal = function () {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.remove();
};

// ─── Order cancel & deduction helpers ────────────────────────────

function calcDeductions(items, lots) {
  // lots: current frozenPanLots (remaining > 0), sorted FIFO per product
  const deductions = [];
  const lotPool = {}; // productName -> sorted lot list with working remaining

  lots.forEach(l => {
    if (!lotPool[l.productName]) lotPool[l.productName] = [];
    lotPool[l.productName].push({ lotId: l.id, remaining: l.remaining });
  });
  // sort FIFO (earliest date first) — lots already carry 'date' field
  lots.forEach(l => {
    if (lotPool[l.productName]) {
      lotPool[l.productName].sort((a, b) => {
        const la = lots.find(x => x.id === a.lotId);
        const lb = lots.find(x => x.id === b.lotId);
        return (la?.date || '').localeCompare(lb?.date || '');
      });
    }
  });

  for (const item of items) {
    if (item.isVirtual) continue;
    let need = item.panCount;
    const pool = lotPool[item.productName] || [];
    for (const entry of pool) {
      if (need <= 0) break;
      const take = Math.min(need, entry.remaining);
      if (take <= 0) continue;
      deductions.push({ lotId: entry.lotId, productName: item.productName, amount: take });
      entry.remaining -= take;
      need -= take;
    }
    if (need > 0) throw new Error(`${item.productName}: 재고 부족 (${need}판 모자람)`);
  }
  return deductions;
}

async function cancelOrder(order) {
  const batch = writeBatch(db);
  (order.deductions || []).forEach(d => {
    batch.update(doc(db, 'frozenPanLots', d.lotId), {
      remaining: increment(d.amount),
      closed: false,
      updatedAt: new Date(),
    });
  });
  batch.update(doc(db, 'freezeOrders', order.id), {
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelledBy: getCurrentProductionRole() || '',
  });
  await batch.commit();
}

// ─── A4 Print ────────────────────────────────────────────────────

function printLayout(order, slots, colorMap) {
  const items = order.items || [];
  const assigned = (slots || []).filter(Boolean).length;

  const cells = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
    const row = Math.floor(i / COLS) + 1;
    const col = (i % COLS) + 1;
    const product = slots ? slots[i] : null;
    const color = product ? (colorMap[product] || '#ccc') : null;
    return `<div class="cell" style="border-color:${color || '#ccc'};background:${color || '#f9f9f9'};">
      <span class="cell-num" style="color:${color ? 'rgba(255,255,255,0.6)' : '#bbb'};">${String(row).padStart(2,'0')}-${col}</span>
      ${product ? `<span class="cell-name">${esc(product)}</span>` : ''}
    </div>`;
  }).join('');

  const legendItems = items.map((item, idx) => {
    const color = colorMap[item.productName] || SLOT_COLORS[idx % SLOT_COLORS.length];
    const cnt = (slots || []).filter(s => s === item.productName).length;
    return `<div class="legend-item">
      <div class="legend-dot" style="background:${color};"></div>
      <span>${esc(item.productName)}</span>
      <span class="legend-count">${cnt}/${item.panCount}판${item.isVirtual ? ' [가상]' : ''}</span>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>배치판 ${esc(order.date)}</title>
<style>
  @page { size: A4 portrait; margin: 9mm 10mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 190mm; height: 277mm; overflow: hidden; }
  body { font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', Arial, sans-serif; }
  .header { margin-bottom: 3mm; }
  .header h2 { font-size: 11.5pt; font-weight: 700; }
  .header p  { font-size: 7.5pt; color: #555; margin-top: 0.8mm; }
  .direction { display:flex; justify-content:space-between; font-size:8pt; font-weight:700; color:#333; margin-bottom:1.5mm; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1mm; width:100%; }
  .cell {
    height: 13.5mm;
    border-radius: 1.5mm;
    border: 0.3mm solid;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5mm;
  }
  .cell-num  { font-size: 6.5pt; }
  .cell-name { font-size: 6pt; color: white; font-weight: 700; text-align: center; line-height: 1.2; padding: 0 1mm; word-break: keep-all; max-width: 100%; overflow: hidden; }
  .legend { margin-top: 3.5mm; display:flex; flex-wrap:wrap; gap:2mm 5mm; }
  .legend-item { display:flex; align-items:center; gap:1.5mm; font-size:7.5pt; }
  .legend-dot { width:5.5mm; height:3.5mm; border-radius:0.8mm; flex-shrink:0; }
  .legend-count { color:#666; }
</style>
</head><body>
<div class="header">
  <h2>동결건조기 배치판 — ${esc(order.date)}</h2>
  <p>총 ${assigned}/45칸 배치</p>
</div>
<div class="direction"><span>← 도어쪽</span><span>기계 내부쪽 →</span></div>
<div class="grid">${cells}</div>
<div class="legend">${legendItems}</div>
</body></html>`;

  const win = window.open('', '_blank', 'width=820,height=1000');
  if (!win) { alert('팝업이 차단되었습니다. 팝업을 허용해주세요.'); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}
