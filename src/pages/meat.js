import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, query, orderBy, getDoc, where, writeBatch, setDoc
} from 'firebase/firestore';
import { blockIfClosed } from '../utils/closingGuard.js';
import { currentUserRole } from '../app.js';
import { recordActivity } from '../services/activityLogs.js';
import { recordMeatLog } from '../services/meatLogs.js';
import { getTodayKST as getToday } from '../utils/date.js';
import Sortable from 'sortablejs';

let meatTypes = [];
let meatStockCategories = [];
let currentTab = 'frozen';
let meatTypesSortable = null;
let stockSummarySortables = [];
let stockSummaryCategorySortable = null;
let collapsedStockSummaryIds = new Set();
let expandedMeatLogTypeIds = new Set();

export async function renderMeat() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>원료 재고 로딩 중...</p></div>`;
  await loadStaffCache();
  [meatTypes, meatStockCategories] = await Promise.all([
    loadMeatTypes(),
    loadMeatStockCategories(),
  ]);
  renderMeatLayout();
}

async function loadMeatTypes() {
  const q = query(collection(db, 'meatTypes'), orderBy('sortOrder'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function normalizeMeatStockCategories(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((g, idx) => ({
      id: String(g?.id || '').trim(),
      name: String(g?.name || '').trim(),
      sortOrder: Number.isFinite(Number(g?.sortOrder)) ? Number(g.sortOrder) : idx,
      scope: g?.scope === 'produce' ? 'produce' : 'meat',
    }))
    .filter(g => g.id && g.name)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ko'));
}

async function loadMeatStockCategories() {
  const snap = await getDoc(doc(db, 'settings', 'meatStockCategories'));
  if (!snap.exists()) return [];
  return normalizeMeatStockCategories(snap.data().groups);
}

async function saveMeatStockCategories(groups) {
  const normalized = normalizeMeatStockCategories(groups)
    .map((g, idx) => ({ ...g, sortOrder: idx }));
  await setDoc(doc(db, 'settings', 'meatStockCategories'), {
    groups: normalized,
    updatedAt: new Date(),
  }, { merge: true });
  meatStockCategories = normalized;
}

function getCurrentStockCategoryScope() {
  return currentTab === 'produce' ? 'produce' : 'meat';
}

function getScopedMeatStockCategories(scope = getCurrentStockCategoryScope()) {
  return meatStockCategories.filter(g => (g.scope || 'meat') === scope);
}

function getActiveMeatTypes() {
  return meatTypes.filter(m => m.active !== false);
}

function getMeatTypeCategory(meatTypeId) {
  return meatTypes.find(m => m.id === meatTypeId)?.category || 'meat';
}

function isProduceMeatType(meatTypeId) {
  return getMeatTypeCategory(meatTypeId) === 'produce';
}

function isMeatCategoryStock(stock) {
  return !isProduceMeatType(stock.meatTypeId);
}

function isProduceCategoryStock(stock) {
  return isProduceMeatType(stock.meatTypeId);
}

function isMeatCategoryLog(log) {
  return !isProduceMeatType(log.meatTypeId);
}

function isProduceCategoryLog(log) {
  return isProduceMeatType(log.meatTypeId);
}

async function loadMeatLogs(stage) {
  const q = query(
    collection(db, 'meatLogs'),
    where('stage', '==', stage),
    orderBy('timestamp', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function getMeatLogTypeLabel(type) {
  const map = {
    frozenIncoming: '입고',
    frozenOut: '전처리로 출고',
    processedIn: '전처리',
    processedOut: '재포장으로 출고',
    repackedIn: '재포장',
    repackedOut: '출고',
    productionDeduct: '생산차감',
    productionRollback: '생산복원',
    adjust: '수동조정',
  };
  return map[type] || type;
}

function formatMeatLogTimestamp(ts) {
  if (!ts) return '-';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatMeatLogQty(grams) {
  if (typeof grams !== 'number') return '-';
  const sign = grams > 0 ? '+' : '';
  const kg = grams / 1000;
  return `${sign}${kg.toFixed(2)}kg`;
}

async function loadMeatStocks(stage) {
  const q = query(collection(db, 'meatStocks'), orderBy('incomingDate'));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.stage === stage && !s.closed);
}

function getStockColor(totalG, meatTypeId) {
  const mt = meatTypes.find(m => m.id === meatTypeId);
  const minG = mt?.minimumQtyG || 0;
  if (minG <= 0) return '#1a1a1a';
  if (totalG < minG) return '#e53e3e';
  if (totalG < minG * 1.5) return '#dd6b20';
  return '#1a1a1a';
}

function buildTotalByType(stocks) {
  const map = new Map();
  (stocks || []).forEach(s => {
    const key = s.meatTypeId || s.meatNameSnapshot || s.id;
    const cur = map.get(key);
    if (cur) {
      cur.totalG += Number(s.remaining || 0);
      cur.lots.push(s);
    } else {
      map.set(key, {
        name: s.meatNameSnapshot || '원료',
        totalG: Number(s.remaining || 0),
        meatTypeId: s.meatTypeId,
        lots: [s],
      });
    }
  });
  return map;
}

function getStockSummaryOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STOCK_SUMMARY_ORDER_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getStockSummaryRowBreaks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STOCK_SUMMARY_ROW_BREAKS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function legacyRenderStockSummary(stocks) {
  const byType = buildTotalByType(stocks);
  if (byType.size === 0) return '';

  const savedOrder = getStockSummaryOrder();
  const orderIndex = new Map(savedOrder.map((id, idx) => [id, idx]));
  const rowBreakSet = new Set(getStockSummaryRowBreaks());
  const cells = [...byType.values()]
    .sort((a, b) => {
      const aRank = orderIndex.has(a.meatTypeId) ? orderIndex.get(a.meatTypeId) : Number.MAX_SAFE_INTEGER;
      const bRank = orderIndex.has(b.meatTypeId) ? orderIndex.get(b.meatTypeId) : Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) return aRank - bRank;
      return b.totalG - a.totalG;
    })
    .map(g => {
      const color = getStockColor(g.totalG, g.meatTypeId);
      const hasRowBreak = rowBreakSet.has(g.meatTypeId);
      const rowBreakStyle = hasRowBreak
        ? 'grid-column:1;border-left:4px solid #4a7c59;padding-left:4px;'
        : '';
      return `
        <div class="stock-summary-cell" data-meat-type-id="${g.meatTypeId || ''}" data-row-break="${hasRowBreak ? 'true' : 'false'}" style="display:flex;align-items:center;gap:4px;min-width:0;border:1px solid #e8e8e8;border-radius:5px;padding:3px 5px;background:#fff;${rowBreakStyle}">
          <span class="stock-summary-drag-handle" style="cursor:grab;color:#bbb;font-size:11px;flex-shrink:0;">⠿</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;font-size:12px;flex:1;">${g.name}</span>
          <b style="color:${color};font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">${(g.totalG / 1000).toFixed(2)}kg</b>
          <button class="stock-summary-rowbreak-btn" data-meat-type-id="${g.meatTypeId || ''}" title="줄 바꿈 토글" style="border:none;background:none;cursor:pointer;font-size:11px;padding:0 2px;color:${hasRowBreak ? '#4a7c59' : '#ccc'};flex-shrink:0;">↵</button>
        </div>
      `;
    })
    .join('');

  return `
    <div style="background:#f8f9fa;border:1px solid #e8e8e8;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:13px;">
      <div style="color:#666;font-weight:600;margin-bottom:6px;">원료별 합계</div>
      <div class="stock-summary-grid" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;">
        ${cells}
      </div>
    </div>
  `;
}

function saveStockSummaryOrderFromGrid(gridEl) {
  const visibleIds = Array.from(gridEl.querySelectorAll('.stock-summary-cell'))
    .map(cell => cell.dataset.meatTypeId)
    .filter(Boolean);
  const visibleSet = new Set(visibleIds);
  const preservedIds = getStockSummaryOrder().filter(id => !visibleSet.has(id));
  try {
    localStorage.setItem(STOCK_SUMMARY_ORDER_KEY, JSON.stringify([...visibleIds, ...preservedIds]));
  } catch (err) {
    console.warn('[meat] stock summary order save skipped:', err);
  }
}

function saveStockSummaryRowBreaksFromGrid(gridEl) {
  const rowBreakIds = Array.from(gridEl.querySelectorAll('.stock-summary-cell[data-row-break="true"]'))
    .map(cell => cell.dataset.meatTypeId)
    .filter(Boolean);
  try {
    localStorage.setItem(STOCK_SUMMARY_ROW_BREAKS_KEY, JSON.stringify(rowBreakIds));
  } catch (err) {
    console.warn('[meat] stock summary row breaks save skipped:', err);
  }
}

function toggleStockSummaryRowBreak(cellEl, gridEl) {
  const enabled = cellEl.dataset.rowBreak !== 'true';
  cellEl.dataset.rowBreak = enabled ? 'true' : 'false';
  cellEl.style.gridColumn = enabled ? '1' : '';
  cellEl.style.borderLeft = enabled ? '4px solid #4a7c59' : '';
  cellEl.style.paddingLeft = enabled ? '4px' : '';
  const nameWrap = cellEl.querySelector('span');
  if (nameWrap) {
    const existingMarker = nameWrap.querySelector('.stock-summary-row-break-marker');
    if (enabled && !existingMarker) {
      nameWrap.insertAdjacentHTML('afterbegin', '<span class="stock-summary-row-break-marker" style="color:#4a7c59;font-weight:700;font-size:10px;margin-right:3px;">↵</span>');
    } else if (!enabled && existingMarker) {
      existingMarker.remove();
    }
  }
  saveStockSummaryRowBreaksFromGrid(gridEl);
}

function legacyInitStockSummarySortable() {
  if (stockSummarySortable) {
    try {
      stockSummarySortable.destroy();
    } catch (err) {
      console.warn('[meat] stock summary sortable destroy skipped:', err);
    }
    stockSummarySortable = null;
  }

  const gridEl = document.querySelector('.stock-summary-grid');
  if (!gridEl) return;

  stockSummarySortable = Sortable.create(gridEl, {
    animation: 150,
    handle: '.stock-summary-drag-handle',
    draggable: '.stock-summary-cell',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: () => saveStockSummaryOrderFromGrid(gridEl),
  });

  gridEl.querySelectorAll('.stock-summary-rowbreak-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cell = btn.closest('.stock-summary-cell');
      toggleStockSummaryRowBreak(cell, gridEl);
      btn.style.color = cell.dataset.rowBreak === 'true' ? '#4a7c59' : '#ccc';
    });
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createMeatStockCategoryId() {
  return `cat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getMeatTypeGroupId(meatTypeId) {
  return meatTypes.find(m => m.id === meatTypeId)?.groupId || null;
}

