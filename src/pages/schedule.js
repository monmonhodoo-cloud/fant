import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, query, orderBy, getDoc
} from 'firebase/firestore';
import { getTodayKST as getToday } from '../utils/date.js';
import { blockIfClosed } from '../utils/closingGuard.js';
import { recordMeatLog } from '../services/meatLogs.js';
import { recordActivity } from '../services/activityLogs.js';
import { currentUserRole } from '../app.js';
import { showConfirmModal } from '../utils/modal.js';

export async function renderSchedule() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>입고 예정관리 로딩 중...</p></div>`;
  await loadStaffCache();
  const schedules = await loadSchedules();
  renderScheduleLayout(schedules);
}

async function loadSchedules() {
  const q = query(collection(db, 'schedules'), orderBy('date', 'asc'));
  const snap = await getDocs(q);
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // [묶음 5E] 같은 날짜 안에서 최근 등록이 위로 (createdAt desc, 클라이언트 정렬)
  list.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const ac = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bc = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bc - ac;
  });
  return list;
}

async function loadMeatTypes() {
  const snap = await getDocs(collection(db, 'meatTypes'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadBagTypes() {
  const snap = await getDocs(collection(db, 'bagTypes'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderScheduleLayout(schedules) {
  const content = document.getElementById('mainContent');
  const today = getToday();
  const canManageSchedule = isScheduleStaffRole();

  const active = schedules.filter(s => s.status === 'scheduled');
  const done = schedules.filter(s => s.status !== 'scheduled');

  let showDone = false;

  content.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <h2 class="page-title">입고 예정관리</h2>
        ${canManageSchedule ? '<button class="btn-primary" id="btnAddSchedule">+ 입고 예정 등록</button>' : ''}
      </div>

      <!-- 활성 목록 -->
      <div class="table-wrap" style="background:white;border-radius:8px;border:1px solid #e8e8e8;overflow:hidden;margin-bottom:16px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>예정일</th>
              <th>구분</th>
              <th>품목명</th>
              <th>발주수량</th>
              <th>발주담당자</th>
              <th>입고메모</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${active.length === 0 ?
              `<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px;">입고 예정 없음</td></tr>` :
              active.map(s => renderScheduleRow(s, today, canManageSchedule)).join('')}
          </tbody>
        </table>
      </div>

      <!-- 완료/취소 토글 -->
      <div style="margin-bottom:12px;">
        <button class="btn-secondary" id="btnToggleDone">완료/취소 항목 보기</button>
      </div>
      <div id="doneSection" style="display:none;">
        <div class="table-wrap" style="background:white;border-radius:8px;border:1px solid #e8e8e8;overflow:hidden;">
          <table class="data-table">
            <thead>
              <tr>
                <th>예정일</th>
                <th>구분</th>
                <th>품목명</th>
                <th>발주수량</th>
                <th>실제수량</th>
                <th>입고담당자</th>
                <th>상태</th>
                <th>완료메모</th>
              </tr>
            </thead>
            <tbody>
              ${done.length === 0 ?
                `<tr><td colspan="8" style="text-align:center;color:#aaa;padding:20px;">없음</td></tr>` :
                done.map(s => renderDoneRow(s)).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btnAddSchedule')?.addEventListener('click', () => showScheduleModal());
  document.getElementById('btnToggleDone').addEventListener('click', () => {
    const section = document.getElementById('doneSection');
    showDone = !showDone;
    section.style.display = showDone ? '' : 'none';
    document.getElementById('btnToggleDone').textContent = showDone ? '완료/취소 항목 숨기기' : '완료/취소 항목 보기';
  });

  document.querySelectorAll('.btn-complete').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const id = btn.dataset.id;
        const s = schedules.find(sc => sc.id === id);
        if (!s) { alert('일정을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.'); return; }
        showCompleteModal(s);
      } catch (err) {
        console.error('완료 버튼 오류:', err);
        alert('오류가 발생했습니다: ' + err.message);
      }
    });
  });

  document.querySelectorAll('.btn-edit-schedule').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isScheduleStaffRole()) {
        alert('입고 예정 수정 권한이 없습니다.');
        return;
      }
      const id = btn.dataset.id;
      const s = schedules.find(sc => sc.id === id);
      if (!s) {
        alert('입고 예정을 찾을 수 없습니다.');
        return;
      }
      if (await blockIfClosed(s.date)) return;
      showScheduleModal(s);
    });
  });

  document.querySelectorAll('.btn-cancel-schedule').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isScheduleStaffRole()) {
        alert('입고 예정 취소 권한이 없습니다.');
        return;
      }
      const id = btn.dataset.id;
      const s = schedules.find(sc => sc.id === id);
      if (!s) {
        alert('입고 예정을 찾을 수 없습니다.');
        return;
      }

      // 마감 가드 — 예정일이 마감된 날짜면 취소 차단
      if (await blockIfClosed(s.date)) return;

      showCancelScheduleModal(s);
    });
  });
}

