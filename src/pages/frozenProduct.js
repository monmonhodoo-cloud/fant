import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, query, orderBy, getDoc, writeBatch,
  deleteDoc, where, setDoc, serverTimestamp,
} from 'firebase/firestore';
import { getTodayKST as getToday, addMonthsKST } from '../utils/date.js';
import { getActiveFreezeDryRecipes, getRecipeOptionsHtml } from '../utils/recipe.js';
import { blockIfClosed } from '../utils/closingGuard.js';
import { currentUserRole } from '../app.js';
import { showConfirmModal } from '../utils/modal.js';
import { recordActivity } from '../services/activityLogs.js';
import Sortable from 'sortablejs';

let frozenProducts = [];
let selectedProductId = null;

const FROZEN_PRODUCT_CATEGORY_STORAGE_KEY = 'frozenProductCategoryCollapsed';
const FROZEN_PRODUCT_CATEGORIES = [
  { key: 'cat-product', label: '고양이', target: 'cat', kind: 'product' },
  { key: 'dog-product', label: '강아지', target: 'dog', kind: 'product' },
  { key: 'common-product', label: '공용', target: 'common', kind: 'product' },
  { key: 'cat-sample', label: '고양이샘플', target: 'cat', kind: 'sample' },
  { key: 'dog-sample', label: '강아지샘플', target: 'dog', kind: 'sample' },
  { key: 'common-sample', label: '공용샘플', target: 'common', kind: 'sample' },
  { key: 'sample-set', label: '샘플세트', target: null, kind: 'sampleSet' },
];