function getMeatTypeGroupSortOrder(meatTypeId) {
  const value = meatTypes.find(m => m.id === meatTypeId)?.groupSortOrder;
  return Number.isFinite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

function buildStockSummaryGroups(byType) {
  const groups = getScopedMeatStockCategories().map(g => ({ ...g, items: [], virtual: false }));
  const groupMap = new Map(groups.map(g => [g.id, g]));
  const otherGroup = { id: '__other__', name: '기타', sortOrder: Number.MAX_SAFE_INTEGER, items: [], virtual: true };

  [...byType.values()].forEach(item => {
    const groupId = item.meatTypeId ? getMeatTypeGroupId(item.meatTypeId) : null;
    const group = groupId && groupMap.has(groupId) ? groupMap.get(groupId) : otherGroup;
    group.items.push(item);
  });

  [...groups, otherGroup].forEach(group => {
    group.items.sort((a, b) => {
      const aOrder = getMeatTypeGroupSortOrder(a.meatTypeId);
      const bOrder = getMeatTypeGroupSortOrder(b.meatTypeId);
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (a.name || '').localeCompare(b.name || '', 'ko');
    });
  });

  return otherGroup.items.length > 0 ? [...groups, otherGroup] : groups;
}

function renderStockSummaryCell(g) {
  const color = getStockColor(g.totalG, g.meatTypeId);
  const canDrag = currentUserRole === 'admin' || currentUserRole === 'office';
  const summaryId = g.meatTypeId || g.name;
  const expanded = !collapsedStockSummaryIds.has(summaryId);
  const lots = [...(g.lots || [])].sort((a, b) => {
    const dateA = String(a.incomingDate || a.processedDate || a.repackedDate || '');
    const dateB = String(b.incomingDate || b.processedDate || b.repackedDate || '');
    return dateA.localeCompare(dateB);
  });
  return `
    <div class="stock-summary-cell" data-meat-type-id="${g.meatTypeId || ''}" data-summary-id="${escapeHtml(summaryId)}" style="min-width:0;border:1px solid #e8e8e8;border-radius:5px;padding:0;background:#fff;overflow:hidden;">
      <div class="stock-summary-main" style="display:flex;align-items:center;gap:4px;min-width:0;padding:3px 5px;cursor:pointer;">
        ${canDrag ? '<span class="stock-summary-drag-handle" style="cursor:grab;color:#bbb;font-size:11px;flex-shrink:0;">::</span>' : ''}
        <span style="color:#888;font-size:11px;flex-shrink:0;width:10px;text-align:center;">${expanded ? '-' : '+'}</span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;font-size:12px;flex:1;">${escapeHtml(g.name)}</span>
        <b style="color:${color};font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">${(g.totalG / 1000).toFixed(2)}kg</b>
      </div>
      ${expanded ? `
        <div class="stock-summary-lots" style="border-top:1px solid #eee;background:#fafafa;padding:4px 5px;display:flex;flex-direction:column;gap:3px;">
          ${lots.map(lot => {
            const date = lot.incomingDate || lot.processedDate || lot.repackedDate || '-';
            const lotColor = lot.remaining < 0 ? '#e53e3e' : '#333';
            return `
              <div style="border:1px solid #ececec;border-radius:4px;background:#fff;padding:4px;">
                <div style="display:flex;align-items:center;gap:5px;">
                  <span style="color:#777;font-size:11px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(date)}</span>
                  <b style="color:${lotColor};font-size:11px;white-space:nowrap;">${(Number(lot.remaining || 0) / 1000).toFixed(2)}kg</b>
                  <button class="btn-adjust" data-id="${lot.id}" data-name="${escapeHtml(lot.meatNameSnapshot || g.name || '')}" data-remaining="${lot.remaining}" style="padding:1px 6px;font-size:11px;">&#51312;&#51221;</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
function renderStockSummary(stocks) {
  const byType = buildTotalByType(stocks);
  const groups = buildStockSummaryGroups(byType);
  const canManage = currentUserRole === 'admin' || currentUserRole === 'office';

  return `
    <div class="stock-summary-wrap" style="background:#f8f9fa;border:1px solid #e8e8e8;border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:13px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <div style="color:#666;font-weight:600;">원료별 합계</div>
        ${canManage ? '<button type="button" class="btn-secondary" id="btnMeatStockCategories" style="padding:4px 8px;font-size:12px;">카테고리 관리</button>' : ''}
      </div>
      <div class="stock-summary-columns" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;">
        ${groups.map(group => `
          <div class="stock-summary-category-column" data-category-id="${group.id}" data-virtual="${group.virtual ? 'true' : 'false'}"
               style="flex:0 0 calc((100% - 50px) / 6);flex-grow:0;flex-shrink:0;min-width:0;max-width:calc((100% - 50px) / 6);background:#fff;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">
            <div class="stock-summary-category-header" style="display:flex;align-items:center;gap:6px;padding:5px 7px;background:#f1f3f5;border-bottom:1px solid #e8e8e8;font-weight:700;color:#444;font-size:12px;">
              ${canManage && !group.virtual ? '<span class="stock-summary-category-handle" style="cursor:grab;color:#aaa;">⠿</span>' : ''}
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(group.name)}</span>
              <span style="font-size:11px;color:#888;">${group.items.length}</span>
            </div>
            <div class="stock-summary-category-items" data-category-id="${group.id}" style="display:flex;flex-direction:column;gap:4px;min-height:28px;padding:5px;">
              ${group.items.length === 0
                ? '<div class="stock-summary-empty" style="font-size:11px;color:#bbb;padding:3px 2px;">비어 있음</div>'
                : group.items.map(renderStockSummaryCell).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function buildStockLotGroups(stocks) {
  const groups = getScopedMeatStockCategories().map(g => ({ ...g, items: [], virtual: false }));
  const groupMap = new Map(groups.map(g => [g.id, g]));
  const otherGroup = { id: '__other__', name: '기타', sortOrder: Number.MAX_SAFE_INTEGER, items: [], virtual: true };

  (stocks || []).forEach(stock => {
    const groupId = stock.meatTypeId ? getMeatTypeGroupId(stock.meatTypeId) : null;
    const group = groupId && groupMap.has(groupId) ? groupMap.get(groupId) : otherGroup;
    group.items.push(stock);
  });

  [...groups, otherGroup].forEach(group => {
    group.items.sort((a, b) => {
      const aOrder = getMeatTypeGroupSortOrder(a.meatTypeId);
      const bOrder = getMeatTypeGroupSortOrder(b.meatTypeId);
      if (aOrder !== bOrder) return aOrder - bOrder;
      const nameCompare = (a.meatNameSnapshot || '').localeCompare(b.meatNameSnapshot || '', 'ko');
      if (nameCompare !== 0) return nameCompare;
      return String(a.incomingDate || a.processedDate || a.repackedDate || '').localeCompare(String(b.incomingDate || b.processedDate || b.repackedDate || ''));
    });
  });

  return otherGroup.items.length > 0 ? [...groups, otherGroup] : groups;
}

function renderStockLotGroups(stocks, options = {}) {
  return '';
  const {
    emptyText = '등록된 재고 없음',
    dateField = 'incomingDate',
    dateLabel = '작업일',
    showInitial = false,
    showStaffNote = false,
    typeTotals = null,
    useTypeColor = false,
  } = options;

  if (!stocks || stocks.length === 0) {
    return `<div style="text-align:center;color:#aaa;padding:20px;border:1px solid #eee;border-radius:6px;background:#fff;">${escapeHtml(emptyText)}</div>`;
  }

  const groups = buildStockLotGroups(stocks);
  return `
    <div class="stock-lot-group-wrap" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;">
      ${groups.map(group => `
        <div class="stock-lot-group" style="flex:0 0 calc((100% - 50px) / 6);flex-grow:0;flex-shrink:0;min-width:0;max-width:calc((100% - 50px) / 6);background:#fff;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">
          <div style="display:flex;align-items:center;gap:6px;padding:5px 7px;background:#f1f3f5;border-bottom:1px solid #e8e8e8;font-weight:700;color:#444;font-size:12px;">
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${escapeHtml(group.name)}</span>
            <span style="font-size:11px;color:#888;">${group.items.length}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;padding:5px;">
            ${group.items.length === 0
              ? '<div style="font-size:11px;color:#bbb;padding:3px 2px;">비어 있음</div>'
              : group.items.map(stock => {
                const typeTotal = typeTotals?.get(stock.meatTypeId || stock.meatNameSnapshot || stock.id)?.totalG ?? stock.remaining;
                const color = useTypeColor ? getStockColor(typeTotal, stock.meatTypeId) : (stock.remaining < 0 ? '#e53e3e' : '#1a1a1a');
                return `
                  <div class="stock-lot-card" style="border:1px solid #ececec;border-radius:5px;padding:5px;background:${stock.batchColor || '#fff'}11;">
                    <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;font-size:12px;flex:1;">${escapeHtml(stock.meatNameSnapshot || '-')}</span>
                      <b style="color:${color};font-variant-numeric:tabular-nums;font-size:12px;white-space:nowrap;">${(Number(stock.remaining || 0) / 1000).toFixed(2)}kg</b>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:6px;margin-top:3px;color:#777;font-size:11px;">
                      <span>${escapeHtml(dateLabel)}: ${escapeHtml(stock[dateField] || '-')}</span>
                      ${showInitial ? `<span>초기 ${(Number(stock.initialQtyG || 0) / 1000).toFixed(2)}kg</span>` : ''}
                    </div>
                    ${showStaffNote ? `
                      <div style="margin-top:2px;color:#888;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${escapeHtml(stock.staffName || '-')} / ${escapeHtml(stock.note || '-')}
                      </div>
                    ` : ''}
                    <div style="margin-top:4px;text-align:right;">
                      <button class="btn-adjust" data-id="${stock.id}" data-name="${escapeHtml(stock.meatNameSnapshot || '')}" data-remaining="${stock.remaining}" style="padding:2px 7px;font-size:11px;">조정</button>
                    </div>
                  </div>
                `;
              }).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function getMeatLogTimeValue(log) {
  if (log?.timestamp?.toMillis) return log.timestamp.toMillis();
  const value = log?.timestamp instanceof Date
    ? log.timestamp.getTime()
    : new Date(log?.timestamp || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function getMeatLogTypeKey(log) {
  return log.meatTypeId || 'name:' + (log.meatNameSnapshot || '-');
}

function buildMeatLogTypeGroups(logs) {
  const map = new Map();
  (logs || []).forEach(log => {
    const key = getMeatLogTypeKey(log);
    if (!map.has(key)) {
      map.set(key, {
        key,
        meatTypeId: log.meatTypeId || null,
        name: log.meatNameSnapshot || '-',
        latestTime: 0,
        items: [],
      });
    }
    const group = map.get(key);
    group.items.push(log);
    group.latestTime = Math.max(group.latestTime, getMeatLogTimeValue(log));
  });

  return [...map.values()].map(group => ({
    ...group,
    items: group.items.sort((a, b) => getMeatLogTimeValue(b) - getMeatLogTimeValue(a)),
  })).sort((a, b) => {
    const aOrder = getMeatTypeGroupSortOrder(a.meatTypeId);
    const bOrder = getMeatTypeGroupSortOrder(b.meatTypeId);
    if (aOrder !== bOrder) return aOrder - bOrder;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'ko');
    if (nameCompare !== 0) return nameCompare;
    return b.latestTime - a.latestTime;
  });
}

function buildMeatLogGroups(logs) {
  const groups = getScopedMeatStockCategories().map(g => ({ ...g, items: [], virtual: false }));
  const groupMap = new Map(groups.map(g => [g.id, g]));
  const otherGroup = { id: '__other__', name: '\uAE30\uD0C0', sortOrder: Number.MAX_SAFE_INTEGER, items: [], virtual: true };

  (logs || []).forEach(log => {
    const groupId = log.meatTypeId ? getMeatTypeGroupId(log.meatTypeId) : null;
    const group = groupId && groupMap.has(groupId) ? groupMap.get(groupId) : otherGroup;
    group.items.push(log);
  });

  [...groups, otherGroup].forEach(group => {
    group.items.sort((a, b) => getMeatLogTimeValue(b) - getMeatLogTimeValue(a));
  });

  return otherGroup.items.length > 0 ? [...groups, otherGroup] : groups;
}

function renderMeatLogCard(log, typeName) {
  return (
    '<div style="border:1px solid #ececec;border-radius:5px;background:#fff;padding:4px 5px;">' +
      '<div style="display:flex;align-items:center;gap:5px;min-width:0;">' +
        '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;font-size:12px;flex:1;">' + escapeHtml(log.meatNameSnapshot || typeName || '-') + '</span>' +
        '<span style="color:#777;font-size:11px;white-space:nowrap;">' + escapeHtml(formatMeatLogTimestamp(log.timestamp)) + '</span>' +
        '<b style="color:' + (log.delta < 0 ? '#e53e3e' : '#2d7a3a') + ';font-size:12px;white-space:nowrap;">' + formatMeatLogQty(log.delta) + '</b>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;gap:6px;margin-top:2px;color:#777;font-size:11px;">' +
        '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(log.staff || '-') + ' / ' + escapeHtml(log.reason || '-') + '</span>' +
        '<span style="white-space:nowrap;">' + escapeHtml(getMeatLogTypeLabel(log.type)) + '</span>' +
      '</div>' +
    '</div>'
  );
}

function renderMeatLogTypeGroup(group, typeGroup) {
  const typeId = [currentTab, group.id, typeGroup.key].join(':');
  const expanded = expandedMeatLogTypeIds.has(typeId);
  return (
    '<div class="meat-log-type-group" style="border:1px solid #ececec;border-radius:5px;background:#fff;overflow:hidden;">' +
      '<button type="button" class="meat-log-type-toggle" data-log-type-id="' + escapeHtml(typeId) + '" style="width:100%;border:0;background:#fff;display:flex;align-items:center;gap:5px;padding:5px 6px;cursor:pointer;text-align:left;">' +
        '<span style="color:#888;font-size:11px;width:10px;text-align:center;flex-shrink:0;">' + (expanded ? '-' : '+') + '</span>' +
        '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#333;font-size:12px;font-weight:700;flex:1;">' + escapeHtml(typeGroup.name) + '</span>' +
        '<span style="color:#888;font-size:11px;white-space:nowrap;">' + typeGroup.items.length + '&#44148;</span>' +
      '</button>' +
      (expanded
        ? '<div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid #eee;background:#fafafa;padding:4px;">' +
            typeGroup.items.map(log => renderMeatLogCard(log, typeGroup.name)).join('') +
          '</div>'
        : '') +
    '</div>'
  );
}

function renderMeatLogGroups(logs) {
  if (!logs || logs.length === 0) {
    return '<div style="text-align:center;color:#aaa;padding:20px;border:1px solid #eee;border-radius:6px;background:#fff;">&#51060;&#47141; &#50630;&#51020;</div>';
  }

  const groups = buildMeatLogGroups(logs).filter(group => group.items.length > 0);
  if (groups.length === 0) {
    return '<div style="text-align:center;color:#aaa;padding:20px;border:1px solid #eee;border-radius:6px;background:#fff;">&#51060;&#47141; &#50630;&#51020;</div>';
  }

  return (
    '<div class="meat-log-group-wrap" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;">' +
      groups.map(group => {
        const typeGroups = buildMeatLogTypeGroups(group.items);
        return (
          '<div class="meat-log-group" style="flex:0 0 calc((100% - 50px) / 6);flex-grow:0;flex-shrink:0;min-width:0;max-width:calc((100% - 50px) / 6);background:#fff;border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">' +
            '<div style="display:flex;align-items:center;gap:6px;padding:5px 7px;background:#f1f3f5;border-bottom:1px solid #e8e8e8;font-weight:700;color:#444;font-size:12px;">' +
              '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + escapeHtml(group.name) + '</span>' +
              '<span style="font-size:11px;color:#888;">' + group.items.length + '</span>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:4px;padding:5px;">' +
              typeGroups.map(typeGroup => renderMeatLogTypeGroup(group, typeGroup)).join('') +
            '</div>' +
          '</div>'
        );
      }).join('') +
    '</div>'
  );
}

function initMeatLogGroups() {
  document.querySelectorAll('.meat-log-type-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.logTypeId;
      if (!id) return;
      if (expandedMeatLogTypeIds.has(id)) expandedMeatLogTypeIds.delete(id);
      else expandedMeatLogTypeIds.add(id);
      renderTab(currentTab);
    });
  });
}

function destroyStockSummarySortables() {
  [...stockSummarySortables, stockSummaryCategorySortable].filter(Boolean).forEach(sortable => {
    try {
      sortable.destroy();
    } catch (err) {
      console.warn('[meat] stock summary sortable destroy skipped:', err);
    }
  });
  stockSummarySortables = [];
  stockSummaryCategorySortable = null;
}

async function persistStockSummaryMeatTypeGroups() {
  const batch = writeBatch(db);
  const now = new Date();
  const localUpdates = new Map();

  document.querySelectorAll('.stock-summary-category-items').forEach(list => {
    const groupId = list.dataset.categoryId === '__other__' ? null : list.dataset.categoryId;
    Array.from(list.querySelectorAll('.stock-summary-cell[data-meat-type-id]')).forEach((cell, idx) => {
      const meatTypeId = cell.dataset.meatTypeId;
      if (!meatTypeId) return;
      batch.update(doc(db, 'meatTypes', meatTypeId), {
        groupId,
        groupSortOrder: idx,
        updatedAt: now,
      });
      localUpdates.set(meatTypeId, { groupId, groupSortOrder: idx, updatedAt: now });
    });
  });

  await batch.commit();
  meatTypes = await loadMeatTypes();
  await renderTab(currentTab);
}

async function persistStockSummaryCategoryOrder() {
  const scope = getCurrentStockCategoryScope();
  const orderedIds = Array.from(document.querySelectorAll('.stock-summary-category-column[data-virtual="false"]'))
    .map(col => col.dataset.categoryId)
    .filter(Boolean);
  const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
  const nextGroups = meatStockCategories
    .map(g => (
      (g.scope || 'meat') === scope
        ? { ...g, sortOrder: orderMap.has(g.id) ? orderMap.get(g.id) : g.sortOrder }
        : g
    ))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  await saveMeatStockCategories(nextGroups);
}

function initStockSummarySortable() {
  destroyStockSummarySortables();
  const canManage = currentUserRole === 'admin' || currentUserRole === 'office';

  document.getElementById('btnMeatStockCategories')?.addEventListener('click', () => showMeatStockCategoriesModal());
  document.querySelectorAll('.stock-summary-main').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.stock-summary-drag-handle')) return;
      const cell = row.closest('.stock-summary-cell');
      const id = cell?.dataset.summaryId;
      if (!id) return;
      if (collapsedStockSummaryIds.has(id)) collapsedStockSummaryIds.delete(id);
      else collapsedStockSummaryIds.add(id);
      renderTab(currentTab);
    });
  });
  if (!canManage) return;

  const columnsEl = document.querySelector('.stock-summary-columns');
  if (columnsEl) {
    stockSummaryCategorySortable = Sortable.create(columnsEl, {
      animation: 150,
      handle: '.stock-summary-category-handle',
      draggable: '.stock-summary-category-column[data-virtual="false"]',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: async () => {
        try {
          await persistStockSummaryCategoryOrder();
        } catch (err) {
          console.error('[meat] stock category order save failed:', err);
          alert('카테고리 순서 저장 실패: ' + (err.message || err));
          meatStockCategories = await loadMeatStockCategories();
          renderTab(currentTab);
        }
      },
    });
  }

  document.querySelectorAll('.stock-summary-category-items').forEach(list => {
    const sortable = Sortable.create(list, {
      group: 'meatStockShared',
      animation: 150,
      handle: '.stock-summary-drag-handle',
      draggable: '.stock-summary-cell',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: async () => {
        try {
          await persistStockSummaryMeatTypeGroups();
        } catch (err) {
          console.error('[meat] stock group save failed:', err);
          alert('원료 카테고리 저장 실패: ' + (err.message || err));
          meatTypes = await loadMeatTypes();
          renderTab(currentTab);
        }
      },
    });
    stockSummarySortables.push(sortable);
  });
}

function renderMeatLayout() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <h2 class="page-title">원료 재고</h2>
        <div class="tab-group">
          <button class="tab-btn ${currentTab === 'frozen' ? 'active' : ''}" data-tab="frozen">냉동창고</button>
          <button class="tab-btn ${currentTab === 'processed' ? 'active' : ''}" data-tab="processed">전처리</button>
          <button class="tab-btn ${currentTab === 'repacked' ? 'active' : ''}" data-tab="repacked">재포장</button>
          <button class="tab-btn ${currentTab === 'produce' ? 'active' : ''}" data-tab="produce">채소/과일</button>
        </div>
      </div>
      <div id="tabContent"></div>
    </div>
  `;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTab(currentTab);
    });
  });

  renderTab(currentTab);
}

async function renderTab(tab) {
  const tabContent = document.getElementById('tabContent');
  tabContent.innerHTML = `<div style="padding:24px;"><p>로딩 중...</p></div>`;

  const dataStage = tab === 'produce' ? 'frozen' : tab;
  const [stocks, logs] = await Promise.all([
    loadMeatStocks(dataStage),
    loadMeatLogs(dataStage),
  ]);

  if (tab === 'frozen') {
    renderFrozenTab(stocks, logs);
  } else if (tab === 'processed') {
    renderProcessedTab(stocks, logs);
  } else if (tab === 'produce') {
    renderProduceTab(stocks, logs);
  } else {
    renderRepackedTab(stocks, logs);
  }

  initStockSummarySortable();
  initMeatLogGroups();
}

// 냉동창고 탭
function renderFrozenTab(stocks, logs) {
  const tabContent = document.getElementById('tabContent');
  const canManageMeatTypes = currentUserRole === 'admin' || currentUserRole === 'office';
  const meatStocks = stocks.filter(isMeatCategoryStock);
  const meatLogs = logs.filter(isMeatCategoryLog);
  const meatTotals = buildTotalByType(meatStocks);
  tabContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn-primary" id="btnAddFrozen">+ 원육 입고 등록</button>
      ${canManageMeatTypes ? '<button class="btn-secondary" id="btnMeatTypes">원육 종류 관리</button>' : ''}
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">잔량</span>
      </div>
      ${renderStockSummary(meatStocks)}
      ${renderStockLotGroups(meatStocks, {
        emptyText: '등록된 재고 없음',
        dateField: 'incomingDate',
        dateLabel: '입고일',
        typeTotals: meatTotals,
        useTypeColor: true,
      })}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>원육명</th>
              <th>작업일</th>
              <th>잔량</th>
              <th>수동조정</th>
            </tr>
          </thead>
          <tbody>
            ${meatStocks.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px;">등록된 재고 없음</td></tr>` :
              meatStocks.map(s => {
                const typeTotal = meatTotals.get(s.meatTypeId || s.meatNameSnapshot || s.id)?.totalG ?? s.remaining;
                const color = getStockColor(typeTotal, s.meatTypeId);
                return `
                <tr>
                  <td>${s.meatNameSnapshot}</td>
                  <td>${s.incomingDate || '-'}</td>
                  <td style="font-weight:600;color:${color}">${(s.remaining / 1000).toFixed(2)}kg</td>
                  <td><button class="btn-adjust" data-id="${s.id}" data-name="${s.meatNameSnapshot}" data-remaining="${s.remaining}">조정</button></td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">이력</span>
      </div>
      ${renderMeatLogGroups(meatLogs)}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>원료명</th>
              <th>구분</th>
              <th>수량</th>
              <th>담당자</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            ${meatLogs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
              meatLogs.map(l => `
                <tr>
                  <td>${formatMeatLogTimestamp(l.timestamp)}</td>
                  <td>${l.meatNameSnapshot || '-'}</td>
                  <td>${getMeatLogTypeLabel(l.type)}</td>
                  <td style="color:${l.delta < 0 ? '#e53e3e' : '#2d7a3a'};font-weight:600;">${formatMeatLogQty(l.delta)}</td>
                  <td>${l.staff || '-'}</td>
                  <td>${l.reason || '-'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnAddFrozen').addEventListener('click', () => showAddFrozenModal());
  document.getElementById('btnMeatTypes')?.addEventListener('click', () => {
    if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
      alert('원육 종류 관리는 대표/사무실 계정만 가능합니다.');
      return;
    }
    showMeatTypesModal();
  });
  document.querySelectorAll('.btn-adjust').forEach(btn => {
    btn.addEventListener('click', () => showAdjustModal(btn.dataset.id, btn.dataset.name, parseFloat(btn.dataset.remaining)));
  });
}

// 채소/과일 탭
function renderProduceTab(stocks, logs) {
  const tabContent = document.getElementById('tabContent');
  const canManageMeatTypes = currentUserRole === 'admin' || currentUserRole === 'office';
  const produceStocks = stocks.filter(isProduceCategoryStock);
  const produceLogs = logs.filter(isProduceCategoryLog);
  const produceTotals = buildTotalByType(produceStocks);

  tabContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn-primary" id="btnAddProduce">+ 채소/과일 입고 등록</button>
      ${canManageMeatTypes ? '<button class="btn-secondary" id="btnProduceTypes">채소/과일 종류 관리</button>' : ''}
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">잔량</span>
      </div>
      ${renderStockSummary(produceStocks)}
      ${renderStockLotGroups(produceStocks, {
        emptyText: '등록된 채소/과일 재고 없음',
        dateField: 'incomingDate',
        dateLabel: '입고일',
        showInitial: true,
        showStaffNote: true,
        typeTotals: produceTotals,
        useTypeColor: true,
      })}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>이름</th>
              <th>입고일</th>
              <th>초기량</th>
              <th>잔량</th>
              <th>담당</th>
              <th>비고</th>
              <th>조정</th>
            </tr>
          </thead>
          <tbody>
            ${produceStocks.length === 0 ? `<tr><td colspan="7" style="text-align:center;color:#aaa;padding:20px;">등록된 채소/과일 재고 없음</td></tr>` :
              produceStocks.map(s => {
                const typeTotal = produceTotals.get(s.meatTypeId || s.meatNameSnapshot || s.id)?.totalG ?? s.remaining;
                const color = getStockColor(typeTotal, s.meatTypeId);
                return `
                <tr>
                  <td>${s.meatNameSnapshot}</td>
                  <td>${s.incomingDate || '-'}</td>
                  <td>${((s.initialQtyG || 0) / 1000).toFixed(2)}kg</td>
                  <td style="font-weight:600;color:${color}">${(s.remaining / 1000).toFixed(2)}kg</td>
                  <td>${s.staffName || '-'}</td>
                  <td>${s.note || '-'}</td>
                  <td><button class="btn-adjust" data-id="${s.id}" data-name="${s.meatNameSnapshot}" data-remaining="${s.remaining}">조정</button></td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">이력</span>
      </div>
      ${renderMeatLogGroups(produceLogs)}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>원료명</th>
              <th>구분</th>
              <th>수량</th>
              <th>담당자</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            ${produceLogs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
              produceLogs.map(l => `
                <tr>
                  <td>${formatMeatLogTimestamp(l.timestamp)}</td>
                  <td>${l.meatNameSnapshot || '-'}</td>
                  <td>${getMeatLogTypeLabel(l.type)}</td>
                  <td style="color:${l.delta < 0 ? '#e53e3e' : '#2d7a3a'};font-weight:600;">${formatMeatLogQty(l.delta)}</td>
                  <td>${l.staff || '-'}</td>
                  <td>${l.reason || '-'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnAddProduce').addEventListener('click', () => {
    showAddFrozenModal({
      categoryFilter: 'produce',
      title: '채소/과일 입고 등록',
      returnTab: 'produce',
    });
  });
  document.getElementById('btnProduceTypes')?.addEventListener('click', () => {
    if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
      alert('채소/과일 종류 관리는 대표/사무실 계정만 가능합니다.');
      return;
    }
    showMeatTypesModal({ categoryFilter: 'produce' });
  });
  document.querySelectorAll('.btn-adjust').forEach(btn => {
    btn.addEventListener('click', () => showAdjustModal(btn.dataset.id, btn.dataset.name, parseFloat(btn.dataset.remaining)));
  });
}

// 전처리 탭
function renderProcessedTab(stocks, logs) {
  const tabContent = document.getElementById('tabContent');
  tabContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn-primary" id="btnAddProcessed">+ 전처리 등록</button>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">잔량</span>
      </div>
      ${renderStockSummary(stocks)}
      ${renderStockLotGroups(stocks, {
        emptyText: '등록된 전처리 재고 없음',
        dateField: 'processedDate',
        dateLabel: '작업일',
      })}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>원육명</th>
              <th>작업일</th>
              <th>잔량</th>
              <th>수동조정</th>
            </tr>
          </thead>
          <tbody>
            ${stocks.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px;">등록된 전처리 재고 없음</td></tr>` :
              stocks.map(s => `
                <tr style="background:${s.batchColor || 'white'}11">
                  <td>${s.meatNameSnapshot}</td>
                  <td>${s.processedDate || '-'}</td>
                  <td style="font-weight:600;color:${s.remaining < 0 ? '#e53e3e' : '#1a1a1a'}">${(s.remaining / 1000).toFixed(2)}kg</td>
                  <td><button class="btn-adjust" data-id="${s.id}" data-name="${s.meatNameSnapshot}" data-remaining="${s.remaining}">조정</button></td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">이력</span>
      </div>
      ${renderMeatLogGroups(logs)}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>원료명</th>
              <th>구분</th>
              <th>수량</th>
              <th>담당자</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
              logs.map(l => `
                <tr>
                  <td>${formatMeatLogTimestamp(l.timestamp)}</td>
                  <td>${l.meatNameSnapshot || '-'}</td>
                  <td>${getMeatLogTypeLabel(l.type)}</td>
                  <td style="color:${l.delta < 0 ? '#e53e3e' : '#2d7a3a'};font-weight:600;">${formatMeatLogQty(l.delta)}</td>
                  <td>${l.staff || '-'}</td>
                  <td>${l.reason || '-'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnAddProcessed').addEventListener('click', showAddProcessedModal);
  document.querySelectorAll('.btn-adjust').forEach(btn => {
    btn.addEventListener('click', () => showAdjustModal(btn.dataset.id, btn.dataset.name, parseFloat(btn.dataset.remaining)));
  });
}

// 재포장 탭
function renderRepackedTab(stocks, logs) {
  const tabContent = document.getElementById('tabContent');
  tabContent.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      <button class="btn-primary" id="btnAddRepacked">+ 재포장 등록</button>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">잔량</span>
      </div>
      ${renderStockSummary(stocks)}
      ${renderStockLotGroups(stocks, {
        emptyText: '등록된 재포장 재고 없음',
        dateField: 'repackedDate',
        dateLabel: '작업일',
      })}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>원육명</th>
              <th>작업일</th>
              <th>잔량</th>
              <th>수동조정</th>
            </tr>
          </thead>
          <tbody>
            ${stocks.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px;">등록된 재포장 재고 없음</td></tr>` :
              stocks.map(s => `
                <tr style="background:${s.batchColor || 'white'}11">
                  <td>${s.meatNameSnapshot}</td>
                  <td>${s.repackedDate || '-'}</td>
                  <td style="font-weight:600;color:${s.remaining < 0 ? '#e53e3e' : '#1a1a1a'}">${(s.remaining / 1000).toFixed(2)}kg</td>
                  <td><button class="btn-adjust" data-id="${s.id}" data-name="${s.meatNameSnapshot}" data-remaining="${s.remaining}">조정</button></td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="form-section">
      <div class="section-header">
        <span class="section-title">이력</span>
      </div>
      ${renderMeatLogGroups(logs)}
      <div class="table-wrap" style="display:none;">
        <table class="data-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>원료명</th>
              <th>구분</th>
              <th>수량</th>
              <th>담당자</th>
              <th>사유</th>
            </tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
              logs.map(l => `
                <tr>
                  <td>${formatMeatLogTimestamp(l.timestamp)}</td>
                  <td>${l.meatNameSnapshot || '-'}</td>
                  <td>${getMeatLogTypeLabel(l.type)}</td>
                  <td style="color:${l.delta < 0 ? '#e53e3e' : '#2d7a3a'};font-weight:600;">${formatMeatLogQty(l.delta)}</td>
                  <td>${l.staff || '-'}</td>
                  <td>${l.reason || '-'}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnAddRepacked').addEventListener('click', showAddRepackedModal);
  document.querySelectorAll('.btn-adjust').forEach(btn => {
    btn.addEventListener('click', () => showAdjustModal(btn.dataset.id, btn.dataset.name, parseFloat(btn.dataset.remaining)));
  });
}

// 원육 입고 등록 모달
function showAddFrozenModal(options = {}) {
  const {
    categoryFilter = 'meat',
    title = categoryFilter === 'produce' ? '채소/과일 입고 등록' : '원육 입고 등록',
    returnTab = 'frozen',
  } = options;
  const itemLabel = categoryFilter === 'produce' ? '채소/과일' : '원육';
  const activeMeatTypes = getActiveMeatTypes().filter(m => (
    categoryFilter === 'produce'
      ? m.category === 'produce'
      : (m.category || 'meat') === 'meat'
  ));

  showModal(`
    <h3 class="modal-title">${title}</h3>
    <div class="form-group">
      <label>${itemLabel} 종류 *</label>
      <select id="m_meatType">
        <option value="">선택</option>
        ${activeMeatTypes.map(m => `<option value="${m.id}" data-weight="${m.defaultUnitWeightG}">${m.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>중량 *</label>
        <input type="number" id="m_weight" placeholder="중량" />
      </div>
      <div class="form-group">
        <label>단위</label>
        <select id="m_unit">
          <option value="kg">kg</option>
          <option value="g">g</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>입고일</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['lead', 'office'])}
      </select>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="비고" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveFrozen">추가</button>
    </div>
  `);

  document.getElementById('btnSaveFrozen').addEventListener('click', async () => {
    const meatTypeId = document.getElementById('m_meatType').value;
    const meatTypeEl = document.getElementById('m_meatType');
    const meatName = meatTypeEl.options[meatTypeEl.selectedIndex]?.text;
    const weight = parseFloat(document.getElementById('m_weight').value);
    const unit = document.getElementById('m_unit').value;
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value;

    if (!meatTypeId || !weight || !date) {
      alert(`${itemLabel} 종류, 중량, 날짜는 필수입니다.`);
      return;
    }
    if (!(weight > 0)) {
      alert('중량은 0보다 커야 합니다.');
      return;
    }
    if (!staff) {
      alert('담당자를 선택해주세요.');
      return;
    }
    if (await blockIfClosed(date)) return;

    const qtyG = unit === 'kg' ? weight * 1000 : weight;

    const stockRef = await addDoc(collection(db, 'meatStocks'), {
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'frozen',
      incomingDate: date,
      initialQtyG: qtyG,
      remaining: qtyG,
      staffName: staff,
      note,
      closed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await recordMeatLog({
      type: 'frozenIncoming',
      date,
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'frozen',
      meatStockId: stockRef.id,
      delta: qtyG,
      before: 0,
      after: qtyG,
      staff,
      reason: note || null,
    });

    // [묶음 5A] 사무 로그 발행 — 원육 입고 (운영자가 메인 화면에서 변동 추적 가능하게)
    await recordActivity({
      action: 'meat',
      subAction: 'incoming',
      date,
      staff,
      message: `${itemLabel} 입고 (냉동창고) - ${meatName} +${(qtyG/1000).toFixed(1)}kg / 담당: ${staff}`,
      details: {
        meatStockId: stockRef.id,
        meatTypeId,
        meatName,
        stage: 'frozen',
        qtyG,
        note: note || null,
      },
    });

    closeModal();
    renderTab(returnTab);
    alert('입고 등록 완료!');
  });
}

// 전처리 등록 모달
function showAddProcessedModal() {
  showModal(`
    <h3 class="modal-title">전처리 등록</h3>
    <div class="form-group">
      <label>원육 종류 *</label>
      <select id="m_meatType">
        <option value="">선택</option>
        ${getActiveMeatTypes().map(m => `<option value="${m.id}" data-weight="${m.defaultUnitWeightG}">${m.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>개당 중량(g) *</label>
        <input type="number" id="m_unitWeight" placeholder="g" />
      </div>
      <div class="form-group">
        <label>개수 *</label>
        <input type="number" id="m_count" placeholder="개수" />
      </div>
    </div>
    <div class="form-group">
      <label>전처리일</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['lead', 'office'])}
      </select>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="비고" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveProcessed">추가</button>
    </div>
  `);

  // 원육 선택 시 기본 개당중량 자동 세팅
  document.getElementById('m_meatType').addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    const defaultWeight = opt.dataset.weight;
    if (defaultWeight) document.getElementById('m_unitWeight').value = defaultWeight;
  });

  document.getElementById('btnSaveProcessed').addEventListener('click', async () => {
    const meatTypeId = document.getElementById('m_meatType').value;
    const meatTypeEl = document.getElementById('m_meatType');
    const meatName = meatTypeEl.options[meatTypeEl.selectedIndex]?.text;
    const unitWeight = parseFloat(document.getElementById('m_unitWeight').value);
    const count = parseInt(document.getElementById('m_count').value);
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value;

    if (!meatTypeId || !unitWeight || !count || !date) {
      alert('원육 종류, 개당 중량, 개수, 날짜는 필수입니다.');
      return;
    }
    if (!(unitWeight > 0) || !(count > 0)) {
      alert('개당 중량과 개수는 0보다 커야 합니다.');
      return;
    }
    if (!staff) {
      alert('담당자를 선택해주세요.');
      return;
    }
    if (await blockIfClosed(date)) return;

    const totalG = unitWeight * count;

    // 냉동창고 잔량 확인 (FIFO 순서: incomingDate 오름차순)
    const allFrozen = await loadMeatStocks('frozen');
    const candidates = allFrozen
      .filter(s => s.meatTypeId === meatTypeId && s.remaining > 0)
      .sort((a, b) => (a.incomingDate || '').localeCompare(b.incomingDate || ''));

    const totalAvailable = candidates.reduce((sum, s) => sum + s.remaining, 0);
    if (totalAvailable < totalG) {
      alert(`냉동창고 잔량이 부족합니다.\n${meatName}: 필요 ${(totalG/1000).toFixed(1)}kg / 현재 ${(totalAvailable/1000).toFixed(1)}kg`);
      return;
    }

    const batchId = Date.now().toString();
    const batchColor = getRandomColor();

    // 냉동창고 FIFO 차감 + frozenOut 로그
    let remainingToDeduct = totalG;
    for (const lot of candidates) {
      if (remainingToDeduct <= 0) break;
      const deduct = Math.min(lot.remaining, remainingToDeduct);
      const newRemaining = lot.remaining - deduct;

      await updateDoc(doc(db, 'meatStocks', lot.id), {
        remaining: newRemaining,
        closed: newRemaining === 0,
        updatedAt: new Date(),
      });

      await recordMeatLog({
        type: 'frozenOut',
        date,
        meatTypeId,
        meatNameSnapshot: meatName,
        stage: 'frozen',
        meatStockId: lot.id,
        delta: -deduct,
        before: lot.remaining,
        after: newRemaining,
        staff,
        reason: '전처리 등록 자동차감',
        batchId,
      });

      remainingToDeduct -= deduct;
    }

    // 전처리 신규 행 추가
    const newStockRef = await addDoc(collection(db, 'meatStocks'), {
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'processed',
      incomingDate: date,
      processedDate: date,
      unitWeightG: unitWeight,
      unitCount: count,
      initialQtyG: totalG,
      remaining: totalG,
      batchId,
      batchColor,
      staffName: staff,
      note,
      closed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await recordMeatLog({
      type: 'processedIn',
      date,
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'processed',
      meatStockId: newStockRef.id,
      delta: totalG,
      before: 0,
      after: totalG,
      staff,
      reason: note || null,
      batchId,
    });

    closeModal();
    renderTab('processed');
    alert('전처리 등록 완료!');
  });
}

// 재포장 등록 모달
function showAddRepackedModal() {
  showModal(`
    <h3 class="modal-title">재포장 등록</h3>
    <div class="form-group">
      <label>원육 종류 *</label>
      <select id="m_meatType">
        <option value="">선택</option>
        ${getActiveMeatTypes().map(m => `<option value="${m.id}" data-weight="${m.defaultUnitWeightG}">${m.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>개당 중량(g) *</label>
        <input type="number" id="m_unitWeight" placeholder="g" />
      </div>
      <div class="form-group">
        <label>개수 *</label>
        <input type="number" id="m_count" placeholder="개수" />
      </div>
    </div>
    <div class="form-group">
      <label>재포장일</label>
      <input type="date" id="m_date" value="${getToday()}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['lead', 'office'])}
      </select>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" placeholder="비고" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveRepacked">추가</button>
    </div>
  `);

  document.getElementById('m_meatType').addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    const defaultWeight = opt.dataset.weight;
    if (defaultWeight) document.getElementById('m_unitWeight').value = defaultWeight;
  });

  document.getElementById('btnSaveRepacked').addEventListener('click', async () => {
    const meatTypeId = document.getElementById('m_meatType').value;
    const meatTypeEl = document.getElementById('m_meatType');
    const meatName = meatTypeEl.options[meatTypeEl.selectedIndex]?.text;
    const unitWeight = parseFloat(document.getElementById('m_unitWeight').value);
    const count = parseInt(document.getElementById('m_count').value);
    const date = document.getElementById('m_date').value;
    const staff = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value;

    if (!meatTypeId || !unitWeight || !count || !date) {
      alert('원육 종류, 개당 중량, 개수, 날짜는 필수입니다.');
      return;
    }
    if (!(unitWeight > 0) || !(count > 0)) {
      alert('개당 중량과 개수는 0보다 커야 합니다.');
      return;
    }
    if (!staff) {
      alert('담당자를 선택해주세요.');
      return;
    }
    if (await blockIfClosed(date)) return;

    const totalG = unitWeight * count;

    // 같은 원육 활성 재포장 행 중복 차단 (spec 9절 탭3)
    const allRepacked = await loadMeatStocks('repacked');
    const existingActive = allRepacked.find(s => s.meatTypeId === meatTypeId && s.remaining > 0);
    if (existingActive) {
      alert(`같은 원육의 재포장 행이 이미 존재합니다.\n${meatName}: 기존 잔량 ${(existingActive.remaining/1000).toFixed(1)}kg\n기존 재포장을 모두 사용한 후 등록하세요.`);
      return;
    }

    // 전처리 잔량 확인 (FIFO 순서: processedDate 오름차순)
    const allProcessed = await loadMeatStocks('processed');
    const candidates = allProcessed
      .filter(s => s.meatTypeId === meatTypeId && s.remaining > 0)
      .sort((a, b) => (a.processedDate || '').localeCompare(b.processedDate || ''));

    const totalAvailable = candidates.reduce((sum, s) => sum + s.remaining, 0);
    if (totalAvailable < totalG) {
      alert(`전처리 잔량이 부족합니다.\n${meatName}: 필요 ${(totalG/1000).toFixed(1)}kg / 현재 ${(totalAvailable/1000).toFixed(1)}kg`);
      return;
    }

    const batchId = Date.now().toString();
    const batchColor = getRandomColor();

    // 전처리 FIFO 차감 + processedOut 로그
    let remainingToDeduct = totalG;
    for (const lot of candidates) {
      if (remainingToDeduct <= 0) break;
      const deduct = Math.min(lot.remaining, remainingToDeduct);
      const newRemaining = lot.remaining - deduct;

      await updateDoc(doc(db, 'meatStocks', lot.id), {
        remaining: newRemaining,
        closed: newRemaining === 0,
        updatedAt: new Date(),
      });

      await recordMeatLog({
        type: 'processedOut',
        date,
        meatTypeId,
        meatNameSnapshot: meatName,
        stage: 'processed',
        meatStockId: lot.id,
        delta: -deduct,
        before: lot.remaining,
        after: newRemaining,
        staff,
        reason: '재포장 등록 자동차감',
        batchId,
      });

      remainingToDeduct -= deduct;
    }

    // 재포장 신규 행 추가
    const newStockRef = await addDoc(collection(db, 'meatStocks'), {
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'repacked',
      incomingDate: date,
      repackedDate: date,
      unitWeightG: unitWeight,
      unitCount: count,
      initialQtyG: totalG,
      remaining: totalG,
      batchId,
      batchColor,
      staffName: staff,
      note,
      closed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await recordMeatLog({
      type: 'repackedIn',
      date,
      meatTypeId,
      meatNameSnapshot: meatName,
      stage: 'repacked',
      meatStockId: newStockRef.id,
      delta: totalG,
      before: 0,
      after: totalG,
      staff,
      reason: note || null,
      batchId,
    });

    closeModal();
    renderTab('repacked');
    alert('재포장 등록 완료!');
  });
}

// 수동 조정 모달
function showAdjustModal(id, name, remaining) {
  showModal(`
    <h3 class="modal-title">수동 재고 조정 — ${name}</h3>
    <p style="font-size:12px;color:#888;margin-bottom:16px;">기존 잔량: <strong>${(remaining/1000).toFixed(1)}kg</strong> (${remaining}g)</p>
    <div class="form-group">
      <label>실제 잔량 (g) *</label>
      <input type="number" id="m_actualRemaining" placeholder="실제 잔량(g) 입력" min="0" step="1" />
      <p style="font-size:11px;color:#aaa;margin-top:4px;">실제로 남아있는 양을 g 단위로 입력하세요. 0 이상만 가능.</p>
    </div>
    <div class="form-group">
      <label>사유 *</label>
      <input type="text" id="m_adjustReason" placeholder="조정 사유 입력" />
    </div>
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['lead', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveAdjust">조정</button>
    </div>
  `);

  document.getElementById('btnSaveAdjust').addEventListener('click', async () => {
    const inputVal = document.getElementById('m_actualRemaining').value;
    const reason = document.getElementById('m_adjustReason').value.trim();
    const staff = document.getElementById('m_staff').value;

    if (inputVal === '' || isNaN(parseFloat(inputVal))) {
      alert('실제 잔량을 입력해주세요.');
      return;
    }
    const newRemaining = parseFloat(inputVal);
    if (newRemaining < 0) {
      alert('실제 잔량은 0 이상이어야 합니다.\n잔량이 음수가 될 수 없습니다.');
      return;
    }
    if (!reason || !staff) {
      alert('사유와 담당자는 필수입니다.');
      return;
    }
    const delta = newRemaining - remaining;
    if (delta === 0) {
      alert('기존 잔량과 동일합니다. 변경할 값을 입력해주세요.');
      return;
    }

    const adjustDate = getToday();
    if (await blockIfClosed(adjustDate)) return;

    // meatStocks 문서에서 meatTypeId 가져오기 (meatLogs 기록용)
    const stockSnap = await getDoc(doc(db, 'meatStocks', id));
    const stockData = stockSnap.exists() ? stockSnap.data() : {};
    const meatTypeId = stockData.meatTypeId || null;

    await updateDoc(doc(db, 'meatStocks', id), {
      remaining: newRemaining,
      closed: newRemaining === 0,
      updatedAt: new Date(),
    });

    const logStage = currentTab === 'produce' ? 'frozen' : currentTab;
    const stageKor = currentTab === 'frozen' ? '냉동창고' : currentTab === 'processed' ? '전처리' : currentTab === 'produce' ? '채소/과일' : '재포장';
    await recordActivity({
      action: 'meat',
      subAction: 'adjust',
      date: adjustDate,
      staff,
      message: `원육 수동조정 (${stageKor}) — ${name} ${(remaining/1000).toFixed(1)}kg → ${(newRemaining/1000).toFixed(1)}kg / 사유: ${reason} / 담당: ${staff}`,
      details: {
        meatStockId: id,
        meatName: name,
        stage: stageKor,
        delta,
        before: remaining,
        after: newRemaining,
        reason,
      },
    });

    await recordMeatLog({
      type: 'adjust',
      date: adjustDate,
      meatTypeId,
      meatNameSnapshot: name,
      stage: logStage,
      meatStockId: id,
      delta,
      before: remaining,
      after: newRemaining,
      staff,
      reason,
    });

    closeModal();
    renderTab(currentTab);
    alert('조정 완료!');
  });
}

// 원육 종류 관리 모달
function renderMeatStockCategoryRows() {
  const scopedCategories = getScopedMeatStockCategories();
  if (scopedCategories.length === 0) {
    return '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px;">등록된 카테고리 없음</td></tr>';
  }
  return scopedCategories.map(group => {
    const count = meatTypes.filter(m => m.groupId === group.id).length;
    return `
      <tr data-id="${group.id}">
        <td class="master-table-drag-cell">
          <span class="drag-handle" title="순서 변경" aria-label="순서 변경">⠿</span>
        </td>
        <td>
          <input type="text" class="stock-category-name" data-id="${group.id}" value="${escapeHtml(group.name)}"
                 style="width:100%;padding:5px 6px;" />
        </td>
        <td style="text-align:right;color:#666;">${count}</td>
        <td>
          <button type="button" class="btn-secondary btn-delete-stock-category" data-id="${group.id}">삭제</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function refreshMeatStockCategoryModal() {
  meatTypes = await loadMeatTypes();
  meatStockCategories = await loadMeatStockCategories();
  await renderTab(currentTab);
  showMeatStockCategoriesModal();
}

function showMeatStockCategoriesModal() {
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
    alert('카테고리 관리는 대표/사무실 계정만 가능합니다.');
    return;
  }

  showModal(`
    <h3 class="modal-title">원료 잔량표 카테고리 관리</h3>
    <div class="table-wrap" style="margin-bottom:14px;">
      <table class="data-table">
        <thead>
          <tr>
            <th class="master-table-drag-col"></th>
            <th>카테고리명</th>
            <th style="text-align:right;">원료 수</th>
            <th>삭제</th>
          </tr>
        </thead>
        <tbody id="meatStockCategoryList">
          ${renderMeatStockCategoryRows()}
        </tbody>
      </table>
    </div>
    <div style="background:#f9f9f9;border-radius:6px;padding:12px;border:1px solid #eee;">
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px;">새 카테고리</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="newStockCategoryName" placeholder="예: 닭 / 오리 / 생선" style="flex:1;" />
        <button type="button" class="btn-primary" id="btnAddStockCategory">추가</button>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);

  const scope = getCurrentStockCategoryScope();
  const scopedCategories = getScopedMeatStockCategories(scope);
  const listEl = document.getElementById('meatStockCategoryList');
  if (listEl && scopedCategories.length > 0) {
    Sortable.create(listEl, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: async () => {
        const orderedIds = Array.from(listEl.querySelectorAll('tr[data-id]')).map(row => row.dataset.id);
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
        try {
          await saveMeatStockCategories(meatStockCategories.map(g => (
            (g.scope || 'meat') === scope
              ? { ...g, sortOrder: orderMap.has(g.id) ? orderMap.get(g.id) : g.sortOrder }
              : g
          )));
          await renderTab(currentTab);
        } catch (err) {
          console.error('[meat] stock category modal order save failed:', err);
          alert('카테고리 순서 저장 실패: ' + (err.message || err));
          meatStockCategories = await loadMeatStockCategories();
          showMeatStockCategoriesModal();
        }
      },
    });
  }

  document.querySelectorAll('.stock-category-name').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const name = e.target.value.trim();
      const target = scopedCategories.find(g => g.id === id);
      if (!target) return;
      if (!name) {
        alert('카테고리명을 입력해주세요.');
        e.target.value = target.name;
        return;
      }
      try {
        await saveMeatStockCategories(meatStockCategories.map(g => g.id === id ? { ...g, name } : g));
        await renderTab(currentTab);
      } catch (err) {
        console.error('[meat] stock category rename failed:', err);
        alert('카테고리명 저장 실패: ' + (err.message || err));
        e.target.value = target.name;
      }
    });
  });

  document.getElementById('btnAddStockCategory')?.addEventListener('click', async () => {
    const input = document.getElementById('newStockCategoryName');
    const name = input.value.trim();
    if (!name) { alert('카테고리명을 입력해주세요.'); return; }
    const nextGroups = [
      ...meatStockCategories,
      { id: createMeatStockCategoryId(), name, sortOrder: scopedCategories.length, scope },
    ];
    try {
      await saveMeatStockCategories(nextGroups);
      await refreshMeatStockCategoryModal();
    } catch (err) {
      console.error('[meat] stock category add failed:', err);
      alert('카테고리 추가 실패: ' + (err.message || err));
    }
  });

  document.querySelectorAll('.btn-delete-stock-category').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const group = scopedCategories.find(g => g.id === id);
      if (!group) return;
      try {
        const now = new Date();
        const batch = writeBatch(db);
        meatTypes.filter(m => m.groupId === id).forEach(m => {
          batch.update(doc(db, 'meatTypes', m.id), {
            groupId: null,
            groupSortOrder: 0,
            updatedAt: now,
          });
        });
        await batch.commit();
        await saveMeatStockCategories(meatStockCategories.filter(g => g.id !== id));
        await refreshMeatStockCategoryModal();
      } catch (err) {
        console.error('[meat] stock category delete failed:', err);
        alert('카테고리 삭제 실패: ' + (err.message || err));
      }
    });
  });
}

function showMeatTypesModal(options = {}) {
  const { categoryFilter = null } = options;
  const effectiveCategoryFilter = categoryFilter || 'meat';
  const canReorderMeatTypes = effectiveCategoryFilter === 'meat' && (currentUserRole === 'admin' || currentUserRole === 'office');
  const filteredMeatTypes = meatTypes.filter(m => getMeatTypeCategory(m.id) === effectiveCategoryFilter);
  const isProduceModal = effectiveCategoryFilter === 'produce';
  const itemLabel = isProduceModal ? '채소/과일' : '원육';
  const modalTitle = isProduceModal ? '채소/과일 종류 관리' : '원육 종류 관리';
  const minQtyUnit = isProduceModal ? 'g' : 'kg';
  showModal(`
    <h3 class="modal-title">${modalTitle}</h3>
    <div class="table-wrap" style="margin-bottom:16px;">
      <table class="data-table">
        <thead>
          <tr>
            <th class="master-table-drag-col"></th>
            <th>${itemLabel}명</th>
            <th>기본 단위중량(g)</th>
            <th>최소재고(${minQtyUnit})</th>
            <th>\uD65C\uC131</th>
          </tr>
        </thead>
        <tbody id="meatTypesList">
          ${filteredMeatTypes.map(m => {
            const active = m.active !== false;
            const minQtyValue = isProduceModal ? (m.minimumQtyG || 0) : ((m.minimumQtyG || 0) / 1000).toFixed(1);
            return `
              <tr class="${active ? '' : 'inactive-master'}" data-id="${m.id}">
                <td class="master-table-drag-cell">
                  ${canReorderMeatTypes ? '<span class="drag-handle" title="순서 변경" aria-label="순서 변경">≡</span>' : ''}
                </td>
                <td>
                  ${m.name}
                  ${active ? '' : '<span class="tag tag-inactive" style="margin-left:6px;">\uBE44\uD65C\uC131</span>'}
                </td>
                <td>
                  <input type="number" class="m-unit-weight" data-id="${m.id}"
                         value="${m.defaultUnitWeightG}" min="1" step="any"
                         style="width:70px;padding:3px 4px;text-align:right;" />
                </td>
                <td>
                  <input type="number" class="m-min-qty" data-id="${m.id}"
                         value="${minQtyValue}" min="0" step="any"
                         style="width:70px;padding:3px 4px;text-align:right;" />
                </td>
                <td>
                  <label class="toggle-switch" title="${active ? '\uD65C\uC131' : '\uBE44\uD65C\uC131'}">
                    <input type="checkbox" class="m-active-toggle" data-id="${m.id}" ${active ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </label>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="background:#f9f9f9;border-radius:6px;padding:14px;border:1px solid #eee;">
      <p style="font-size:12px;font-weight:600;margin-bottom:10px;">새 ${itemLabel} 종류 추가</p>
      <div class="form-row">
        <div class="form-group">
          <label>${itemLabel}명 *</label>
          <input type="text" id="m_newMeatName" placeholder="예: 닭가슴살" />
        </div>
        <div class="form-group">
          <label>기본 단위중량(g)</label>
          <input type="number" id="m_newUnitWeight" placeholder="예: 500" />
        </div>
        <div class="form-group">
          <label>최소재고(${minQtyUnit})</label>
          <input type="number" id="m_newMinQty" placeholder="${isProduceModal ? '예: 500' : '예: 5'}" />
        </div>
      </div>
      <button class="btn-primary" id="btnAddMeatType">추가</button>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);

  initMeatTypeSortable();
  const baseCloseModal = window.closeModal;
  window.closeModal = function() {
    destroyMeatTypeSortable();
    baseCloseModal?.();
    window.closeModal = baseCloseModal;
  };

  document.querySelectorAll('.m-unit-weight').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const target = meatTypes.find(m => m.id === id);
      const prev = target?.defaultUnitWeightG;
      const value = parseFloat(e.target.value);
      if (!isFinite(value) || value <= 0) {
        alert('기본 단위중량은 양수(g)여야 합니다.');
        e.target.value = prev ?? '';
        return;
      }
      try {
        await updateDoc(doc(db, 'meatTypes', id), {
          defaultUnitWeightG: value,
          updatedAt: new Date(),
        });
        if (target) target.defaultUnitWeightG = value;
      } catch (err) {
        console.error('[meat] defaultUnitWeightG 저장 실패:', err);
        alert('저장 실패: ' + (err.message || err));
        e.target.value = prev ?? '';
      }
    });
  });

  document.querySelectorAll('.m-min-qty').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const target = meatTypes.find(m => m.id === id);
      const prevG = target?.minimumQtyG ?? 0;
      const value = parseFloat(e.target.value);
      if (!isFinite(value) || value < 0) {
        alert(`최소재고는 0 이상(${minQtyUnit})이어야 합니다.`);
        e.target.value = isProduceModal ? prevG : (prevG / 1000).toFixed(1);
        return;
      }
      const grams = isProduceModal ? Math.round(value) : Math.round(value * 1000);
      try {
        await updateDoc(doc(db, 'meatTypes', id), {
          minimumQtyG: grams,
          updatedAt: new Date(),
        });
        if (target) target.minimumQtyG = grams;
      } catch (err) {
        console.error('[meat] minimumQtyG 저장 실패:', err);
        alert('저장 실패: ' + (err.message || err));
        e.target.value = isProduceModal ? prevG : (prevG / 1000).toFixed(1);
      }
    });
  });

  document.querySelectorAll('.m-active-toggle').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const active = e.target.checked;
      const target = meatTypes.find(m => m.id === id);
      const previousActive = target?.active !== false;
      try {
        await updateDoc(doc(db, 'meatTypes', id), {
          active,
          updatedAt: new Date(),
        });
        if (target) target.active = active;
        if (previousActive !== active) {
          await recordActivity({
            action: 'meat',
            subAction: 'activeToggle',
            date: getToday(),
            staff: getRoleStaffLabel(),
            message: `Meat type ${active ? 'active' : 'inactive'} — ${target?.name || id}`,
            details: {
              meatTypeId: id,
              meatName: target?.name || '',
              active,
            },
          });
        }
        closeModal();
        showMeatTypesModal(options);
      } catch (err) {
        console.error('[meat] active save failed:', err);
        alert('Save failed: ' + (err.message || err));
        e.target.checked = !active;
      }
    });
  });

  document.getElementById('btnAddMeatType').addEventListener('click', async () => {
    const name = document.getElementById('m_newMeatName').value.trim();
    const unitWeight = parseFloat(document.getElementById('m_newUnitWeight').value) || 0;
    const minQty = parseFloat(document.getElementById('m_newMinQty').value) || 0;
    const category = effectiveCategoryFilter;

    if (!name) { alert(`${itemLabel}명은 필수입니다.`); return; }

    await addDoc(collection(db, 'meatTypes'), {
      name,
      defaultUnitWeightG: unitWeight,
      minimumQtyG: isProduceModal ? Math.round(minQty) : Math.round(minQty * 1000),
      category,
      sortOrder: meatTypes.length,
      active: true,
      showInStats: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    meatTypes = await loadMeatTypes();
    closeModal();
    showMeatTypesModal(options);
  });
}

// 유틸

function initMeatTypeSortable() {
  destroyMeatTypeSortable();
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') return;
  const el = document.getElementById('meatTypesList');
  if (!el) return;
  meatTypesSortable = Sortable.create(el, {
    handle: '.drag-handle',
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: async (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      await persistMeatTypeOrder();
    },
  });
}

function destroyMeatTypeSortable() {
  if (!meatTypesSortable) return;
  try {
    meatTypesSortable.destroy();
  } catch (err) {
    console.warn('[meat] sortable destroy skipped:', err);
  }
  meatTypesSortable = null;
}

async function persistMeatTypeOrder() {
  const listEl = document.getElementById('meatTypesList');
  if (!listEl) return;
  const orderedIds = Array.from(listEl.querySelectorAll('tr[data-id]'))
    .map(row => row.dataset.id)
    .filter(Boolean);
  const now = new Date();
  const batch = writeBatch(db);

  orderedIds.forEach((id, idx) => {
    batch.update(doc(db, 'meatTypes', id), {
      sortOrder: idx,
      updatedAt: now,
    });
  });

  try {
    await batch.commit();
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    meatTypes = meatTypes
      .map(m => orderMap.has(m.id) ? { ...m, sortOrder: orderMap.get(m.id), updatedAt: now } : m)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  } catch (err) {
    console.error('[meat] reorder save failed:', err);
    alert('순번 저장 실패: ' + (err.message || err));
    meatTypes = await loadMeatTypes();
    closeModal();
    showMeatTypesModal();
  }
}

function getRandomColor() {
  const colors = ['#e8f4ea', '#e8eef8', '#fef0e8', '#f0e8fe', '#fff0e8', '#e8f8f4'];
  return colors[Math.floor(Math.random() * colors.length)];
}

let staffCache = {};
async function loadStaffCache() {
  if (Object.keys(staffCache).length > 0) return;
  for (const key of ['senior', 'lead', 'office']) {
    const snap = await getDoc(doc(db, 'staffGroups', key));
    if (snap.exists()) staffCache[key] = snap.data().members || [];
  }
}

function getRoleStaffLabel() {
  if (currentUserRole === 'admin') return '\uB300\uD45C';
  if (currentUserRole === 'office') return '\uC0AC\uBB34\uC2E4';
  if (currentUserRole === 'production') return '\uC0DD\uC0B0\uC2E4';
  return '\uC2DC\uC2A4\uD15C';
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

// 모달
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