function isScheduleStaffRole() {
  return currentUserRole === 'admin' || currentUserRole === 'office' || currentUserRole === 'production';
}

function renderScheduleRow(s, today, canManageSchedule = false) {
  const isOverdue = s.date < today;
  return `
    <tr style="background:${isOverdue ? '#fffdf0' : 'white'}">
      <td style="color:${isOverdue ? '#e67e22' : '#1a1a1a'}">${s.date} ${isOverdue ? '⚠️' : ''}</td>
      <td><span class="tag tag-raw">${getTypeLabel(s.type)}</span></td>
      <td>${s.itemNameSnapshot}</td>
      <td>${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)}</td>
      <td>${s.orderStaffName || '-'}</td>
      <td>${s.orderMemo || '-'}</td>
      <td><span style="color:#e67e22;font-size:12px">⏳ 예정</span></td>
      <td style="white-space:nowrap">
        ${canManageSchedule ? `<button class="btn-secondary btn-edit-schedule" data-id="${s.id}" style="font-size:11px;padding:3px 10px;margin-right:4px;">수정</button>` : ''}
        <button class="btn-primary btn-complete" data-id="${s.id}" style="font-size:11px;padding:3px 10px;margin-right:4px;">완료</button>
        ${canManageSchedule ? `<button class="btn-secondary btn-cancel-schedule" data-id="${s.id}" style="font-size:11px;padding:3px 10px;">취소</button>` : ''}
      </td>
    </tr>
  `;
}

function renderDoneRow(s) {
  const isComplete = s.status === 'completed';
  return `
    <tr style="opacity:0.8">
      <td>${s.date}</td>
      <td><span class="tag tag-raw">${getTypeLabel(s.type)}</span></td>
      <td>${s.itemNameSnapshot}</td>
      <td>${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)}</td>
      <td>${s.actualQty ? formatScheduleQty(s.actualQty, s.actualUnit || s.orderedUnit, s.orderedUnitGrams) : '-'}</td>
      <td>${s.incomingStaffName || '-'}</td>
      <td>
        <span style="color:${isComplete ? '#2d7a3a' : '#e53e3e'};font-size:12px">
          ${isComplete ? '✅ 완료' : '❌ 취소'}
        </span>
      </td>
      <td>${s.completeMemo || s.cancelReason || '-'}</td>
    </tr>
  `;
}

function isCountIncomingUnit(unit) {
  return unit === '마리';
}

function formatGrams(value) {
  const g = Number(value || 0);
  if (g > 9999) return `${(g / 1000).toFixed(2)}kg`;
  return `${g.toLocaleString()}g`;
}

function formatScheduleQty(qty, unit, unitGrams) {
  if (unit === 'g') return formatGrams(qty);
  const base = `${qty}${unit}`;
  if (!isCountIncomingUnit(unit) || !unitGrams) return base;
  return `${base} (${formatGrams(Number(qty || 0) * Number(unitGrams || 0))})`;
}

function getTypeLabel(type) {
  return type === 'meat' ? '원육' : type === 'bag' ? '봉투' : '계란';
}