export async function renderFrozenProduct() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>동결제품 입고 로딩 중...</p></div>`;
  await loadStaffCache();
  frozenProducts = await loadFrozenProducts();
  renderFrozenProductLayout();
}

async function loadFrozenProducts() {
  const q = query(collection(db, 'frozenProducts'), orderBy('sortOrder'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadFrozenLogs(productId) {
  const q = query(collection(db, 'frozenLogs'), orderBy('timestamp', 'desc'));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => l.productId === productId && l.status !== 'deleted')
    .slice(0, 30);
}

function renderFrozenProductLayout() {
  const content = document.getElementById('mainContent');
  const canManageFrozenProduct = currentUserRole === 'admin' || currentUserRole === 'office';
  content.innerHTML = `
    <div class="recipe-wrap">
      <!-- 왼쪽: 제품 목록 -->
      <div class="recipe-list-panel">
        <div class="panel-header">
          <span class="panel-title">제품 목록</span>
          ${canManageFrozenProduct ? '<button class="btn-primary" id="btnNewProduct">+ 추가</button>' : ''}
        </div>
        <div class="recipe-list" id="productList">
          ${renderProductList()}
        </div>
      </div>

      <!-- 오른쪽: 입고 이력 -->
      <div class="recipe-detail-panel" id="productDetail">
        <div class="detail-empty">제품을 선택해주세요</div>
      </div>
    </div>
  `;

  bindProductListEvents();
  initFrozenProductSortable();
  document.getElementById('btnNewProduct')?.addEventListener('click', showNewProductModal);
}

function getFrozenProductTarget(product) {
  const name = product?.name || '';
  if (['cat', 'dog', 'common'].includes(product?.target)) return product.target;
  if (name.startsWith('고양이 ')) return 'cat';
  if (name.startsWith('강아지 ')) return 'dog';
  return 'common';
}

function getFrozenProductKind(product) {
  if (['product', 'sample', 'sampleSet'].includes(product?.kind)) return product.kind;
  return 'product';
}

function getProductCategoryKey(product) {
  const kind = getFrozenProductKind(product);
  if (kind === 'sampleSet') return 'sample-set';
  return `${getFrozenProductTarget(product)}-${kind}`;
}

function getFrozenProductCollapsedState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FROZEN_PRODUCT_CATEGORY_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function setFrozenProductCategoryCollapsed(categoryKey, collapsed) {
  const state = getFrozenProductCollapsedState();
  state[categoryKey] = collapsed;
  localStorage.setItem(FROZEN_PRODUCT_CATEGORY_STORAGE_KEY, JSON.stringify(state));
}

function renderProductListItemCompact(p) {
  const canReorder = currentUserRole === 'admin' || currentUserRole === 'office';
  return `
    <div class="recipe-list-item ${selectedProductId === p.id ? 'active' : ''}"
      data-id="${p.id}" style="padding:3px 8px;min-height:28px;">
      ${canReorder ? '<span class="drag-handle" title="순서 변경" aria-label="순서 변경">☰</span>' : ''}
      <div class="recipe-list-info" style="gap:0;">
        <span class="recipe-name" style="font-size:12.5px;line-height:1.2;">${p.name}</span>
      </div>
    </div>
  `;
}

function renderProductListByCategory() {
  const collapsedState = getFrozenProductCollapsedState();
  return FROZEN_PRODUCT_CATEGORIES
    .map(category => {
      const products = frozenProducts.filter(p => getProductCategoryKey(p) === category.key);
      const collapsed = collapsedState[category.key] === true;
      return `
        <div class="frozen-product-category" data-category="${category.key}">
          <button type="button" class="frozen-product-category-header" data-category="${category.key}"
            style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:4px 8px;margin:3px 0 1px;border:0;background:#f5f5f5;border-radius:6px;cursor:pointer;font-weight:700;font-size:12.5px;color:#333;">
            <span>${collapsed ? '▶' : '▼'} ${category.label}</span>
            <span style="font-size:11px;color:#777;">${products.length}</span>
          </button>
          <div class="frozen-product-category-items" data-category="${category.key}" style="${collapsed ? 'display:none;' : ''}">
            ${products.length === 0
              ? '<div style="padding:4px 8px;color:#aaa;font-size:11.5px;">등록된 제품 없음</div>'
              : products.map(renderProductListItemCompact).join('')}
          </div>
        </div>
      `;
    }).join('');
}

function renderProductList() {
  return renderProductListByCategory();
}

function initFrozenProductSortable() {
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') return;
  document.querySelectorAll('.frozen-product-category-items').forEach(el => {
    Sortable.create(el, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      group: {
        name: `frozenProduct-${el.dataset.category || 'group'}`,
        pull: false,
        put: false,
      },
      onEnd: async (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        await persistFrozenProductOrder();
      },
    });
  });
}

async function persistFrozenProductOrder() {
  const listEl = document.getElementById('productList');
  if (!listEl) return;
  const orderedIds = Array.from(listEl.querySelectorAll('.recipe-list-item'))
    .map(item => item.dataset.id)
    .filter(Boolean);
  const now = new Date();
  const batch = writeBatch(db);
  orderedIds.forEach((id, idx) => {
    batch.update(doc(db, 'frozenProducts', id), {
      sortOrder: idx,
      updatedAt: now,
    });
  });

  try {
    await batch.commit();
    const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
    frozenProducts = frozenProducts
      .map(p => orderMap.has(p.id) ? { ...p, sortOrder: orderMap.get(p.id), updatedAt: now } : p)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  } catch (err) {
    console.error('[frozenProduct] reorder save failed:', err);
    alert('순번 저장 실패: ' + (err.message || err));
    frozenProducts = await loadFrozenProducts();
    renderFrozenProductLayout();
    if (selectedProductId) {
      const selected = frozenProducts.find(p => p.id === selectedProductId);
      if (selected) await showProductDetail(selected);
    }
  }
}

function bindProductListEvents() {
  document.querySelectorAll('.frozen-product-category-header').forEach(header => {
    header.addEventListener('click', () => {
      const categoryKey = header.dataset.category;
      const body = document.querySelector(`.frozen-product-category-items[data-category="${categoryKey}"]`);
      if (!categoryKey || !body) return;
      const collapsed = body.style.display !== 'none';
      setFrozenProductCategoryCollapsed(categoryKey, collapsed);
      renderFrozenProductLayout();
      if (selectedProductId) {
        const selected = frozenProducts.find(p => p.id === selectedProductId);
        if (selected) showProductDetail(selected);
      }
    });
  });

  document.querySelectorAll('.recipe-list-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.drag-handle')) return;
      selectedProductId = item.dataset.id;
      document.querySelectorAll('.recipe-list-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const product = frozenProducts.find(p => p.id === selectedProductId);
      await showProductDetail(product);
    });
  });
}

async function getActiveFrozenLogCount(productId) {
  const snap = await getDocs(query(collection(db, 'frozenLogs'), where('productId', '==', productId)));
  return snap.docs
    .map(d => d.data())
    .filter(log => log.status !== 'deleted')
    .length;
}

async function deleteFrozenProductIfNoLogs(product) {
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
    alert('동결제품 삭제는 관리자/사무 계정만 가능합니다.');
    return;
  }

  const logCount = await getActiveFrozenLogCount(product.id);
  if (logCount > 0) {
    alert(`사용 이력이 ${logCount}건 있어 삭제할 수 없습니다.`);
    return;
  }

  const confirmed = await showConfirmModal({
    title: '동결제품 삭제',
    message: `${product.name} 제품을 삭제하시겠습니까?\n입고 이력이 없는 제품만 완전히 삭제됩니다.`,
    confirmText: '삭제',
    danger: true,
  });
  if (!confirmed) return;

  await deleteDoc(doc(db, 'frozenProducts', product.id));
  await recordActivity({
    action: 'frozenProduct',
    subAction: 'delete',
    date: getToday(),
    staff: getRoleStaffLabel(),
    message: `동결제품 삭제 — ${product.name}`,
    details: {
      productId: product.id,
      productName: product.name,
      bagTypeId: product.bagTypeId || null,
    },
  });

  frozenProducts = frozenProducts.filter(p => p.id !== product.id);
  if (selectedProductId === product.id) selectedProductId = null;
  renderFrozenProductLayout();
  alert('삭제 완료!');
}

async function showProductDetail(product) {
  const detail = document.getElementById('productDetail');
  const logs = await loadFrozenLogs(product.id);
  const canManageFrozenProduct = currentUserRole === 'admin' || currentUserRole === 'office';

  detail.innerHTML = `
    <div class="detail-header">
      <span class="detail-title">${product.name}</span>
      <div class="detail-actions">
        ${canManageFrozenProduct ? '<button class="btn-secondary" id="btnEditProduct">수정</button>' : ''}
        ${canManageFrozenProduct ? '<button class="btn-secondary" id="btnDeleteProduct">삭제</button>' : ''}
        <button class="btn-primary" id="btnAddIncoming">+ \uC785\uACE0 \uB4F1\uB85D</button>
      </div>
    </div>
    <div class="detail-body">
      <!-- 입고 이력 -->
      <div class="form-section">
        <div class="section-header">
          <span class="section-title">입고 이력</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>유통기한</th>
                <th>수량(개)</th>
                <th>차감봉투(장)</th>
                <th>담당자</th>
                <th>비고</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${logs.length === 0 ? `<tr><td colspan="7" style="text-align:center;color:#aaa;padding:20px;">이력 없음</td></tr>` :
                logs.map(l => `
                  <tr>
                    <td>${l.date || '-'}</td>
                    <td>${l.expiryDate || '-'}</td>
                    <td>${l.qty}</td>
                    <td>${l.deductedBagQty || '-'}</td>
                    <td>${l.staffName || '-'}</td>
                    <td>${l.note || '-'}</td>
                    <td>
                      ${canManageFrozenProduct ? `
                        <button class="btn-edit-row" data-logid="${l.id}" style="margin-right:4px;">수정</button>
                        <button class="btn-del-row" data-logid="${l.id}" data-qty="${l.qty}" data-bagqty="${l.deductedBagQty || 0}" data-bagid="${product.bagTypeId || ''}">삭제</button>
                      ` : ''}
                    </td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btnAddIncoming')?.addEventListener('click', () => showIncomingModal(product));
  document.getElementById('btnEditProduct')?.addEventListener('click', () => showEditProductModal(product));
  document.getElementById('btnDeleteProduct')?.addEventListener('click', () => deleteFrozenProductIfNoLogs(product));

  document.querySelectorAll('.btn-edit-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const logId = btn.dataset.logid;
      const logSnap = await getDoc(doc(db, 'frozenLogs', logId));
      if (!logSnap.exists()) {
        alert('입고 로그를 찾을 수 없습니다.');
        return;
      }
      const log = { id: logId, ...logSnap.data() };
      showEditIncomingModal(product, log);
    });
  });

  document.querySelectorAll('.btn-del-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      // [권한 매트릭스 C4] production은 동결제품 입고 삭제 불가
      if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
        alert('동결제품 입고 삭제는 대표/사무실 계정만 가능합니다.');
        return;
      }

      const __c = await showConfirmModal({ title:'동결제품 입고 삭제', message:'삭제하시겠습니까?\n차감된 봉투 재고가 복원됩니다.', confirmText:'삭제', danger:true }); if (!__c) return;
      const logId = btn.dataset.logid;

      const frozenLogSnap = await getDoc(doc(db, 'frozenLogs', logId));
      if (!frozenLogSnap.exists()) {
        alert('입고 로그를 찾을 수 없습니다.');
        return;
      }
      const frozenLog = frozenLogSnap.data();

      if (await blockIfClosed(frozenLog.date)) return;

      if (frozenLog.ledgerId) {
        // ledger 기반 롤백
        const ledgerSnap = await getDoc(doc(db, 'stockLedger', frozenLog.ledgerId));
        if (ledgerSnap.exists() && ledgerSnap.data().status === 'active') {
          const items = ledgerSnap.data().items || [];
          for (const item of items) {
            const docSnap = await getDoc(doc(db, item.collection, item.docId));
            if (!docSnap.exists()) continue;
            const currentVal = docSnap.data()[item.field] || 0;

            if (currentVal !== item.after) {
              const __c = await showConfirmModal({
                title: '재고 변동 감지',
                message: `동결제품 입고 이후 ${item.label} 재고가 변경된 이력이 있습니다.\n입고 당시 차감분만 복원됩니다.\n\n강제 복원하시겠습니까?`,
                confirmText: '강제 복원',
                danger: true,
              });
              if (!__c) continue;
            }

            const restoredVal = currentVal - item.delta;
            await updateDoc(doc(db, item.collection, item.docId), {
              [item.field]: restoredVal,
              updatedAt: new Date(),
            });

            // bagLogs 복원 로그
            if (item.collection === 'bagTypes') {
              await addDoc(collection(db, 'bagLogs'), {
                date: getToday(),
                timestamp: new Date(),
                bagTypeId: item.docId,
                bagNameSnapshot: docSnap.data().name || '',
                type: 'autoDeductReverse',
                qty: -item.delta,
                before: currentVal,
                after: restoredVal,
                staffName: frozenLog.staffName || '',
                note: `동결제품 입고 삭제 복원 - ${frozenLog.productNameSnapshot || ''}`,
              });
            }
          }
          await updateDoc(doc(db, 'stockLedger', frozenLog.ledgerId), {
            status: 'rolledBack',
            rolledBackAt: new Date(),
          });
        }
      } else if (frozenLog.bagTypeId && (frozenLog.deductedBagQty || 0) > 0) {
        // fallback: ledger 없는 기존 데이터 단순 복원
        const bagSnap = await getDoc(doc(db, 'bagTypes', frozenLog.bagTypeId));
        if (bagSnap.exists()) {
          const current = bagSnap.data().currentQty || 0;
          await updateDoc(doc(db, 'bagTypes', frozenLog.bagTypeId), {
            currentQty: current + frozenLog.deductedBagQty,
            updatedAt: new Date(),
          });
        }
      }

      await updateDoc(doc(db, 'frozenLogs', logId), { status: 'deleted' });

      // 샘플세트 입고 삭제 시 구성품 자동차감 로그도 함께 삭제 (재고 복원)
      const compLogIds = frozenLog.componentDeductLogIds || [];
      for (const cid of compLogIds) {
        await updateDoc(doc(db, 'frozenLogs', cid), { status: 'deleted' });
      }

      await showProductDetail(product);
      alert('삭제 완료!');
    });
  });
}

function showNewProductModal() {
  showProductModal(null);
}

function showEditProductModal(product) {
  showProductModal(product);
}

function normalizeComponents(components) {
  if (!Array.isArray(components)) return [];
  return components
    .map(c => ({
      frozenProductId: c?.frozenProductId || '',
      qty: Number(c?.qty) || 0,
    }))
    .filter(c => c.frozenProductId && c.qty > 0);
}

function getSampleProductsForComponents(currentProductId) {
  return frozenProducts.filter(p => getFrozenProductKind(p) === 'sample' && p.id !== currentProductId);
}

function renderComponentOptions(selectedId = '', currentProductId = null) {
  const samples = getSampleProductsForComponents(currentProductId);
  return [
    '<option value="">샘플 선택</option>',
    ...samples.map(p => `<option value="${p.id}" ${selectedId === p.id ? 'selected' : ''}>${p.name}</option>`),
  ].join('');
}

function renderComponentRow(component = {}, currentProductId = null) {
  const qty = Number(component.qty) > 0 ? Number(component.qty) : 1;
  return `
    <div class="sample-set-component-row" style="display:grid;grid-template-columns:1fr 80px auto;gap:8px;align-items:center;margin-bottom:6px;">
      <select class="component-product-id">
        ${renderComponentOptions(component.frozenProductId || '', currentProductId)}
      </select>
      <input type="number" class="component-qty" min="1" step="1" value="${qty}" />
      <button type="button" class="btn-secondary btn-remove-component">삭제</button>
    </div>
  `;
}

function escapeAttribute(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function enqueueFrozenProductReceiptTransfer({ product, frozenLogId, date, expiry, qty, staff }) {
  const kind = getFrozenProductKind(product);
  if (kind !== 'product' && kind !== 'sample') return;

  const revision = 1;
  const idempotencyKey = `frozenLogs:${frozenLogId}:${revision}`;
  try {
    await setDoc(doc(db, 'productTransferRequests', idempotencyKey), {
      idempotencyKey,
      sourceApp: 'production',
      sourceCollection: 'frozenLogs',
      sourceId: frozenLogId,
      eventType: 'productReceipt',
      category: 'freezeDry',
      revision,
      supersedesRevision: null,
      status: 'pending',
      frozenProductId: product.id,
      productName: product.name,
      recipeName: product.recipeTitleRef || product.name,
      unitType: kind === 'sample' ? 'sample' : 'main',
      quantity: qty,
      expiryDate: expiry,
      producedDate: date,
      staff,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('동결제품 입고 productTransferRequests 전송 실패', error);
  }
}

async function showProductModal(product) {
  const isNew = !product;

  // 봉투 목록 로드
  const bagSnap = await getDocs(query(collection(db, 'bagTypes'), orderBy('sortOrder')));
  const bags = bagSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.category === 'freezeDry' && (b.active !== false || (!isNew && b.id === product?.bagTypeId)));
  const recipes = await getActiveFreezeDryRecipes();
  const target = getFrozenProductTarget(product);
  const kind = getFrozenProductKind(product);
  const components = normalizeComponents(product?.components);
  const renderNameInput = (inputKind, value = '') => {
    if (inputKind === 'sampleSet') {
      return `<input type="text" id="m_name" value="${escapeAttribute(value)}" placeholder="샘플세트 이름 입력" />`;
    }
    return `
      <select id="m_name">
        ${getRecipeOptionsHtml(recipes, value)}
      </select>
    `;
  };

  showModal(`
    <h3 class="modal-title">${isNew ? '동결제품 추가' : '동결제품 수정'}</h3>
    <div class="form-group">
      <label>제품명 *</label>
      <div id="m_name_wrap">
        ${renderNameInput(kind, product?.name || '')}
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>종 *</label>
        <select id="m_target">
          <option value="cat" ${target === 'cat' ? 'selected' : ''}>고양이</option>
          <option value="dog" ${target === 'dog' ? 'selected' : ''}>강아지</option>
          <option value="common" ${target === 'common' ? 'selected' : ''}>공용</option>
        </select>
      </div>
      <div class="form-group">
        <label>종류 *</label>
        <select id="m_kind">
          <option value="product" ${kind === 'product' ? 'selected' : ''}>본품</option>
          <option value="sample" ${kind === 'sample' ? 'selected' : ''}>샘플</option>
          <option value="sampleSet" ${kind === 'sampleSet' ? 'selected' : ''}>샘플세트</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>연결 봉투 *</label>
      <select id="m_bagType">
        <option value="">선택</option>
        ${bags.map(b => `<option value="${b.id}" ${product?.bagTypeId === b.id ? 'selected' : ''}>${b.name}${b.active === false ? ' (\uBE44\uD65C\uC131)' : ''}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>분리작업 필요</label>
      <select id="m_separation">
        <option value="false" ${!product?.requiresSeparation ? 'selected' : ''}>아니오</option>
        <option value="true" ${product?.requiresSeparation ? 'selected' : ''}>예</option>
      </select>
    </div>
    <div class="form-group" id="m_components_section" style="${kind === 'sampleSet' ? '' : 'display:none;'}">
      <label>샘플세트 구성</label>
      <div id="m_components_rows">
        ${(components.length > 0 ? components : [{}]).map(c => renderComponentRow(c, product?.id || null)).join('')}
      </div>
      <button type="button" class="btn-secondary" id="btnAddComponentRow">+ 구성 샘플 추가</button>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveProduct">${isNew ? '추가' : '저장'}</button>
    </div>
  `);

  const updateComponentsVisibility = () => {
    const isSampleSet = document.getElementById('m_kind').value === 'sampleSet';
    document.getElementById('m_components_section').style.display = isSampleSet ? '' : 'none';
  };
  const updateNameInput = () => {
    const currentValue = document.getElementById('m_name')?.value || '';
    const nextKind = document.getElementById('m_kind').value;
    document.getElementById('m_name_wrap').innerHTML = renderNameInput(nextKind, currentValue);
  };
  document.getElementById('m_kind')?.addEventListener('change', () => {
    updateComponentsVisibility();
    updateNameInput();
  });
  document.getElementById('btnAddComponentRow')?.addEventListener('click', () => {
    document.getElementById('m_components_rows').insertAdjacentHTML('beforeend', renderComponentRow({}, product?.id || null));
  });
  document.getElementById('m_components_rows')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-remove-component');
    if (!btn) return;
    const row = btn.closest('.sample-set-component-row');
    const rows = document.querySelectorAll('.sample-set-component-row');
    if (rows.length <= 1) {
      row.querySelector('.component-product-id').value = '';
      row.querySelector('.component-qty').value = '1';
      return;
    }
    row.remove();
  });

  document.getElementById('btnSaveProduct').addEventListener('click', async () => {
    if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
      alert('동결제품 등록/수정은 대표/사무실 계정만 가능합니다.');
      return;
    }
    const name = document.getElementById('m_name').value.trim();
    const recipeRef = name;
    const target = document.getElementById('m_target').value;
    const kind = document.getElementById('m_kind').value;
    const bagTypeId = document.getElementById('m_bagType').value;
    const requiresSeparation = document.getElementById('m_separation').value === 'true';
    const nextActive = isNew ? true : product.active !== false;

    if (!name || !bagTypeId) { alert('제품명과 연결 봉투는 필수입니다.'); return; }
    const nextComponents = kind === 'sampleSet'
      ? Array.from(document.querySelectorAll('.sample-set-component-row')).map(row => ({
          frozenProductId: row.querySelector('.component-product-id').value,
          qty: Number(row.querySelector('.component-qty').value) || 0,
        })).filter(c => c.frozenProductId && c.qty > 0)
      : [];

    if (kind === 'sampleSet' && nextComponents.length === 0) {
      alert('샘플세트 구성 샘플을 1개 이상 입력해주세요.');
      return;
    }

    const data = {
      name,
      recipeTitleRef: recipeRef,
      target,
      kind,
      components: nextComponents,
      bagTypeId,
      requiresSeparation,
      active: nextActive,
      sortOrder: isNew ? frozenProducts.length : product.sortOrder,
      updatedAt: new Date(),
    };

    if (isNew) {
      data.createdAt = new Date();
      await addDoc(collection(db, 'frozenProducts'), data);
    } else {
      await updateDoc(doc(db, 'frozenProducts', product.id), data);
    }

    frozenProducts = await loadFrozenProducts();
    closeModal();
    renderFrozenProductLayout();
    alert(isNew ? '추가 완료!' : '수정 완료!');
  });
}
function showEditIncomingModal(product, log) {
  showModal(`
    <h3 class="modal-title">입고 수정 — ${product.name}</h3>
    <div class="form-row">
      <div class="form-group">
        <label>날짜 (수정 불가)</label>
        <input type="date" id="m_date" value="${log.date || ''}" disabled />
      </div>
      <div class="form-group">
        <label>유통기한</label>
        <input type="date" id="m_expiry" value="${log.expiryDate || ''}" />
      </div>
    </div>
    <div class="form-group">
      <label>수량(개) *</label>
      <input type="number" id="m_qty" value="${log.qty || 0}" />
    </div>
    <div class="form-group">
      <label>담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'lead', 'office']).replace(`value="${log.staffName}"`, `value="${log.staffName}" selected`)}
      </select>
    </div>
    <div class="form-group">
      <label>비고</label>
      <input type="text" id="m_note" value="${log.note || ''}" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveEditIncoming">저장</button>
    </div>
  `);

  document.getElementById('btnSaveEditIncoming').addEventListener('click', async () => {
    const expiry = document.getElementById('m_expiry').value;
    const newQty = parseInt(document.getElementById('m_qty').value);
    const staff = document.getElementById('m_staff').value;
    const note = document.getElementById('m_note').value;

    if (!newQty || newQty <= 0) { alert('수량은 1개 이상이어야 합니다.'); return; }
    if (await blockIfClosed(log.date)) return;

    // [권한 매트릭스 C4] production은 동결제품 입고 수정 불가
    if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
      alert('동결제품 입고 수정은 대표/사무실 계정만 가능합니다.');
      return;
    }

    const oldQty = log.qty || 0;
    const oldDeducted = log.deductedBagQty || 0;

    // 1단계: 기존 ledger 롤백 (봉투 재고 복원)
    if (log.ledgerId) {
      const ledgerSnap = await getDoc(doc(db, 'stockLedger', log.ledgerId));
      if (ledgerSnap.exists() && ledgerSnap.data().status === 'active') {
        const items = ledgerSnap.data().items || [];
        for (const item of items) {
          const docSnap = await getDoc(doc(db, item.collection, item.docId));
          if (!docSnap.exists()) continue;
          const currentVal = docSnap.data()[item.field] || 0;

          if (currentVal !== item.after) {
            const __c = await showConfirmModal({
              title: '재고 변동 감지',
              message: `동결제품 입고 이후 ${item.label} 재고가 변경된 이력이 있습니다.\n입고 당시 차감분만 복원됩니다.\n\n강제 복원하시겠습니까?`,
              confirmText: '강제 복원',
              danger: true,
            });
            if (!__c) {
              return;
            }
          }

          const restoredVal = currentVal - item.delta;
          await updateDoc(doc(db, item.collection, item.docId), {
            [item.field]: restoredVal,
            updatedAt: new Date(),
          });

          if (item.collection === 'bagTypes') {
            await addDoc(collection(db, 'bagLogs'), {
              date: getToday(),
              timestamp: new Date(),
              bagTypeId: item.docId,
              bagNameSnapshot: docSnap.data().name || '',
              type: 'autoDeductReverse',
              qty: -item.delta,
              before: currentVal,
              after: restoredVal,
              staffName: staff,
              note: `동결제품 입고 수정(롤백) - ${product.name}`,
            });
          }
        }
        await updateDoc(doc(db, 'stockLedger', log.ledgerId), {
          status: 'rolledBack',
          rolledBackAt: new Date(),
        });
      }
    } else if (log.bagTypeId && oldDeducted > 0) {
      // fallback: ledger 없는 기존 데이터
      const bagSnap = await getDoc(doc(db, 'bagTypes', log.bagTypeId));
      if (bagSnap.exists()) {
        const current = bagSnap.data().currentQty || 0;
        await updateDoc(doc(db, 'bagTypes', log.bagTypeId), {
          currentQty: current + oldDeducted,
          updatedAt: new Date(),
        });
      }
    }

    // 2단계: 새 수량으로 재차감 + 새 ledger 생성
    let newDeducted = 0;
    const ledgerItems = [];

    if (product.bagTypeId) {
      const bagSnap = await getDoc(doc(db, 'bagTypes', product.bagTypeId));
      if (bagSnap.exists()) {
        const bagData = bagSnap.data();
        const currentBag = bagData.currentQty || 0;
        if (currentBag < newQty) {
          alert(`봉투 재고가 부족합니다.\n현재 봉투 재고: ${currentBag}장\n필요 수량: ${newQty}장\n\n수정이 중단되었습니다. 봉투 재고는 이전 상태로 이미 복원되었습니다.`);
          closeModal();
          await showProductDetail(product);
          return;
        }
        const newBagQty = currentBag - newQty;
        const stockUpdatedAt = new Date();
        await updateDoc(doc(db, 'bagTypes', product.bagTypeId), {
          currentQty: newBagQty,
          updatedAt: stockUpdatedAt,
        });
        newDeducted = newQty;

        const bagLogRef = await addDoc(collection(db, 'bagLogs'), {
          date: log.date,
          timestamp: new Date(),
          bagTypeId: product.bagTypeId,
          bagNameSnapshot: bagData.name,
          type: 'autoDeduct',
          qty: -newQty,
          before: currentBag,
          after: newBagQty,
          staffName: staff,
          note: `동결제품 입고 수정(재차감) - ${product.name}`,
        });

        ledgerItems.push({
          collection: 'bagTypes',
          docId: product.bagTypeId,
          field: 'currentQty',
          delta: -newQty,
          before: currentBag,
          after: newBagQty,
          label: `${bagData.name} 봉투`,
          stockUpdatedAtSnapshot: stockUpdatedAt,
          bagLogId: bagLogRef.id,
        });
      }
    }

    // 3단계: frozenLogs 업데이트
    let newLedgerId = null;
    if (ledgerItems.length > 0) {
      const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
        actionType: 'frozenProductIncoming',
        actionId: log.id,
        timestamp: new Date(),
        date: log.date,
        status: 'active',
        items: ledgerItems,
      });
      newLedgerId = ledgerRef.id;
    }

    await updateDoc(doc(db, 'frozenLogs', log.id), {
      qty: newQty,
      expiryDate: expiry,
      staffName: staff,
      note,
      deductedBagQty: newDeducted,
      ledgerId: newLedgerId,
      updatedAt: new Date(),
    });

    closeModal();
    await showProductDetail(product);
    alert('수정 완료!');
  });
}

// 제품별 현재 재고 (frozenLogs 합산, deleted 제외)
async function getFrozenStockByProduct() {
  const snap = await getDocs(collection(db, 'frozenLogs'));
  const map = {};
  snap.docs.forEach(d => {
    const l = d.data();
    if (l.status === 'deleted') return;
    if (!l.productId) return;
    map[l.productId] = (map[l.productId] || 0) + Number(l.qty || 0);
  });
  return map;
}

async function showIncomingModal(product) {
  const today = getToday();
  const futureStr = addMonthsKST(18);

  // 샘플세트: 구성품 자동차감 준비
  const isSampleSet = getFrozenProductKind(product) === 'sampleSet';
  const components = isSampleSet ? normalizeComponents(product.components) : [];
  const stockMap = components.length > 0 ? await getFrozenStockByProduct() : {};
  const getComponentName = (id) => frozenProducts.find(p => p.id === id)?.name || '(삭제된 제품)';

  showModal(`
    <h3 class="modal-title">입고 등록 — ${product.name}</h3>
    <div class="form-group">
      <label>날짜 *</label>
      <input type="date" id="m_date" value="${today}" max="${today}" />
    </div>
    <div class="form-group">
      <label>유통기한 *</label>
      <input type="date" id="m_expiry" value="${futureStr}" />
    </div>
    <div class="form-group">
      <label>봉지수 *</label>
      <input type="number" id="m_qty" placeholder="봉지수 입력" />
    </div>
    ${components.length > 0 ? `
      <div class="form-group" id="m_compPreview" style="background:#f7f7f7;border-radius:6px;padding:10px 12px;font-size:12.5px;color:#555;">
        세트 수량을 입력하면 구성품 차감 내역이 표시됩니다.
      </div>
    ` : ''}
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['senior', 'lead', 'office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveIncoming">입고</button>
    </div>
  `);

  // 구성품 차감 미리보기
  if (components.length > 0) {
    document.getElementById('m_qty').addEventListener('input', (e) => {
      const setQty = parseInt(e.target.value) || 0;
      const el = document.getElementById('m_compPreview');
      if (!el) return;
      if (setQty <= 0) {
        el.innerHTML = '세트 수량을 입력하면 구성품 차감 내역이 표시됩니다.';
        el.style.color = '#555';
        return;
      }
      el.innerHTML = components.map(c => {
        const need = setQty * c.qty;
        const cur = stockMap[c.frozenProductId] || 0;
        const after = cur - need;
        const short = after < 0;
        return `<div style="margin-bottom:2px;${short ? 'color:#e53e3e;font-weight:600;' : ''}">
          ${getComponentName(c.frozenProductId)} -${need}개 (현재 ${cur} → ${after})${short ? ' ⚠️ 재고 부족' : ''}
        </div>`;
      }).join('');
    });
  }

  document.getElementById('btnSaveIncoming').addEventListener('click', async () => {
    const date = document.getElementById('m_date').value;
    const expiry = document.getElementById('m_expiry').value;
    const qty = parseInt(document.getElementById('m_qty').value);
    const staff = document.getElementById('m_staff').value;
    const note = '';

    if (!date) { alert('날짜를 입력해주세요.'); return; }
    if (date > today) { alert('미래 날짜는 입력할 수 없습니다.'); return; }
    if (!expiry) { alert('유통기한을 입력해주세요.'); return; }
    if (expiry < date) { alert('유통기한이 입고일보다 빠릅니다.'); return; }
    if (!qty || qty <= 0) { alert('봉지수를 입력해주세요.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }
    if (await blockIfClosed(date)) return;

    // 구성품 재고 부족 확인 (막지는 않음 — 실물은 이미 제작됐을 수 있음)
    if (components.length > 0) {
      const shortItems = components
        .map(c => ({ name: getComponentName(c.frozenProductId), need: qty * c.qty, cur: stockMap[c.frozenProductId] || 0 }))
        .filter(x => x.cur < x.need);
      if (shortItems.length > 0) {
        const ok = await showConfirmModal({
          title: '구성품 재고 부족',
          message: `다음 구성품 재고가 부족합니다:\n\n${shortItems.map(x => `${x.name}: 현재 ${x.cur}개 / 필요 ${x.need}개`).join('\n')}\n\n그래도 진행하면 재고가 음수로 기록됩니다.\n계속하시겠습니까?`,
          confirmText: '진행',
          danger: true,
        });
        if (!ok) return;
      }
    }

    // 봉투 차감 + ledger items 누적
    let deductedBagQty = 0;
    const ledgerItems = [];

    if (product.bagTypeId) {
      const bagSnap = await getDoc(doc(db, 'bagTypes', product.bagTypeId));
      if (bagSnap.exists()) {
        const bagData = bagSnap.data();
        const currentBag = bagData.currentQty || 0;
        if (currentBag < qty) {
          alert(`봉투 재고가 부족합니다.\n현재 봉투 재고: ${currentBag}장\n필요 수량: ${qty}장`);
          return;
        }
        const newQty = currentBag - qty;
        const stockUpdatedAt = new Date();
        await updateDoc(doc(db, 'bagTypes', product.bagTypeId), {
          currentQty: newQty,
          updatedAt: stockUpdatedAt,
        });
        deductedBagQty = qty;

        // bagLogs autoDeduct 기록
        const bagLogRef = await addDoc(collection(db, 'bagLogs'), {
          date,
          timestamp: new Date(),
          bagTypeId: product.bagTypeId,
          bagNameSnapshot: bagData.name,
          type: 'autoDeduct',
          qty: -qty,
          before: currentBag,
          after: newQty,
          staffName: staff,
          note: `동결제품 입고 자동차감 - ${product.name}`,
        });

        ledgerItems.push({
          collection: 'bagTypes',
          docId: product.bagTypeId,
          field: 'currentQty',
          delta: -qty,
          before: currentBag,
          after: newQty,
          label: `${bagData.name} 봉투`,
          stockUpdatedAtSnapshot: stockUpdatedAt,
          bagLogId: bagLogRef.id,
        });
      }
    }

    // frozenLogs 저장 (ledgerId는 아래에서 업데이트)
    const frozenLogRef = await addDoc(collection(db, 'frozenLogs'), {
      date,
      timestamp: new Date(),
      productId: product.id,
      productNameSnapshot: product.name,
      componentsSnapshot: getFrozenProductKind(product) === 'sampleSet' ? normalizeComponents(product.components) : null,
      expiryDate: expiry,
      qty,
      bagTypeId: product.bagTypeId || null,
      deductedBagQty,
      staffName: staff,
      note,
      status: 'active',
      ledgerId: null,
    });

    // 샘플세트: 구성품 낱개 재고 자동차감 (마이너스 frozenLog)
    const componentDeductLogIds = [];
    for (const c of components) {
      const need = qty * c.qty;
      const compRef = await addDoc(collection(db, 'frozenLogs'), {
        date,
        timestamp: new Date(),
        productId: c.frozenProductId,
        productNameSnapshot: getComponentName(c.frozenProductId),
        componentsSnapshot: null,
        expiryDate: null,
        qty: -need,
        bagTypeId: null,
        deductedBagQty: 0,
        staffName: staff,
        note: `샘플세트 제작 자동차감 - ${product.name} ${qty}세트`,
        status: 'active',
        ledgerId: null,
        sampleSetLogId: frozenLogRef.id,
      });
      componentDeductLogIds.push(compRef.id);
    }
    if (componentDeductLogIds.length > 0) {
      await updateDoc(doc(db, 'frozenLogs', frozenLogRef.id), { componentDeductLogIds });
    }

    await enqueueFrozenProductReceiptTransfer({
      product,
      frozenLogId: frozenLogRef.id,
      date,
      expiry,
      qty,
      staff,
    });

    // ledger 저장 (items 있을 때만)
    if (ledgerItems.length > 0) {
      const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
        actionType: 'frozenProductIncoming',
        actionId: frozenLogRef.id,
        timestamp: new Date(),
        date,
        status: 'active',
        items: ledgerItems,
      });
      await updateDoc(doc(db, 'frozenLogs', frozenLogRef.id), { ledgerId: ledgerRef.id });
    }

    // [묶음 5A] 사무 로그 발행 — 동결제품 입고 (운영자가 메인 화면에서 변동 추적 가능하게)
    await recordActivity({
      action: 'frozenProduct',
      subAction: 'incoming',
      date,
      staff,
      message: `동결제품 입고 — ${product.name} +${qty}봉 / 담당: ${staff}`,
      details: {
        frozenLogId: frozenLogRef.id,
        productId: product.id,
        productName: product.name,
        componentsSnapshot: getFrozenProductKind(product) === 'sampleSet' ? normalizeComponents(product.components) : null,
        qty,
        expiryDate: expiry || null,
        deductedBagQty,
        bagTypeId: product.bagTypeId || null,
        note: note || null,
      },
    });

    closeModal();
    await showProductDetail(product);
    alert('입고 등록 완료!');
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

function getRoleStaffLabel() {
  if (currentUserRole === 'admin') return '\uB300\uD45C';
  if (currentUserRole === 'office') return '\uC0AC\uBB34\uC2E4';
  if (currentUserRole === 'production') return '\uC0DD\uC0B0\uC2E4';
  return '\uC2DC\uC2A4\uD15C';
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