async function showScheduleModal(editingSchedule = null) {
  const isEdit = Boolean(editingSchedule);
  const meatTypes = await loadMeatTypes();
  const bagTypes = await loadBagTypes();

  showModal(`
    <h3 class="modal-title">입고 예정 ${isEdit ? '수정' : '등록'}</h3>
    <div class="form-group">
      <label>예정일 *</label>
      <input type="date" id="m_date" value="${editingSchedule?.date || getToday()}" />
    </div>
    <div class="form-group">
      <label>구분 *</label>
      <select id="m_type" onchange="updateScheduleItem()" ${isEdit ? 'disabled' : ''}>
        <option value="">선택</option>
        <option value="meat">원육</option>
        <option value="bag">봉투</option>
        <option value="egg">계란</option>
      </select>
    </div>
    <div class="form-group" id="itemSelectWrap" style="display:none;">
      <label>품목 *</label>
      <select id="m_item" ${isEdit ? 'disabled' : ''}>
        <option value="">선택</option>
      </select>
      ${isEdit ? '<p style="margin:6px 0 0;color:#888;font-size:11px;">구분/품목 변경은 기존 항목 취소 후 새로 등록해주세요.</p>' : ''}
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>발주수량 *</label>
        <input type="number" id="m_qty" placeholder="수량" value="${editingSchedule?.orderedQty ?? ''}" />
      </div>
      <div class="form-group">
        <label>단위</label>
        <!-- [묶음 5D] 구분 선택에 따라 옵션 자동 제한 (updateScheduleItem에서 갱신) -->
        <select id="m_unit">
          <option value="">구분을 먼저 선택</option>
        </select>
      </div>
    </div>
    <div class="form-group" id="unitGramsWrap" style="display:none;">
      <label>1마리당 g *</label>
      <input type="number" id="m_unit_grams" placeholder="예: 1500" min="0" step="1" value="${editingSchedule?.orderedUnitGrams ?? ''}" />
    </div>
    <div class="form-group">
      <label>발주 담당자</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['office'])}
      </select>
    </div>
    <div class="form-group">
      <label>입고메모</label>
      <input type="text" id="m_memo" placeholder="메모" value="${escapeAttr(editingSchedule?.orderMemo || '')}" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveSchedule">${isEdit ? '수정' : '등록'}</button>
    </div>
  `);

  window.updateScheduleItem = () => {
    const type = document.getElementById('m_type').value;
    const wrap = document.getElementById('itemSelectWrap');
    const select = document.getElementById('m_item');
    const unitSelect = document.getElementById('m_unit');

    // [묶음 5D] 구분에 따라 단위 옵션 자동 제한
    // 원육 = g/kg (디폴트 kg), 봉투 = 장/박스 (디폴트 박스), 계란 = 개/판 (디폴트 개)
    const unitMap = {
      meat: { options: [['kg', 'kg'], ['g', 'g'], ['마리', '마리']], default: 'kg' },
      bag:  { options: [['박스', '박스'], ['장', '장']], default: '박스' },
      egg:  { options: [['개', '개'], ['판', '판']], default: '개' },
    };
    if (type && unitMap[type]) {
      const cfg = unitMap[type];
      unitSelect.innerHTML = cfg.options
        .map(([val, label]) => `<option value="${val}">${label}</option>`)
        .join('');
      unitSelect.value = cfg.default;
    } else {
      // 구분 미선택 시: 기본 비어있음
      unitSelect.innerHTML = '<option value="">구분을 먼저 선택</option>';
    }

    if (type === 'egg') {
      wrap.style.display = 'none';
      updateUnitGramsVisibility();
      return;
    }

    wrap.style.display = '';
    select.innerHTML = '<option value="">선택</option>';

    const allItems = type === 'meat' ? meatTypes : bagTypes;
    const items = allItems.filter(item => item.active !== false || (isEdit && editingSchedule?.itemId === item.id));
    items.forEach(item => {
      select.innerHTML += `<option value="${item.id}" data-name="${item.name}">${item.name}</option>`;
    });
    updateUnitGramsVisibility();
  };

  const updateUnitGramsVisibility = () => {
    const wrap = document.getElementById('unitGramsWrap');
    const gramsInput = document.getElementById('m_unit_grams');
    const show = document.getElementById('m_type')?.value === 'meat' && document.getElementById('m_unit')?.value === '마리';
    if (wrap) wrap.style.display = show ? '' : 'none';
    if (!show && gramsInput) gramsInput.value = '';
  };

  document.getElementById('m_unit')?.addEventListener('change', updateUnitGramsVisibility);

  if (isEdit) {
    document.getElementById('m_type').value = editingSchedule.type || '';
    window.updateScheduleItem();
    if (editingSchedule.type !== 'egg') {
      document.getElementById('m_item').value = editingSchedule.itemId || '';
    }
    document.getElementById('m_unit').value = editingSchedule.orderedUnit || '';
    document.getElementById('m_unit_grams').value = editingSchedule.orderedUnitGrams || '';
    updateUnitGramsVisibility();
    document.getElementById('m_staff').value = editingSchedule.orderStaffName || '';
  }

  document.getElementById('btnSaveSchedule').addEventListener('click', async () => {
    if (!isScheduleStaffRole()) {
      alert(`입고 예정 ${isEdit ? '수정' : '등록'} 권한이 없습니다.`);
      return;
    }
    let date = document.getElementById('m_date').value;
    const type = isEdit ? editingSchedule.type : document.getElementById('m_type').value;
    const qty = parseFloat(document.getElementById('m_qty').value);
    const unit = document.getElementById('m_unit').value;
    const orderedUnitGrams = isCountIncomingUnit(unit)
      ? parseFloat(document.getElementById('m_unit_grams')?.value)
      : null;
    const staff = document.getElementById('m_staff').value;
    const memo = document.getElementById('m_memo').value;

    if (!date || !type || !qty) { alert('날짜, 구분, 수량은 필수입니다.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }
    if (isCountIncomingUnit(unit) && (!orderedUnitGrams || orderedUnitGrams <= 0)) {
      alert('1마리당 g을 입력해주세요.');
      return;
    }
    if (isEdit) {
      if (await blockIfClosed(editingSchedule.date)) return;
      if (date !== editingSchedule.date && await blockIfClosed(date)) return;
    }

    let itemId = isEdit ? (editingSchedule.itemId || null) : null;
    let itemName = isEdit ? (editingSchedule.itemNameSnapshot || '계란') : '계란';

    if (!isEdit && type !== 'egg') {
      const itemSelect = document.getElementById('m_item');
      itemId = itemSelect.value;
      const opt = itemSelect.options[itemSelect.selectedIndex];
      itemName = opt?.dataset?.name || '';
      if (!itemId) { alert('품목을 선택해주세요.'); return; }
    }

   // [묶음 5E] 중복 등록 강제 차단 — 같은 date + type + itemId(또는 egg)의 scheduled 항목 있으면 등록 거부
    // (수정하려면 기존 항목을 취소하고 재등록해야 함)
    const existingSchedules = await loadSchedules();
    const duplicate = existingSchedules.find(s => {
      if (isEdit && s.id === editingSchedule.id) return false;
      if (s.status !== 'scheduled') return false;
      if (s.date !== date) return false;
      if (s.type !== type) return false;
      // 계란은 itemId 없음 → type만 일치하면 중복
      if (type === 'egg') return true;
      // 그 외(원육/봉투)는 itemId 정확히 일치
      return s.itemId === itemId;
    });
    if (duplicate) {
      const dupLabel = type === 'egg' ? '계란' : itemName;
      alert(
        `이미 ${date}에 [${dupLabel}] 입고예정이 등록되어 있습니다.\n` +
        `(기존: ${duplicate.orderedQty}${duplicate.orderedUnit})\n\n` +
        `같은 날짜의 같은 품목은 중복 등록할 수 없습니다.`
      );
      return;
    }

    if (isEdit) {
      const before = {
        date: editingSchedule.date,
        orderedQty: editingSchedule.orderedQty,
        orderedUnit: editingSchedule.orderedUnit,
        orderStaffName: editingSchedule.orderStaffName || '',
        orderMemo: editingSchedule.orderMemo || '',
      };

      await updateDoc(doc(db, 'schedules', editingSchedule.id), {
        date,
        orderedQty: qty,
        orderedUnit: unit,
        orderedUnitGrams,
        orderStaffName: staff,
        orderMemo: memo,
        updatedAt: new Date(),
      });

      const today = getToday();
      await recordActivity({
        action: 'schedule',
        subAction: 'edit',
        date: today,
        staff,
        message: `입고예정 수정 — ${itemName} ${before.orderedQty}${before.orderedUnit} → ${qty}${unit} (예정일 ${before.date} → ${date}) / 담당: ${staff}`,
        details: {
          scheduleId: editingSchedule.id,
          type,
          itemId,
          itemName,
          before,
          after: {
            date,
            orderedQty: qty,
            orderedUnit: unit,
            orderedUnitGrams,
            orderStaffName: staff,
            orderMemo: memo || '',
          },
        },
      });

      closeModal();
      const newSchedules = await loadSchedules();
      renderScheduleLayout(newSchedules);
      alert('입고 예정 수정 완료!');
      return;
    }

    const scheduleRef = await addDoc(collection(db, 'schedules'), {
      date, type,
      itemId,
      itemNameSnapshot: itemName,
      orderedQty: qty,
      orderedUnit: unit,
      orderedUnitGrams,
      status: 'scheduled',
      orderStaffName: staff,
      orderMemo: memo,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // [묶음 5A] 사무 로그 발행 — 입고예정 등록 (운영자가 메인 화면에서 등록 추적 가능하게)
    // 계란은 구분=품목이라 typeLabel 생략 ("계란 계란" 중복 방지)
    const typeLabel = type === 'meat' ? '원육' : type === 'bag' ? '봉투' : '';
    const itemLabel = type === 'egg' ? '계란' : `${typeLabel} ${itemName}`;
    const today = getToday();
    await recordActivity({
      action: 'schedule',
      subAction: 'register',
      date: today,
      staff,
      message: `입고예정 등록 — ${itemLabel} ${qty}${unit} (예정일 ${date}) / 담당: ${staff}`,
      details: {
        scheduleId: scheduleRef.id,
        type,
        itemId,
        itemName,
        orderedQty: qty,
        orderedUnit: unit,
        orderedUnitGrams,
        scheduledDate: date,
        memo: memo || null,
      },
    });

    closeModal();
    const newSchedules = await loadSchedules();
    renderScheduleLayout(newSchedules);
    alert('입고 예정 등록 완료!');
  });
}

function showCancelScheduleModal(s) {
  showModal(`
    <h3 class="modal-title">입고예정 취소 — ${s.itemNameSnapshot}</h3>
    <p style="font-size:12px;color:#888;margin-bottom:16px;">발주수량: ${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)}</p>
    <div class="form-group">
      <label>취소 사유 *</label>
      <input type="text" id="m_reason" placeholder="사유 입력" />
    </div>
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(['office'])}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveCancelSchedule">확인</button>
    </div>
  `);

  document.getElementById('btnSaveCancelSchedule').addEventListener('click', async () => {
    const reason = document.getElementById('m_reason').value.trim();
    const staff = document.getElementById('m_staff').value;

    if (!reason) { alert('취소 사유는 필수입니다.'); return; }
    if (!staff) { alert('담당자는 필수입니다.'); return; }

    await updateDoc(doc(db, 'schedules', s.id), {
      status: 'cancelled',
      cancelReason: reason,
      cancelStaffName: staff,
      cancelledAt: new Date(),
      updatedAt: new Date(),
    });

    // 사무 로그 발행
    const today = getToday();
    await recordActivity({
      action: 'schedule',
      subAction: 'cancel',
      date: today,
      staff,
      message: `${s.itemNameSnapshot} 입고 예정 취소 / 사유: ${reason} / 담당: ${staff}`,
      details: {
        scheduleId: s.id,
        type: s.type,
        itemId: s.itemId || null,
        itemName: s.itemNameSnapshot,
        orderedQty: s.orderedQty,
        unit: s.orderedUnit,
        scheduledDate: s.date,
        cancelReason: reason,
      },
    });

    closeModal();
    const newSchedules = await loadSchedules();
    renderScheduleLayout(newSchedules);
    alert('취소 완료!');
  });
}

function showCompleteModal(s) {
  const isCountMeatOrder = s.type === 'meat' && isCountIncomingUnit(s.orderedUnit);
  showModal(`
    <h3 class="modal-title">입고 완료 처리 — ${s.itemNameSnapshot}</h3>
    <p style="font-size:12px;color:#888;margin-bottom:16px;">발주수량: ${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)}</p>
    <div class="form-group">
      <label>실제 수량 *</label>
      <input type="number" id="m_actual" placeholder="실제 입고 수량 입력" />
    </div>
    ${isCountMeatOrder ? `
      <div class="form-group">
        <label>실제 단위</label>
        <select id="m_actual_unit">
          <option value="${s.orderedUnit}">${s.orderedUnit}</option>
          <option value="g">g</option>
        </select>
      </div>
    ` : ''}
    <div class="form-group">
      <label>입고 담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${getStaffOptions(s.type === 'egg' ? ['senior'] : ['lead'])}
      </select>
    </div>
    <div class="form-group">
      <label>완료메모</label>
      <input type="text" id="m_memo" placeholder="메모" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnSaveComplete">완료 처리</button>
    </div>
  `);

  document.getElementById('btnSaveComplete').addEventListener('click', async () => {
    try {
    const actual = parseFloat(document.getElementById('m_actual').value);
    const actualUnit = document.getElementById('m_actual_unit')?.value || s.orderedUnit;
    const staff = document.getElementById('m_staff').value;
    const memo = document.getElementById('m_memo').value;

    if (!actual || !staff) { alert('실제 수량과 담당자는 필수입니다.'); return; }
    if (isCountMeatOrder && (!s.orderedUnitGrams || s.orderedUnitGrams <= 0)) {
      alert('이 발주의 1마리당 g 정보가 없습니다. 발주를 수정해 1마리당 g을 입력해주세요.');
      return;
    }
    const today = getToday();
    if (await blockIfClosed(today)) return;

    // 발주/실제 수량 차이 시 한 번 더 확인
    const orderedCompareQty = isCountIncomingUnit(s.orderedUnit) && actualUnit === 'g'
      ? Number(s.orderedQty || 0) * Number(s.orderedUnitGrams || 0)
      : Number(s.orderedQty || 0);
    if (actual !== orderedCompareQty) {
      const proceed = await showConfirmModal({
        title: '수량 차이 확인',
        message: `발주 수량과 실제 수량이 다릅니다.\n\n발주: ${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)}\n실제: ${formatScheduleQty(actual, actualUnit, s.orderedUnitGrams)}\n\n이대로 완료 처리하시겠습니까?`,
        confirmText: '완료 처리',
      });
      if (!proceed) return;
    }

    // 재고 자동 입고 + ledger items 누적
    const ledgerItems = [];

    if (s.type === 'meat' && s.itemId) {
      const meatSnap = await getDoc(doc(db, 'meatTypes', s.itemId));
      if (meatSnap.exists()) {
        const qtyG = isCountIncomingUnit(s.orderedUnit)
          ? (actualUnit === 'g' ? actual : actual * Number(s.orderedUnitGrams || 0))
          : (s.orderedUnit === 'kg' ? actual * 1000 : actual);
        const stockUpdatedAt = new Date();
        const newStockRef = await addDoc(collection(db, 'meatStocks'), {
          meatTypeId: s.itemId,
          meatNameSnapshot: s.itemNameSnapshot,
          stage: 'frozen',
          incomingDate: today,
          initialQtyG: qtyG,
          remaining: qtyG,
          staffName: staff,
          note: `입고예정 완료: ${s.orderMemo || ''}`,
          closed: false,
          createdAt: new Date(),
          updatedAt: stockUpdatedAt,
        });

        await recordMeatLog({
          type: 'frozenIncoming',
          date: today,
          meatTypeId: s.itemId,
          meatNameSnapshot: s.itemNameSnapshot,
          stage: 'frozen',
          meatStockId: newStockRef.id,
          delta: qtyG,
          before: 0,
          after: qtyG,
          staff,
          reason: `입고예정 완료${s.orderMemo ? ` - ${s.orderMemo}` : ''}`,
        });

        ledgerItems.push({
          collection: 'meatStocks',
          docId: newStockRef.id,
          field: 'remaining',
          delta: qtyG,
          before: 0,
          after: qtyG,
          label: `${s.itemNameSnapshot} 냉동창고`,
          stockUpdatedAtSnapshot: stockUpdatedAt,
          isNewDoc: true,
        });
      }
    } else if (s.type === 'bag' && s.itemId) {
      const bagSnap = await getDoc(doc(db, 'bagTypes', s.itemId));
      if (bagSnap.exists()) {
        const bagData = bagSnap.data();
        const qtyPcs = s.orderedUnit === '박스' ? actual * (bagData.piecesPerBox || 1) : actual;
        const before = bagData.currentQty || 0;
        const after = before + qtyPcs;
        const stockUpdatedAt = new Date();

        await updateDoc(doc(db, 'bagTypes', s.itemId), {
          currentQty: after,
          updatedAt: stockUpdatedAt,
        });

        const bagLogRef = await addDoc(collection(db, 'bagLogs'), {
          date: today, timestamp: new Date(),
          bagTypeId: s.itemId,
          bagNameSnapshot: s.itemNameSnapshot,
          type: 'incoming', qty: qtyPcs,
          before, after,
          staffName: staff,
          note: `입고예정 완료`,
        });

        ledgerItems.push({
          collection: 'bagTypes',
          docId: s.itemId,
          field: 'currentQty',
          delta: qtyPcs,
          before,
          after,
          label: `${s.itemNameSnapshot} 봉투`,
          stockUpdatedAtSnapshot: stockUpdatedAt,
          bagLogId: bagLogRef.id,
        });
      }
    } else if (s.type === 'egg') {
      const eggSnap = await getDoc(doc(db, 'eggStock', 'global'));
      const current = eggSnap.exists() ? eggSnap.data().currentQty : 0;
      const minQty = eggSnap.exists() ? eggSnap.data().minimumQty : 0;
      const qtyEgg = s.orderedUnit === '판' ? actual * 30 : actual;
      const after = current + qtyEgg;
      const stockUpdatedAt = new Date();

      await updateDoc(doc(db, 'eggStock', 'global'), {
        currentQty: after,
        minimumQty: minQty,
        updatedAt: stockUpdatedAt,
      });

      const eggLogRef = await addDoc(collection(db, 'eggLogs'), {
        date: today, timestamp: new Date(),
        type: 'in', qty: qtyEgg,
        before: current, after,
        staffName: staff, note: '입고예정 완료',
      });

      ledgerItems.push({
        collection: 'eggStock',
        docId: 'global',
        field: 'currentQty',
        delta: qtyEgg,
        before: current,
        after,
        label: '계란',
        stockUpdatedAtSnapshot: stockUpdatedAt,
        eggLogId: eggLogRef.id,
      });
    }

    // ledger 저장
    let ledgerId = null;
    if (ledgerItems.length > 0) {
      const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
        actionType: 'scheduleComplete',
        actionId: s.id,
        timestamp: new Date(),
        date: today,
        status: 'active',
        items: ledgerItems,
      });
      ledgerId = ledgerRef.id;
    }

    await updateDoc(doc(db, 'schedules', s.id), {
      status: 'completed',
      actualQty: actual,
      actualUnit,
      actualQtyG: s.type === 'meat' ? (isCountIncomingUnit(s.orderedUnit)
        ? (actualUnit === 'g' ? actual : actual * Number(s.orderedUnitGrams || 0))
        : (s.orderedUnit === 'kg' ? actual * 1000 : actual)) : null,
      incomingStaffName: staff,
      completeMemo: memo,
      completedAt: new Date(),
      ledgerId,
      updatedAt: new Date(),
    });

    // [묶음 6C-2] 입고 완료 — 차이 있으면 'completeDiff' (확인 필수), 없으면 'complete' (일반)
    // subAction 분기로 메인 로그 패널이 차이 있는 건만 ⚠️ 빨간 줄 + [확인] 버튼 표시
    const hasDiff = actual !== orderedCompareQty;
    await recordActivity({
      action: 'schedule',
      subAction: hasDiff ? 'completeDiff' : 'complete',
      date: today,
      staff,
      message: hasDiff
        ? `${s.itemNameSnapshot} 입고 완료 ⚠️ 발주 ${formatScheduleQty(s.orderedQty, s.orderedUnit, s.orderedUnitGrams)} → 실제 ${formatScheduleQty(actual, actualUnit, s.orderedUnitGrams)} / 담당: ${staff}`
        : `${s.itemNameSnapshot} 입고 완료 차이 없음 / 담당: ${staff}`,
      details: {
        scheduleId: s.id,
        type: s.type,
        itemId: s.itemId || null,
        itemName: s.itemNameSnapshot,
        orderedQty: s.orderedQty,
        actualQty: actual,
        unit: actualUnit,
        orderedUnit: s.orderedUnit,
        orderedUnitGrams: s.orderedUnitGrams || null,
        hasDiff,
        memo: memo || null,
      },
    });

    closeModal();
    const newSchedules = await loadSchedules();
    renderScheduleLayout(newSchedules);
    alert('완료 처리되었습니다!');
    } catch (err) {
      console.error('입고 완료 처리 오류:', err);
      alert(`완료 처리 중 오류가 발생했습니다.\n\n${err.code || ''} ${err.message}\n\n이 메시지를 관리자에게 전달해주세요.`);
    }
  });
}

// 유틸

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

  overlay.addEventListener('click', (e) => {
    // 외부 클릭 닫힘 비활성화 (묶음 1F: 모달 사라짐 이슈 우회)
  });
}

window.closeModal = function() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.remove();
};
