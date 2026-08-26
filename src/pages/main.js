import { db } from '../firebase.js';
import {
  collection, getDocs, doc, addDoc, updateDoc, getDoc, query, orderBy, setDoc, where, deleteDoc, serverTimestamp, limit, startAfter, writeBatch
} from 'firebase/firestore';
import { getTodayKST as getToday, getYesterdayKST, getNextBusinessDayByType as getNextBusinessDay, loadHolidaysCache, getHolidaysCache, getHolidayInfoCache, getHolidayDataNotice } from '../utils/date.js';
import { findActionableClosingDate, getAllBlockingItems } from '../services/closingChecks.js';
import { setCurrentMenu, currentUserRole, currentMenu } from '../app.js';
import { renderLayout } from '../layout.js';
import { renderPage } from '../router.js';
import { recordMeatLog } from '../services/meatLogs.js';
import { showPromptModal, showConfirmModal } from '../utils/modal.js';
import { acknowledgeLog, recordActivity } from '../services/activityLogs.js';
import { blockIfClosed } from '../utils/closingGuard.js';
import { round2, formatIngredientQtyValue } from '../utils/number.js';

let productions = [];
let nextProductions = [];
let recipes = [];
let meatStocks = [];
let meatTypeCategoryMap = new Map();
let eggStock = { currentQty: 0, minimumQty: 0 };
let completionDoc = null;
let blockingData = { totalBlocked: 0, items: [] };
let overdueClosingDate = null;
let overdueClosingAlreadyClosed = false;
let overdueProductions = [];
let overdueNextProductions = [];
let overdueCompletionDoc = null;

// [묶음 6B-1] 캘린더 데이터 — 14일치만 별도 보관 (productions/nextProductions는 오늘+다음영업일만)
let calendarSchedules = [];
let calendarProductions = [];
let calendarEvents = [];
let calendarWeekOffset = 0;  // 0=오늘 포함 주, +1=한 주 앞으로, -1=뒤로

// [묶음 6E-4] selectedDate 모드 — 캘린더에서 [이 날짜로 보기] 클릭 시 그 날짜를 1번 화면에 표시
//   null이면 기본 모드 (오늘 또는 마감 후 다음 영업일)
//   값이 있으면 선택 날짜 모드 (마감 액션 버튼 disabled, 원육 출고도 그 날짜 기준)
let selectedProductionDate = null;
let selectedDateProductions = [];
let selectedDateBlockingData = null;

function isTenderFreezeDryProduction(item) {
  return item?.category === 'freezeDry' && item.requiresSeparation === false;
}

function renderFreezeDryProductionMeta(item) {
  const parts = [`<span>${item.freezeDryBagQty || 0}봉</span>`];
  if (!isTenderFreezeDryProduction(item)) parts.push(`<span>${item.breadPanQty || 0}빵판</span>`);
  parts.push(`<span>${item.freezePanQty || 0}동결판</span>`);
  return parts.join('');
}

// [묶음 6C-1] 로그 패널 데이터 — 당일 전체 + 어제 이전 미확인(확인 필수)만
let combinedLogs = [];

export async function renderMain() {
  const content = document.getElementById('mainContent');
  content.innerHTML = `<div style="padding:24px;"><p>메인 로딩 중...</p></div>`;
  selectedProductionDate = null;
  selectedDateProductions = [];
  selectedDateBlockingData = null;
  await loadAllData();
  // [Navigation guard] loadAllData 도중에 다른 메뉴로 이동했으면 main 덮어쓰지 않음.
  // currentMenu가 'main'이 아니라면 stale 호출이므로 mainContent 보존.
  if (currentMenu !== 'main') return;
  renderMainLayout();
}

async function loadAllData() {
  const today = getToday();

  // [묶음 6B-1] 휴일 캐시 먼저 로드해야 다음 영업일 계산이 휴일 반영
  await loadHolidaysCache();

  const nextBizDay = getNextBusinessDay(today);

  const prodSnap = await getDocs(query(collection(db, 'productions'), orderBy('sortOrder')));
  const allProds = prodSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const overdueClosing = await findActionableClosingDate(today, allProds);
  overdueClosingDate = overdueClosing?.date || null;
  overdueClosingAlreadyClosed = Boolean(overdueClosing?.closed);
  overdueProductions = overdueClosingDate
    ? allProds.filter(p => p.date === overdueClosingDate && p.status !== 'deleted')
    : [];
  const overdueNextBizDay = overdueClosingDate ? getNextBusinessDay(overdueClosingDate) : null;
  overdueNextProductions = overdueNextBizDay
    ? allProds.filter(p => p.date === overdueNextBizDay && p.status !== 'deleted')
    : [];
  productions = allProds.filter(p => p.date === today && p.status !== 'deleted');
  nextProductions = allProds.filter(p => p.date === nextBizDay && p.status !== 'deleted');

  const recipeSnap = await getDocs(collection(db, 'recipes'));
  recipes = recipeSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const meatTypeSnap = await getDocs(collection(db, 'meatTypes'));
  meatTypeCategoryMap = new Map(meatTypeSnap.docs.map(d => [
    d.id,
    d.data().category === 'produce' ? 'produce' : 'meat',
  ]));

  const meatSnap = await getDocs(collection(db, 'meatStocks'));
  meatStocks = meatSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.closed);

  const eggSnap = await getDoc(doc(db, 'eggStock', 'global'));
  if (eggSnap.exists()) eggStock = eggSnap.data();

  const compSnap = await getDoc(doc(db, 'productionCompletion', today));
  completionDoc = compSnap.exists() ? { id: compSnap.id, ...compSnap.data() } : null;
  if (overdueClosingDate) {
    const overdueCompSnap = await getDoc(doc(db, 'productionCompletion', overdueClosingDate));
    overdueCompletionDoc = overdueCompSnap.exists() ? { id: overdueCompSnap.id, ...overdueCompSnap.data() } : null;
  } else {
    overdueCompletionDoc = null;
  }

  blockingData = overdueClosing?.blockingData || await getAllBlockingItems(today);

  // [묶음 6B-1] 캘린더 14일치 데이터 (현재 weekOffset 기준)
  await loadCalendarData(calendarWeekOffset);

  // [묶음 6C-3] 자동 발행 — 이벤트 당일/입고예정 도래/최소재고 미달
  // dedup으로 같은 사유 중복 발행 방지. date=today로 매일 새로 발행 (= 매일 반복).
  // ★ loadCombinedLogs 이전에 호출해야 신규 발행도 화면에 즉시 표시됨.
  await triggerAutoLogs(today);

  // [묶음 6C-1] 로그 패널 데이터 (당일 전체 + 어제~10일 전 미확인 확인필수)
  await loadCombinedLogs();
}

function renderMainLayout() {
  const content = document.getElementById('mainContent');
  const today = getToday();
  const nextBizDay = getNextBusinessDay(today);
  const isCompleted = completionDoc?.status === 'completed';
  const canRefreshCompletion = currentUserRole === 'admin' || currentUserRole === 'office';

  // [묶음 6E-4] selectedDate 모드 — 캘린더에서 [이 날짜로 보기] 클릭한 상태
  const isViewingSelectedDate = selectedProductionDate !== null;
  const isOverdueClosingMode = !isViewingSelectedDate && overdueClosingDate !== null;
  const activeBlockingData = isViewingSelectedDate && selectedDateBlockingData
    ? selectedDateBlockingData
    : blockingData;
  const overdueStatusText = overdueClosingAlreadyClosed ? '마감 후 미처리 확인 필요' : '미마감 처리 필요';

  // 활성 productions 결정 (selectedDate 모드 우선)
  const activeProductions = isViewingSelectedDate
    ? selectedDateProductions
    : (isOverdueClosingMode ? overdueProductions
      : (isCompleted ? nextProductions : productions));

  const activeDateLabel = isViewingSelectedDate
    ? `${selectedProductionDate} 생산 (선택 날짜)`
    : (isOverdueClosingMode ? `${overdueClosingDate} 생산 (${overdueStatusText})`
      : (isCompleted ? `불러온 다음 영업일 생산 (${nextBizDay})` : '오늘 생산'));

  const meatNeedsTitle = isViewingSelectedDate
    ? `🥩 ${selectedProductionDate} 출고원료`
    : (isOverdueClosingMode ? `🥩 ${overdueClosingDate} 출고원료`
      : (isCompleted ? '🥩 금일 출고원료' : '🥩 금일 출고원료'));

  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const displayDate = isViewingSelectedDate
    ? selectedProductionDate
    : (isOverdueClosingMode ? overdueClosingDate
      : (isCompleted ? nextBizDay : today));
  const displayDateObj = new Date(displayDate + 'T00:00:00');
  const todayStr = `${displayDateObj.getMonth()+1}/${displayDateObj.getDate()} (${days[displayDateObj.getDay()]})`;

  content.innerHTML = `
    ${renderHolidayDataNoticeBanner()}
    <div class="main-layout">
      <div class="main-panel-left">
        <div class="main-panel-header">
          <span class="main-panel-title">📅 ${todayStr} 생산${isViewingSelectedDate ? ' <span style="font-size:11px;color:#3182ce;font-weight:normal;">(선택 날짜)</span>' : ''}${isOverdueClosingMode ? ` <span style="font-size:11px;color:#c53030;font-weight:normal;">(${overdueStatusText})</span>` : ''}</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="btn-secondary" id="btnBigView" style="font-size:11px;padding:3px 10px;">크게보기</button>
            <button class="btn-secondary" id="btnTodayReceiptSummary" style="font-size:11px;padding:3px 10px;">입고 현황 전체 보기</button>
            ${isViewingSelectedDate
              ? `
                <button class="btn-primary" id="btnTomorrowLoad" style="font-size:12px;padding:5px 14px;opacity:0.5;cursor:not-allowed;" disabled title="오늘 화면에서만 가능">내일생산불러오기</button>
                <button class="btn-secondary" id="btnBackToToday" style="font-size:11px;padding:3px 10px;color:#3182ce;">↩ 오늘로 돌아가기</button>
              `
              : (isOverdueClosingMode
                ? (overdueCompletionDoc?.status === 'completed'
                  ? `<button class="btn-primary" id="btnTomorrowLoad" style="font-size:12px;padding:5px 14px;opacity:0.5;cursor:not-allowed;" disabled title="이미 처리되었습니다">이미 처리됨</button>`
                  : `<button class="btn-primary" id="btnTomorrowLoad" style="font-size:12px;padding:5px 14px;" ${overdueNextProductions.length === 0 ? 'disabled title="다음 영업일에 등록된 생산이 없습니다"' : ''}>내일생산불러오기 (${overdueClosingDate} 소급)</button>`)
                : (isCompleted
                ? `
                  ${canRefreshCompletion ? '<button class="btn-secondary" id="btnRefreshCompletion" style="font-size:11px;padding:3px 10px;color:#3182ce;" title="롤백 후 변경된 생산 기준으로 재차감">새로고침</button>' : ''}
                  <button class="btn-secondary" id="btnCancelCompletion" style="font-size:11px;padding:3px 10px;color:#e53e3e;">내일생산취소</button>
                `
                : `<button class="btn-primary" id="btnTomorrowLoad" style="font-size:12px;padding:5px 14px;" ${nextProductions.length === 0 ? 'disabled title="다음 영업일에 등록된 생산이 없습니다"' : ''}>내일생산불러오기</button>`
                )
              )
            }
          </div>
        </div>
        <div class="main-production-area">
          <div class="main-production-label">
            <span>${activeDateLabel}</span>
            ${isCompleted && !isViewingSelectedDate && !isOverdueClosingMode ? '<span class="main-completed-pill">내일생산불러오기 완료</span>' : ''}
          </div>
          <div class="main-production-grid">
            ${activeProductions.length === 0
              ? `<div class="main-empty">${isViewingSelectedDate ? '선택한 날짜에 생산 없음' : (isOverdueClosingMode ? '처리 필요 날짜에 생산 없음' : (isCompleted ? '불러온 다음 영업일 생산 없음' : '오늘 생산 없음'))}</div>`
              : activeProductions.map(p => renderProductionTableCard(p)).join('')}
          </div>
        </div>
      </div>

      <!-- [묶음 6A] 우상단 = 2번(원육) + 3번(로그) 가로 분할 -->
      <div class="main-panel-right-top">
        <div class="main-panel-2">
          <div class="main-panel-header">
            <span class="main-panel-title">${meatNeedsTitle}</span>
          </div>
          <div style="padding:8px;font-size:12px;">
            ${renderMeatNeeds(activeProductions, isCompleted && !isViewingSelectedDate)}
          </div>
        </div>

        <!-- 3번 화면 = 차단 영역 + 생산 로그 + 사무 로그 -->
        <div class="main-panel-3">
          ${renderBlockerArea(activeBlockingData)}
          <div class="main-log-columns">
            ${renderLogSection('production')}
            ${renderLogSection('office')}
          </div>
        </div>
      </div>

      <!-- [묶음 6B-1] 우하단 = 4번 캘린더 -->
      <div class="main-panel-right-bottom">
        <div class="main-panel-header">
          <span class="main-panel-title">📆 2주 캘린더</span>
        </div>
        <div class="main-calendar-body">
          ${renderCalendar()}
        </div>
      </div>
    </div>
  `;

  document.getElementById('btnBigView')?.addEventListener('click', showBigView);
  document.getElementById('btnTodayReceiptSummary')?.addEventListener('click', () => showReceiptSummaryModal(activeProductions, displayDate));
  document.getElementById('btnTomorrowLoad')?.addEventListener('click', () => handleTomorrowLoad(isOverdueClosingMode ? overdueClosingDate : undefined));
  document.getElementById('btnCancelCompletion')?.addEventListener('click', handleCancelCompletion);
  // [묶음 6E-3] 새로고침 버튼 — 마감 후 다음 영업일 생산 변경됐을 때 롤백+재차감
  document.getElementById('btnRefreshCompletion')?.addEventListener('click', handleRefreshCompletion);
  // [묶음 6E-4] 오늘로 돌아가기 버튼 — selectedDate 모드 해제
  document.getElementById('btnBackToToday')?.addEventListener('click', handleBackToToday);

  // [spec_v27 P2] 생산 카드 클릭 → 제품 입고 모달 (생식 한정)
  const canReceive = currentUserRole === 'admin' || currentUserRole === 'office' || currentUserRole === 'production';
  if (canReceive && (isOverdueClosingMode || isViewingSelectedDate || !isCompleted)) {
    document.querySelectorAll('.main-production-card.receivable').forEach(card => {
      card.style.cursor = 'pointer';
      card.title = '클릭하여 제품 입고';
      card.addEventListener('click', () => {
        const target = [
          ...selectedDateProductions,
          ...overdueProductions,
          ...productions,
          ...nextProductions,
        ].find(p => p.id === card.dataset.id);
        if (target?.category === 'freezeDry') openFreezeDryReceiptModal(card.dataset.id);
        else openProductReceiptModal(card.dataset.id);
      });
    });
  }

  // 차단 영역의 점프 버튼 (기존 알림 카드와 동일 동작)
  document.querySelectorAll('.alert-card-jump').forEach(btn => {
    btn.addEventListener('click', () => {
      const menuId = btn.dataset.jump;
      setCurrentMenu(menuId);
      renderLayout();
      renderPage(menuId);
    });
  });

  // [묶음 6B-1] 캘린더 좌우 이동 + 날짜 클릭 바인딩
  bindCalendarEvents();

  // [묶음 6C-1] 로그 패널 [확인] / [모두 확인] 바인딩
  bindLogActions();
}

function renderHolidayDataNoticeBanner() {
  if (currentUserRole === 'production') return '';
  const notice = getHolidayDataNotice(getToday());
  if (!notice) return '';
  return `
    <div class="holiday-data-notice holiday-data-notice--${notice.level}">
      ${notice.message}
    </div>
  `;
}

// ============================================================
// [묶음 6B-1] 캘린더 — 2주 표시 + 좌우 이동 + 날짜 클릭 모달
// ============================================================

// 캘린더 표시 14일 범위 계산. weekOffset 0=오늘 포함 주의 월요일부터, +1=한 주 뒤로...
function getCalendarRange(weekOffset = 0) {
  const today = new Date(getToday() + 'T00:00:00');
  const dow = (today.getDay() + 6) % 7;  // 월=0, 화=1, ..., 일=6
  const monday = new Date(today);
  monday.setDate(monday.getDate() - dow + weekOffset * 7);

  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return { dates, startDate: dates[0], endDate: dates[13] };
}

// 14일치 schedules / productions / events 한 번에 로드
async function loadCalendarData(weekOffset = 0) {
  const { startDate, endDate } = getCalendarRange(weekOffset);

  // schedules — status='scheduled'만 표시
  const schedSnap = await getDocs(query(
    collection(db, 'schedules'),
    where('date', '>=', startDate),
    where('date', '<=', endDate),
  ));
  calendarSchedules = schedSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.status === 'scheduled');

  // productions — deleted 제외
  const prodSnap = await getDocs(query(
    collection(db, 'productions'),
    where('date', '>=', startDate),
    where('date', '<=', endDate),
  ));
  calendarProductions = prodSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => p.status !== 'deleted');

  // events — 컬렉션 없을 수도 있어 안전 가드
  try {
    const evSnap = await getDocs(query(
      collection(db, 'events'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
    ));
    calendarEvents = evSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('[캘린더] events 컬렉션 로드 실패 (정상 — 6B-2 전):', err.message);
    calendarEvents = [];
  }
}

// 캘린더 HTML 생성. main-calendar-body 안에 들어감.
function renderCalendar() {
  const { dates } = getCalendarRange(calendarWeekOffset);
  const today = getToday();
  const holidays = getHolidaysCache();
  const holidayInfo = getHolidayInfoCache();

  // 월요일 시작 요일 헤더
  const weekdays = ['월', '화', '수', '목', '금', '토', '일'];

  const headerLabel = formatCalendarRangeLabel(dates[0], dates[13]);

  return `
    <div class="cal-container">
      <div class="cal-toolbar">
        <button class="cal-nav-btn" id="btnCalPrev" title="이전 주">◀</button>
        <span class="cal-range-label">${headerLabel}</span>
        <button class="cal-nav-btn" id="btnCalNext" title="다음 주">▶</button>
        ${calendarWeekOffset !== 0 ? '<button class="cal-today-btn" id="btnCalToday">오늘로</button>' : ''}
      </div>
      <div class="cal-weekday-row">
        ${weekdays.map((w, i) => `<div class="cal-weekday ${i >= 5 ? 'cal-weekday-weekend' : ''}">${w}</div>`).join('')}
      </div>
      <div class="cal-grid">
        ${dates.map(date => renderCalendarCell(date, today, holidays, holidayInfo)).join('')}
      </div>
    </div>
  `;
}

// 캘린더 셀 1개 (= 1일)
function renderCalendarCell(date, today, holidays, holidayInfo) {
  const d = new Date(date + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;  // 월=0, ..., 일=6
  const isWeekend = dow >= 5;
  const holiday = holidayInfo[date] || null;
  const nextHoliday = holidayInfo[getCalendarOffsetDate(date, 1)] || null;
  const isShippingOnlyClosed = !isWeekend
    && holiday?.affectsProduction !== true
    && (
      holiday?.affectsShipping === true
      || (nextHoliday?.affectsShipping === true && nextHoliday.shippingClosedFromEnabled === true)
    );
  const isHoliday = !isShippingOnlyClosed && (isWeekend || holiday?.affectsProduction === true || (!holiday && holidays.includes(date)));
  const isToday = (date === today);

  const events = calendarEvents.filter(e => e.date === date);
  const schedules = calendarSchedules.filter(s => s.date === date);
  const productions = calendarProductions.filter(p => p.date === date);

  // 태그: 이벤트 → 입고예정 → 생산 (스펙 5절 4번 화면 순서)
  // [묶음 6B-1 보강] truncate 제거 — CSS line-clamp가 셀 폭 맞춰 자동 줄바꿈/말줄임 처리
  const tagBlocks = [];
  events.forEach(e => {
    const label = e.title || '';
    tagBlocks.push(`<div class="cal-tag cal-tag-event" title="${escapeHtmlMain(label)}">📌 ${escapeHtmlMain(label)}</div>`);
  });
  schedules.forEach(s => {
    const label = formatScheduleLabel(s);
    tagBlocks.push(`<div class="cal-tag cal-tag-schedule" title="${escapeHtmlMain(label)}">📦 ${escapeHtmlMain(label)}</div>`);
  });
  const prodCap = 3;
  productions.slice(0, prodCap).forEach(p => {
    const qtyPart = p.productionUnitQty != null
      ? ` ${formatQty(p.productionUnitQty)}${getProductionUnitDisplayUnit(p)}`
      : '';
    const label = `${p.recipeName || ''}${qtyPart}`;
    tagBlocks.push(`<div class="cal-tag cal-tag-production" title="${escapeHtmlMain(label)}">🏭 ${escapeHtmlMain(label)}</div>`);
  });
  if (productions.length > prodCap) {
    tagBlocks.push(`<div class="cal-tag-more">+${productions.length - prodCap}</div>`);
  }

  // 날짜 라벨 — 월 1일이면 "5/1" 식으로 월 같이
  const parts = date.split('-');
  const dayNum = parseInt(parts[2], 10);
  const dateLabel = dayNum === 1 ? `${parseInt(parts[1], 10)}/${dayNum}` : String(dayNum);
  const shippingClosedLabel = isShippingOnlyClosed ? '배송불가일' : '';

  const cls = [
    'cal-cell',
    isHoliday ? 'cal-cell-holiday' : '',
    isShippingOnlyClosed ? 'cal-cell-shipping-closed' : '',
    isToday ? 'cal-cell-today' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="${cls}" data-date="${date}">
      <div class="cal-cell-date-row">
        <span class="cal-cell-date">${dateLabel}</span>
        ${shippingClosedLabel ? `<span class="cal-shipping-closed-label">(${shippingClosedLabel})</span>` : ''}
      </div>
      <div class="cal-cell-tags">${tagBlocks.join('')}</div>
    </div>
  `;
}

// 캘린더 좌우 이동 + 셀 클릭 바인딩
function getCalendarOffsetDate(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function bindCalendarEvents() {
  document.getElementById('btnCalPrev')?.addEventListener('click', () => {
    calendarWeekOffset -= 1;
    refreshCalendar();
  });
  document.getElementById('btnCalNext')?.addEventListener('click', () => {
    calendarWeekOffset += 1;
    refreshCalendar();
  });
  document.getElementById('btnCalToday')?.addEventListener('click', () => {
    calendarWeekOffset = 0;
    refreshCalendar();
  });
  document.querySelectorAll('.cal-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const date = cell.dataset.date;
      if (date) showDateModal(date);
    });
  });
}

// 좌우 이동 시 캘린더만 다시 그림 (전체 메인 재로드 안 함 — 빠르게)
async function refreshCalendar() {
  await loadCalendarData(calendarWeekOffset);
  const body = document.querySelector('.main-calendar-body');
  if (!body) return;
  body.innerHTML = renderCalendar();
  bindCalendarEvents();
}

// 캘린더 헤더 라벨: "5/4 ~ 5/17"
function formatCalendarRangeLabel(startDate, endDate) {
  const s = startDate.split('-');
  const e = endDate.split('-');
  return `${parseInt(s[1])}/${parseInt(s[2])} ~ ${parseInt(e[1])}/${parseInt(e[2])}`;
}

// 입고예정 라벨 — schedules 데이터 구조에 맞춤
function formatScheduleLabel(s) {
  const itemName = s.itemNameSnapshot || '';
  const qty = s.orderedQty != null ? s.orderedQty : '';
  const unit = s.orderedUnit || '';
  if (s.type === 'egg') return `계란 ${qty}${unit}`;
  if (s.type === 'meat') return `${itemName || '원육'} ${qty}${unit}`;
  if (s.type === 'bag') return `${itemName || '봉투'} ${qty}${unit}`;
  return `${itemName} ${qty}${unit}`;
}

// 날짜 클릭 시 요약 모달
function showDateModal(date) {
  // [묶음 6F] 캘린더 편집 권한 — admin/office만 이벤트/휴일 변경 가능 (production role 차단)
  const canEditCalendar = currentUserRole === 'admin' || currentUserRole === 'office';

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(date + 'T00:00:00');
  const dateLabel = `${parseInt(date.split('-')[1])}월 ${parseInt(date.split('-')[2])}일 (${dayNames[d.getDay()]})`;

  const holidays = getHolidaysCache();
  const dow = d.getDay();
  const isWeekend = (dow === 0 || dow === 6);
  const isManualHoliday = holidays.includes(date);
  const isHoliday = isWeekend || isManualHoliday;
  const holidayPill = isHoliday ? '<span class="cal-modal-holiday-pill">휴일</span>' : '';

  const events = calendarEvents.filter(e => e.date === date);
  const schedules = calendarSchedules.filter(s => s.date === date);
  const productions = calendarProductions.filter(p => p.date === date);

  // [묶음 6B-2] 이벤트 항목마다 수정/삭제 버튼 — [묶음 6F] admin/office만 노출
  const eventsHtml = events.length === 0
    ? '<div class="cal-modal-empty">등록된 이벤트 없음</div>'
    : events.map(e => `
        <div class="cal-modal-list-item cal-event-item" data-event-id="${e.id}">
          <div class="cal-event-row">
            <span class="cal-event-title">📌 ${escapeHtmlMain(e.title || '')}</span>
            ${canEditCalendar ? `
              <span class="cal-event-actions">
                <button class="cal-event-btn" data-event-act="edit" data-event-id="${e.id}">수정</button>
                <button class="cal-event-btn cal-event-btn-danger" data-event-act="delete" data-event-id="${e.id}">삭제</button>
              </span>
            ` : ''}
          </div>
          ${e.content ? `<div class="cal-modal-list-sub">${escapeHtmlMain(e.content)}</div>` : ''}
        </div>
      `).join('');

  const schedulesHtml = schedules.length === 0
    ? '<div class="cal-modal-empty">예정 없음</div>'
    : schedules.map(s => `<div class="cal-modal-list-item">📦 ${escapeHtmlMain(formatScheduleLabel(s))}</div>`).join('');

  const productionsHtml = productions.length === 0
    ? '<div class="cal-modal-empty">생산 없음</div>'
    : productions.map(p => {
        const badge = p.batchNo ? ` <span style="color:#888;">(${p.batchNo}차)</span>`
                    : (p.round > 1 ? ` <span style="color:#888;">(${p.round}회차)</span>` : '');
        return `<div class="cal-modal-list-item">🏭 ${escapeHtmlMain(p.recipeName || '')}${badge}</div>`;
      }).join('');

  // [묶음 6B-2] 휴일 토글 — 토/일은 자동 잠금. [묶음 6F] production role도 잠금
  let holidayToggleHtml;
  if (isWeekend) {
    holidayToggleHtml = `<label class="cal-holiday-toggle" style="opacity:0.5;cursor:not-allowed;">
         <input type="checkbox" checked disabled> 휴일 (토/일은 자동)
       </label>`;
  } else if (!canEditCalendar) {
    holidayToggleHtml = `<label class="cal-holiday-toggle" style="opacity:0.5;cursor:not-allowed;" title="대표/사무실만 변경 가능">
         <input type="checkbox" ${isManualHoliday ? 'checked' : ''} disabled> 이 날을 휴일로 지정
       </label>`;
  } else {
    holidayToggleHtml = `<label class="cal-holiday-toggle">
         <input type="checkbox" id="chkManualHoliday" ${isManualHoliday ? 'checked' : ''}> 이 날을 휴일로 지정
       </label>`;
  }

  // [묶음 6F] [+ 이벤트 추가] 버튼은 admin/office만. production은 안내 텍스트로 대체
  const addEventBtnHtml = canEditCalendar
    ? `<button class="btn-secondary" id="btnAddEvent">+ 이벤트 추가</button>`
    : `<span style="color:#888;font-size:12px;align-self:center;">이벤트 등록은 대표/사무실만 가능</span>`;

  showModal(`
    <h3 style="margin:0 0 12px 0;font-size:16px;">${dateLabel} ${holidayPill}</h3>

    <div class="cal-modal-section">
      <div class="cal-modal-section-title">📌 이벤트</div>
      ${eventsHtml}
    </div>

    <div class="cal-modal-section">
      <div class="cal-modal-section-title">📦 입고 예정</div>
      ${schedulesHtml}
    </div>

    <div class="cal-modal-section">
      <div class="cal-modal-section-title">🏭 생산</div>
      ${productionsHtml}
    </div>

    <div class="cal-modal-section" style="border-top:1px solid #eee;padding-top:8px;">
      ${holidayToggleHtml}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">
      ${addEventBtnHtml}
      ${productions.length > 0
        ? `<button class="btn-secondary" id="btnViewThisDate">이 날짜로 보기</button>`
        : `<button class="btn-secondary" disabled title="생산 없음" style="opacity:0.5;cursor:not-allowed;">이 날짜로 보기</button>`}
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);

  // [묶음 6B-2] 이벤트 추가 / 수정 / 삭제 / 휴일 토글 바인딩 (권한 없으면 버튼 자체가 없음)
  document.getElementById('btnAddEvent')?.addEventListener('click', () => {
    showEventEditModal(date, null);
  });
  document.querySelectorAll('[data-event-act]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      const act = btn.dataset.eventAct;
      const id = btn.dataset.eventId;
      if (act === 'edit') {
        showEventEditModal(date, id);
      } else if (act === 'delete') {
        await deleteEvent(id, date);
      }
    });
  });
  document.getElementById('chkManualHoliday')?.addEventListener('change', async (ev) => {
    await toggleManualHoliday(date, ev.target.checked);
  });

  // [묶음 6E-4] 이 날짜로 보기 버튼 — selectedDate 모드 진입
  document.getElementById('btnViewThisDate')?.addEventListener('click', async () => {
    if (overdueClosingDate && date > overdueClosingDate) {
      alert(`${overdueClosingDate} 처리가 아직 끝나지 않았습니다.\n먼저 해당 날짜를 처리한 뒤 다음 날짜를 확인하세요.`);
      selectedProductionDate = null;
      selectedDateProductions = [];
      selectedDateBlockingData = null;
      closeModal();
      renderMainLayout();
      return;
    }
    selectedProductionDate = date;
    selectedDateProductions = calendarProductions.filter(p => p.date === date);
    selectedDateBlockingData = await getAllBlockingItems(date);
    closeModal();
    renderMainLayout();
  });
}

// 캘린더용 안전 처리 헬퍼 — 다른 페이지의 동명 함수와 충돌 방지 위해 Main 접미
function escapeHtmlMain(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}
function formatNumberMain(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}
function truncateMain(s, n) {
  if (!s) return '';
  return s.length > n ? s.substring(0, n) + '…' : s;
}

// ============================================================
// [묶음 6B-2] 이벤트 등록/수정/삭제 + 휴일 토글
// ============================================================

// 이벤트 등록(eventId=null) 또는 수정(eventId 지정) 모달
function showEventEditModal(date, eventId) {
  const isEdit = !!eventId;
  const existing = isEdit ? calendarEvents.find(e => e.id === eventId) : null;
  const title = existing?.title || '';
  const content = existing?.content || '';

  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const d = new Date(date + 'T00:00:00');
  const dateLabel = `${parseInt(date.split('-')[1])}월 ${parseInt(date.split('-')[2])}일 (${dayNames[d.getDay()]})`;

  showModal(`
    <h3 style="margin:0 0 12px 0;font-size:16px;">${isEdit ? '이벤트 수정' : '이벤트 등록'} — ${dateLabel}</h3>

    <div style="margin-bottom:10px;">
      <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">제목 (필수)</label>
      <input type="text" id="evTitle" maxlength="50" value="${escapeHtmlMain(title)}"
             style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;">
    </div>

    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">내용 (선택)</label>
      <textarea id="evContent" rows="3" maxlength="300"
                style="width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box;resize:vertical;">${escapeHtmlMain(content)}</textarea>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
      ${isEdit ? `<button class="btn-secondary" id="btnEvDelete" style="color:#c92a2a;border-color:#ffc9c9;">삭제</button>` : ''}
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnEvSave">${isEdit ? '저장' : '등록'}</button>
    </div>
  `);

  // 제목 인풋에 자동 포커스
  setTimeout(() => document.getElementById('evTitle')?.focus(), 50);

  document.getElementById('btnEvSave')?.addEventListener('click', async () => {
    const newTitle = document.getElementById('evTitle').value.trim();
    const newContent = document.getElementById('evContent').value.trim();
    if (!newTitle) {
      alert('제목을 입력해주세요.');
      return;
    }
    await saveEvent({ id: eventId, date, title: newTitle, content: newContent });
  });

  if (isEdit) {
    document.getElementById('btnEvDelete')?.addEventListener('click', async () => {
      const ok = await showConfirmModal({
        title: '이벤트 삭제',
        message: `"${title}" 이벤트를 삭제하시겠습니까?`,
        confirmText: '삭제',
        cancelText: '취소',
      });
      if (!ok) return;
      await deleteEvent(eventId, date);
    });
  }
}

// 이벤트 저장 (신규/수정 공용)
async function saveEvent({ id, date, title, content }) {
  try {
    if (id) {
      await updateDoc(doc(db, 'events', id), {
        title,
        content: content || '',
        updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(collection(db, 'events'), {
        date,
        title,
        content: content || '',
        createdAt: serverTimestamp(),
      });
    }
    closeModal();
    // 캘린더 데이터 다시 로드 + 화면 갱신 + 같은 날짜 모달 다시 열기
    await loadCalendarData(calendarWeekOffset);
    refreshCalendarUI();
    showDateModal(date);
  } catch (err) {
    console.error('[6B-2] 이벤트 저장 실패:', err);
    alert('저장 중 오류가 발생했습니다.');
  }
}

// 이벤트 삭제
async function deleteEvent(eventId, date) {
  const target = calendarEvents.find(e => e.id === eventId);
  if (!target) return;
  const ok = await showConfirmModal({
    title: '이벤트 삭제',
    message: `"${target.title || '(제목 없음)'}" 이벤트를 삭제하시겠습니까?`,
    confirmText: '삭제',
    cancelText: '취소',
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, 'events', eventId));
    closeModal();
    await loadCalendarData(calendarWeekOffset);
    refreshCalendarUI();
    showDateModal(date);
  } catch (err) {
    console.error('[6B-2] 이벤트 삭제 실패:', err);
    alert('삭제 중 오류가 발생했습니다.');
  }
}

// 수동 휴일 토글 — holidays 컬렉션 doc id = 'YYYY-MM-DD' 패턴 (utils/date.js 캐시와 동일)
// 수동 휴일 토글 — holidays 컬렉션 doc id = 'YYYY-MM-DD' 패턴 (utils/date.js 캐시와 동일)
async function toggleManualHoliday(date, makeHoliday) {
  try {
    if (makeHoliday) {
      await setDoc(doc(db, 'holidays', date), {
        date,
        holidayType: 'internalOff',
        title: '수동 휴일',
        label: '수동 휴일',
        affectsProduction: true,
        affectsShipping: true,
        shippingClosedFromEnabled: true,
        isAutoGenerated: false,
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(doc(db, 'holidays', date), {
        date,
        status: 'deleted',
        updatedAt: serverTimestamp(),
        deletedAt: serverTimestamp(),
      }, { merge: true });
    }
    // 캐시 다시 로드 → 캘린더 셀 색 즉시 반영
    await loadHolidaysCache();
    refreshCalendarUI();
  } catch (err) {
    console.error('[6B-2] 휴일 토글 실패:', err);
    alert('휴일 설정 중 오류가 발생했습니다.');
  }
}

// 캘린더 본문만 다시 그림 (모달 외부 갱신용. refreshCalendar와 달리 데이터 재로드 안 함)
function refreshCalendarUI() {
  const body = document.querySelector('.main-calendar-body');
  if (!body) return;
  body.innerHTML = renderCalendar();
  bindCalendarEvents();
}

// ============================================================
// [묶음 6C-1A] 로그 패널 — 차단 영역 + 사무 로그 + 확인 동작
// ============================================================

// 사무 로그 카테고리 — 현재 발행 중인 8개 action
const OFFICE_LOG_ACTIONS = ['bag', 'egg', 'meat', 'frozenProduct', 'frozenSep', 'schedule', 'frozenPan', 'closing', 'supplementStock', 'recipe', 'settings', 'holiday', 'conversion'];

// 생산 로그 카테고리 — production은 6C-2 신규, 나머지는 6C-3 자동 발행 예정
const PRODUCTION_LOG_ACTIONS = ['production', 'repackaging', 'pretreat', 'event', 'scheduleDue', 'autoRepack', 'minStock', 'frozenStockLow'];

// [묶음 6C-2] action:subAction 단위 카테고리 오버라이드
// action만으로 결정 안 되는 경우. meat은 사무(입출고)+생산(adjust) 혼재 → adjust만 생산으로.
const LOG_CATEGORY_OVERRIDE = {
  'meat:adjust': 'production',  // 원육 수동 조정 (3개 탭 모두) — 운영자 결정 ① A
};

// 확인 필수 (acknowledged 필수, 상단 고정 + [모두 확인]에서 제외)
const REQUIRES_ACK_KEYS = new Set([
  'scheduleDue:trigger',     // 입고 예정일 도래 (자동 — 6C-3)
  'autoRepack:trigger',      // 생산 자동 재포장 (자동 — 6C-3)
  'autoRepack:diff',         // 자동 재포장 차이 발생 로그
  'minStock:alert',          // 최소재고 미달 (자동 — 6C-3)
  'frozenStockLow:alert',    // 냉동창고 잔량 부족 (자동 — 6C-3)
  'schedule:completeDiff',   // [묶음 6C-2] 입고 완료 차이 있음
  'closing:refresh',         // [묶음 6E-3] 마감 새로고침 (롤백+재차감)
]);

// 로그 → '사무'/'생산'/'무시' 분류 — action:subAction 오버라이드 우선
function classifyLog(log) {
  const key = `${log.action}:${log.subAction}`;
  if (LOG_CATEGORY_OVERRIDE[key]) return LOG_CATEGORY_OVERRIDE[key];
  if (PRODUCTION_LOG_ACTIONS.includes(log.action)) return 'production';
  if (OFFICE_LOG_ACTIONS.includes(log.action)) return 'office';
  return 'ignore';
}

function logRequiresAck(log) {
  return REQUIRES_ACK_KEYS.has(`${log.action}:${log.subAction}`);
}

// N일 전 KST 날짜 문자열
function getDateNDaysAgoKST(n) {
  const now = new Date();
  const past = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kst = new Date(past.getTime() + KST_OFFSET_MS);
  return kst.toISOString().split('T')[0];
}

// 당일 전체 + 어제~10일 전 미확인(확인 필수)만 합쳐 시간순 정렬
async function loadCombinedLogs() {
  const today = getToday();
  const tenDaysAgo = getDateNDaysAgoKST(10);

  // 당일 전체
  let todayLogs = [];
  try {
    const todaySnap = await getDocs(query(
      collection(db, 'activityLogs'),
      where('date', '==', today),
    ));
    todayLogs = todaySnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[6C-1] 당일 로그 로드 실패:', err);
  }

  // 어제 이전 ~ 10일 전 (date 범위)
  let olderLogs = [];
  try {
    const olderSnap = await getDocs(query(
      collection(db, 'activityLogs'),
      where('date', '>=', tenDaysAgo),
      where('date', '<', today),
    ));
    olderLogs = olderSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(log => log.acknowledged !== true && logRequiresAck(log));
  } catch (err) {
    console.error('[6C-1] 과거 로그 로드 실패:', err);
  }

  // timestamp 기준 내림차순 (서버 timestamp가 null인 신규 로그는 맨 위)
  combinedLogs = [...todayLogs, ...olderLogs].sort((a, b) => {
    const ta = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
    const tb = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
    return tb - ta;
  });
}

// 차단 영역 (패널 최상단 고정) — 기존 renderQuickInfo 흡수
function renderBlockerArea(data = blockingData) {
  const cards = [];

  // 차단 항목 (빨강)
  (data.items || []).forEach(it => {
    cards.push(`
      <div class="alert-card alert-card-blocker">
        <span class="alert-card-label">⛔ ${it.reason || it.label}</span>
        <button class="alert-card-jump" data-jump="${it.jumpMenu}">처리하러 가기 →</button>
      </div>
    `);
  });

  // 계란 부족 경고 (노랑) — 묶음 6C-3에서 minStock:alert 자동 발행으로 마이그레이션 예정
  if (eggStock.minimumQty > 0 && eggStock.currentQty < eggStock.minimumQty) {
    cards.push(`
      <div class="alert-card alert-card-warning">
        <span class="alert-card-label">⚠️ 계란 부족 (현재: ${eggStock.currentQty}개 / 최소: ${eggStock.minimumQty}개)</span>
        <button class="alert-card-jump" data-jump="egg">처리하러 가기 →</button>
      </div>
    `);
  }

  if (cards.length === 0) return '';

  return `
    <div class="log-blocker-area">
      ${cards.join('')}
    </div>
  `;
}

// 로그 섹션 1개 (생산 또는 사무) — 패널 헤더 + 행 목록
function renderLogSection(category) {
  const title = category === 'production' ? '🏭 생산 로그' : '🗒️ 사무 로그';
  const sectionLogs = combinedLogs
    .filter(log => classifyLog(log) === category);

  // 확인 필수 + 미확인 → 위로 / 나머지 → 시간순
  sectionLogs.sort((a, b) => {
    const aPin = (logRequiresAck(a) && a.acknowledged !== true) ? 1 : 0;
    const bPin = (logRequiresAck(b) && b.acknowledged !== true) ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const ta = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
    const tb = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
    return tb - ta;
  });

  // 미확인 일반 로그가 있으면 [모두 확인] 활성화 — 확인 필수는 일괄에서 제외 (개별 처리 강제)
  const hasUnackGeneral = sectionLogs.some(l => l.acknowledged !== true && !logRequiresAck(l));

  const rowsHtml = sectionLogs.length === 0
    ? `<div class="log-empty">${category === 'production' ? '오늘 생산 로그 없음' : '오늘 사무 로그 없음'}</div>`
    : sectionLogs.map(log => renderLogRow(log)).join('');

  return `
    <div class="log-section">
      <div class="log-section-header">
        <span class="log-section-title">${title}</span>
        <div class="log-section-actions">
          <button class="log-action-btn" data-log-act="ackAll" data-log-cat="${category}" ${hasUnackGeneral ? '' : 'disabled'}>모두 확인</button>
          <button class="log-action-btn" data-log-act="all" data-log-cat="${category}">전체보기</button>
          <button class="log-action-btn" data-log-act="history" data-log-cat="${category}">히스토리</button>
        </div>
      </div>
      <div class="log-section-body">
        ${rowsHtml}
      </div>
    </div>
  `;
}

// 로그 행 1개
function renderLogRow(log) {
  const isUnack = (log.acknowledged !== true);
  const isCritical = logRequiresAck(log);
  const today = getToday();
  const yesterday = getYesterdayKST();

  let dateLabel;
  if (log.date === today) {
    dateLabel = formatLogTime(log.timestamp);
  } else if (log.date === yesterday) {
    dateLabel = '어제';
  } else {
    const parts = (log.date || '').split('-');
    dateLabel = parts.length === 3 ? `${parseInt(parts[1])}/${parseInt(parts[2])}` : (log.date || '');
  }

  const cls = [
    'log-row',
    isUnack ? 'log-row-unack' : '',
    isCritical ? 'log-row-critical' : '',
  ].filter(Boolean).join(' ');

  const ackBtn = isUnack
    ? `<button class="log-ack-btn" data-log-act="ack" data-log-id="${log.id}">확인</button>`
    : `<span class="log-ack-done" title="${log.acknowledgedBy || ''} 확인">✓</span>`;

  const criticalBadge = isCritical && isUnack ? '<span class="log-critical-badge">⚠️</span>' : '';
  const message = getDisplayLogMessage(log);

  return `
    <div class="${cls}">
      <span class="log-row-time">${dateLabel}</span>
      <span class="log-row-msg">${criticalBadge}${escapeHtmlMain(message)}</span>
      <span class="log-row-action">${ackBtn}</span>
    </div>
  `;
}

function formatLogGrams(value) {
  const g = Number(value || 0);
  if (g > 9999) return `${(g / 1000).toFixed(2)}kg`;
  return `${g.toLocaleString()}g`;
}

function formatScheduleLogQty(qty, unit, unitGrams) {
  if (unit === 'g') return formatLogGrams(qty);
  const base = `${qty}${unit}`;
  if (unit !== '마리' || !unitGrams) return base;
  return `${base} (${formatLogGrams(Number(qty || 0) * Number(unitGrams || 0))})`;
}

function getDisplayLogMessage(log) {
  if (log.action !== 'schedule' || log.subAction !== 'completeDiff') {
    return log.message || '(메시지 없음)';
  }

  const d = log.details || {};
  if (d.orderedQty == null || d.actualQty == null) return log.message || '(메시지 없음)';

  const orderedUnit = d.orderedUnit || d.unit || '';
  const actualUnit = d.unit || orderedUnit;
  const orderedText = formatScheduleLogQty(d.orderedQty, orderedUnit, d.orderedUnitGrams);
  const actualText = formatScheduleLogQty(d.actualQty, actualUnit, d.orderedUnitGrams);
  const itemName = d.itemName || '입고 예정';
  const staff = log.staff || '';
  return `${itemName} 입고 완료 ⚠️ 발주 ${orderedText} → 실제 ${actualText}${staff ? ` / 담당: ${staff}` : ''}`;
}

// 로그 timestamp → "HH:MM"
function formatLogTime(ts) {
  if (!ts || !ts.toMillis) return '—';
  const d = new Date(ts.toMillis());
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kst = new Date(d.getTime() + KST_OFFSET_MS);
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const m = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// currentUserRole → 한국어 라벨
function getStaffLabelFromRole() {
  if (currentUserRole === 'admin') return '대표';
  if (currentUserRole === 'office') return '사무실';
  if (currentUserRole === 'production') return '생산실';
  return '운영자';
}

// 로그 패널 [확인] / [모두 확인] / [전체보기] / [히스토리] 바인딩
function bindLogActions() {
  document.querySelectorAll('[data-log-act="ack"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const logId = btn.dataset.logId;
      await ackOneLog(logId);
    });
  });
  document.querySelectorAll('[data-log-act="ackAll"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = btn.dataset.logCat;
      await ackAllInSection(cat);
    });
  });
  // [묶음 6C-1B] 전체보기 / 히스토리
  document.querySelectorAll('[data-log-act="all"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.logCat;
      showAllLogsModal(cat);
    });
  });
  document.querySelectorAll('[data-log-act="history"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.logCat;
      showHistoryLogsModal(cat);
    });
  });
}

// [확인] 단건
async function ackOneLog(logId) {
  try {
    const logSnap = await getDoc(doc(db, 'activityLogs', logId));
    if (!logSnap.exists()) {
      alert('로그를 찾을 수 없습니다.');
      return;
    }

    const log = { id: logId, ...logSnap.data() };
    if (log.action === 'autoRepack' && log.subAction === 'trigger' && log.acknowledged !== true) {
      await showAutoRepackConfirmModal(logId, log);
      return;
    }

    await acknowledgeLog(logId, getStaffLabelFromRole());
    await loadCombinedLogs();
    refreshLogPanels();
  } catch (err) {
    console.error('[6C-1] 확인 처리 실패:', err);
    alert('확인 처리 중 오류가 발생했습니다.');
  }
}

// ============================================================
// [묶음 9 #9] 자동 재포장 확인 모달 + 차이 처리
// ============================================================

async function getLeadStaffOptionNames() {
  const staffSnap = await getDoc(doc(db, 'staffGroups', 'lead'));
  const members = staffSnap.exists() ? staffSnap.data().members || [] : [];
  return members
    .filter(m => m && m.active !== false && m.name)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map(m => m.name);
}

async function showAutoRepackConfirmModal(logId, log) {
  if (currentUserRole === 'office') {
    alert('자동 재포장 확인은 생산실/대표 계정에서만 처리할 수 있습니다.');
    return;
  }

  const d = log.details || {};
  const meatName = d.meatName || '?';
  const surplusG = Number(d.surplusG) || 0;
  const processedUnitWeightG = Number(d.processedUnitWeightG) || 0;
  const repackedStockId = d.repackedStockId;
  const mode = d.mode;

  if (!repackedStockId || !processedUnitWeightG) {
    alert('자동 재포장 로그 데이터가 손상되어 처리할 수 없습니다. (운영자에게 문의)');
    return;
  }

  const refCount = surplusG / processedUnitWeightG;
  const refCountDisplay = Number.isInteger(refCount)
    ? `${refCount}개`
    : `약 ${refCount.toFixed(2)}개`;
  const staffOptions = await getLeadStaffOptionNames();

  if (staffOptions.length === 0) {
    alert('주임 그룹 담당자가 등록되어 있지 않습니다. 설정에서 추가해주세요.');
    return;
  }

  const html = `
    <div style="padding:16px; min-width:440px; max-width:560px;">
      <h3 style="margin:0 0 12px;">자동 재포장 확인 — ${escapeHtmlMain(meatName)}</h3>
      <div style="background:#f5f5f5; padding:12px; border-radius:4px; margin-bottom:16px; line-height:1.7;">
        <div><b>시스템 자동 재포장 수량 (수정 불가)</b></div>
        <div style="font-size:15px; font-weight:600; color:#1f2937;">${formatNumberMain(surplusG)}g (${(surplusG / 1000).toFixed(2)}kg)</div>
        <div style="font-size:13px; color:#6b7280; margin-top:4px;">
          단위중량 ${formatNumberMain(processedUnitWeightG)}g 기준 ${refCountDisplay}<br>
          모드: ${mode === 'merged' ? '기존 lot 합산' : '신규 lot 생성'}
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block; margin-bottom:4px;"><b>실제 재포장 수량 (개)</b></label>
        <input type="number" id="ar-actual-count" min="0" step="1" value="" placeholder="실제 만든 개수 입력" style="width:100%; padding:8px; box-sizing:border-box;">
        <div id="ar-actual-g" style="font-size:13px; color:#6b7280; margin-top:4px;">→ 개수 입력 시 환산 g 자동 표시</div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block; margin-bottom:4px;"><b>실제 재포장 담당자 (주임)</b></label>
        <select id="ar-staff" style="width:100%; padding:8px; box-sizing:border-box;">
          <option value="">담당자 선택...</option>
          ${staffOptions.map(s => `<option value="${escapeHtmlMain(s)}">${escapeHtmlMain(s)}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="ar-cancel" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">취소</button>
        <button id="ar-confirm" style="padding:8px 16px; background:#2563eb; color:white; border:none; border-radius:4px; cursor:pointer;">확인</button>
      </div>
    </div>
  `;

  showModal(html);

  const inputEl = document.getElementById('ar-actual-count');
  const gDisplay = document.getElementById('ar-actual-g');

  inputEl.addEventListener('input', () => {
    const cnt = parseInt(inputEl.value, 10);
    if (isNaN(cnt) || cnt < 0) {
      gDisplay.textContent = '→ 개수 입력 시 환산 g 자동 표시';
      return;
    }
    const actualG = cnt * processedUnitWeightG;
    const diffG = actualG - surplusG;
    const diffText = diffG === 0 ? ' (시스템과 동일)' : ` (차이 ${diffG > 0 ? '+' : ''}${formatNumberMain(diffG)}g)`;
    gDisplay.textContent = `→ ${formatNumberMain(actualG)}g (${(actualG / 1000).toFixed(2)}kg)${diffText}`;
  });

  document.getElementById('ar-cancel').addEventListener('click', () => {
    closeModal();
  });

  document.getElementById('ar-confirm').addEventListener('click', async () => {
    const actualCount = parseInt(inputEl.value, 10);
    const staffName = document.getElementById('ar-staff').value;

    if (!staffName) {
      alert('담당자를 선택해주세요.');
      return;
    }
    if (isNaN(actualCount) || actualCount < 0) {
      alert('실제 수량은 0 이상의 정수여야 합니다.');
      return;
    }
    if (actualCount === 0) {
      const ok = await showConfirmModal({
        title: '실제 재포장 수량 0개',
        message: '실제 재포장 수량이 0개입니다.\n자동 재포장 lot을 0g으로 만들고 마감 처리합니다.\n진행할까요?',
        confirmText: '진행',
        cancelText: '취소',
        danger: true,
      });
      if (!ok) return;
    }

    closeModal();
    try {
      await processAutoRepackConfirm({ logId, log, actualCount, surplusG, processedUnitWeightG, staffName });
    } catch (err) {
      console.error('[묶음 9 #9] 자동 재포장 확인 처리 실패:', err);
      alert('확인 처리 중 오류가 발생했습니다: ' + (err.message || err));
    }
  });
}

async function processAutoRepackConfirm({ logId, log, actualCount, surplusG, processedUnitWeightG, staffName }) {
  const d = log.details || {};
  const repackedStockId = d.repackedStockId;
  const meatTypeId = d.meatTypeId;
  const meatName = d.meatName;
  const today = getToday();
  const actualG = actualCount * processedUnitWeightG;
  const diffG = actualG - surplusG;

  if (diffG === 0) {
    await acknowledgeLog(logId, staffName);
    await loadCombinedLogs();
    refreshLogPanels();
    return;
  }

  const lotRef = doc(db, 'meatStocks', repackedStockId);
  const lotSnap = await getDoc(lotRef);
  if (!lotSnap.exists()) throw new Error('자동 재포장 lot 문서를 찾을 수 없습니다.');

  const lot = lotSnap.data();
  const currentRemaining = Number(lot.remaining) || 0;
  const newRemaining = currentRemaining + diffG;
  if (newRemaining < 0) {
    throw new Error(`자동 재포장 lot 잔량이 음수가 됩니다 (현재 ${currentRemaining}g, 보정 ${diffG}g).`);
  }

  await updateDoc(lotRef, {
    remaining: newRemaining,
    closed: actualCount === 0 && newRemaining === 0,
    updatedAt: new Date(),
  });

  await recordActivity({
    action: 'autoRepack',
    subAction: 'diff',
    date: today,
    staff: staffName,
    message: `자동 재포장 차이 — ${meatName} 시스템 ${surplusG}g / 실제 ${actualG}g (${diffG > 0 ? '+' : ''}${diffG}g) — 담당: ${staffName}`,
    details: {
      meatTypeId,
      meatName,
      repackedStockId,
      processedUnitWeightG,
      systemG: surplusG,
      actualCount,
      actualG,
      diffG,
      sourceLogId: logId,
    },
  });

  await acknowledgeLog(logId, staffName);
  await loadCombinedLogs();
  refreshLogPanels();
}

// [모두 확인] 섹션 — 확인 필수 제외, 일반 미확인만 일괄
async function ackAllInSection(category) {
  const targets = combinedLogs.filter(log =>
    classifyLog(log) === category &&
    log.acknowledged !== true &&
    !logRequiresAck(log)
  );
  if (targets.length === 0) return;

  const ok = await showConfirmModal({
    title: '모두 확인',
    message: `${category === 'production' ? '생산' : '사무'} 로그 ${targets.length}건을 모두 확인 처리하시겠습니까?\n(확인 필수 항목은 제외됩니다)`,
    confirmText: '확인 처리',
    cancelText: '취소',
  });
  if (!ok) return;

  try {
    const staffLabel = getStaffLabelFromRole();
    await Promise.all(targets.map(log => acknowledgeLog(log.id, staffLabel)));
    await loadCombinedLogs();
    refreshLogPanels();
  } catch (err) {
    console.error('[6C-1] 모두 확인 실패:', err);
    alert('일괄 확인 중 오류가 발생했습니다.');
  }
}

// 로그 섹션 2개 + 차단 영역 다시 그림 (메인 전체 재로드 안 함)
function refreshLogPanels() {
  const panel = document.querySelector('.main-panel-3');
  if (!panel) return;
  panel.innerHTML = `
    ${renderBlockerArea()}
    ${renderLogSection('production')}
    ${renderLogSection('office')}
  `;
  // 차단 영역 점프 버튼 + 로그 액션 다시 바인딩
  document.querySelectorAll('.main-panel-3 .alert-card-jump').forEach(btn => {
    btn.addEventListener('click', () => {
      const menuId = btn.dataset.jump;
      setCurrentMenu(menuId);
      renderLayout();
      renderPage(menuId);
    });
  });
  bindLogActions();
}

// ============================================================
// [묶음 6C-1B] 전체보기 / 히스토리 모달
// ============================================================

// 모달 상태 (모듈 레벨)
let modalLogs = [];           // 현재 모달에 표시된 로그
let modalCategory = null;     // 'production' | 'office'
let modalSearch = '';         // 검색어
let modalMode = 'all';        // 'all' (10일치) | 'history' (전체)
let historyLastDoc = null;    // 히스토리 페이지네이션 cursor
let historyDoneFlag = false;  // 더 가져올 데이터 없음

// [전체보기] — 10일치 로그
async function showAllLogsModal(category) {
  modalCategory = category;
  modalMode = 'all';
  modalSearch = '';
  modalLogs = [];

  await loadAllLogsForModal();
  showModalShell();
}

// [히스토리] — 전체 기간 (limit 100 + 더 보기)
async function showHistoryLogsModal(category) {
  modalCategory = category;
  modalMode = 'history';
  modalSearch = '';
  modalLogs = [];
  historyLastDoc = null;
  historyDoneFlag = false;

  await loadHistoryPage();
  showModalShell();
}

// 10일치 로그 로드 (전체보기용)
async function loadAllLogsForModal() {
  const today = getToday();
  const tenDaysAgo = getDateNDaysAgoKST(10);
  try {
    const snap = await getDocs(query(
      collection(db, 'activityLogs'),
      where('date', '>=', tenDaysAgo),
      where('date', '<=', today),
    ));
    modalLogs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(log => classifyLog(log) === modalCategory)
      .sort((a, b) => {
        const ta = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
        const tb = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
        return tb - ta;
      });
  } catch (err) {
    console.error('[6C-1B] 전체보기 로드 실패:', err);
    alert('전체보기 로드 실패: 관리자에게 문의해주세요.');
  }
}

// 히스토리 한 페이지(100건) 로드 — 누적
async function loadHistoryPage() {
  if (historyDoneFlag) return;

  try {
    const PAGE_SIZE = 100;
    const constraints = [orderBy('timestamp', 'desc'), limit(PAGE_SIZE)];
    if (historyLastDoc) constraints.push(startAfter(historyLastDoc));

    const snap = await getDocs(query(collection(db, 'activityLogs'), ...constraints));
    if (snap.docs.length < PAGE_SIZE) historyDoneFlag = true;
    if (snap.docs.length > 0) {
      historyLastDoc = snap.docs[snap.docs.length - 1];
    }

    const newLogs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(log => classifyLog(log) === modalCategory);

    modalLogs = [...modalLogs, ...newLogs];
  } catch (err) {
    console.error('[6C-1B] 히스토리 로드 실패:', err);
    alert('히스토리 로드 실패: 관리자에게 문의해주세요.');
  }
}

// 모달 골격 (전체보기/히스토리 공용)
function showModalShell() {
  const titlePrefix = modalMode === 'all' ? '전체보기 (10일)' : '히스토리 (전체)';
  const catLabel = modalCategory === 'production' ? '생산 로그' : '사무 로그';

  const switchBtn = modalMode === 'all'
    ? `<button class="btn-secondary" id="btnLogModalSwitch" style="font-size:11px;">히스토리로 전환 →</button>`
    : '';

  showModal(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <h3 style="margin:0;font-size:15px;">${catLabel} — ${titlePrefix}</h3>
      ${switchBtn}
    </div>

    <div style="margin-bottom:8px;">
      <input type="text" id="logModalSearch" placeholder="메시지 검색 (담당자명, 품목명 등)"
             style="width:100%;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box;"
             value="${escapeHtmlMain(modalSearch)}">
    </div>

    <div id="logModalList" class="log-modal-list">
      ${renderModalLogList()}
    </div>

    <div id="logModalFooter" style="display:flex;gap:8px;justify-content:space-between;margin-top:12px;">
      <div>
        ${modalMode === 'history' && !historyDoneFlag
          ? `<button class="btn-secondary" id="btnLogMore" style="font-size:11px;">+ 더 보기 (100건)</button>`
          : ''}
      </div>
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);

  // 검색 입력 — 디바운스 없이 즉시 (클라이언트 필터)
  document.getElementById('logModalSearch')?.addEventListener('input', (ev) => {
    modalSearch = ev.target.value;
    refreshModalList();
  });

  // 더 보기
  document.getElementById('btnLogMore')?.addEventListener('click', async () => {
    await loadHistoryPage();
    refreshModalList();
    refreshModalFooter();
  });

  // 히스토리로 전환
  document.getElementById('btnLogModalSwitch')?.addEventListener('click', async () => {
    modalMode = 'history';
    modalSearch = '';
    modalLogs = [];
    historyLastDoc = null;
    historyDoneFlag = false;
    await loadHistoryPage();
    showModalShell();
  });

  // 모달 안의 [확인] 버튼
  bindModalAckButtons();
}

// 모달 리스트 영역만 다시 그림 (검색/확인 처리 후)
function refreshModalList() {
  const list = document.getElementById('logModalList');
  if (!list) return;
  list.innerHTML = renderModalLogList();
  bindModalAckButtons();
}

// 모달 푸터 다시 그림 (더 보기 버튼 상태 변경 시)
function refreshModalFooter() {
  const footer = document.getElementById('logModalFooter');
  if (!footer) return;
  footer.innerHTML = `
    <div>
      ${modalMode === 'history' && !historyDoneFlag
        ? `<button class="btn-secondary" id="btnLogMore" style="font-size:11px;">+ 더 보기 (100건)</button>`
        : ''}
    </div>
    <button class="btn-secondary" onclick="closeModal()">닫기</button>
  `;
  document.getElementById('btnLogMore')?.addEventListener('click', async () => {
    await loadHistoryPage();
    refreshModalList();
    refreshModalFooter();
  });
}

// 모달 리스트 HTML
function renderModalLogList() {
  const search = modalSearch.trim().toLowerCase();
  const filtered = search
    ? modalLogs.filter(log => (log.message || '').toLowerCase().includes(search))
    : modalLogs;

  if (filtered.length === 0) {
    return `<div class="log-empty" style="padding:24px 8px;">${search ? '검색 결과 없음' : '표시할 로그 없음'}</div>`;
  }

  // 날짜별 그룹 헤더
  let lastDate = null;
  const blocks = [];
  filtered.forEach(log => {
    if (log.date !== lastDate) {
      lastDate = log.date;
      const today = getToday();
      const yesterday = getYesterdayKST();
      let dateLabel;
      if (log.date === today) dateLabel = '오늘';
      else if (log.date === yesterday) dateLabel = '어제';
      else {
        const parts = (log.date || '').split('-');
        dateLabel = parts.length === 3 ? `${parseInt(parts[0])}.${parseInt(parts[1])}.${parseInt(parts[2])}` : (log.date || '');
      }
      blocks.push(`<div class="log-modal-date-header">${dateLabel}</div>`);
    }
    blocks.push(renderModalLogRow(log));
  });

  return blocks.join('');
}

// 모달 안 로그 행 1개 (메인 패널의 행과 비슷하지만 시간 항상 표시)
function renderModalLogRow(log) {
  const isUnack = (log.acknowledged !== true);
  const isCritical = logRequiresAck(log);
  const timeLabel = formatLogTime(log.timestamp);

  const cls = [
    'log-modal-row',
    isUnack ? 'log-row-unack' : '',
    isCritical ? 'log-row-critical' : '',
  ].filter(Boolean).join(' ');

  const ackBtn = isUnack
    ? `<button class="log-ack-btn" data-modal-log-act="ack" data-log-id="${log.id}">확인</button>`
    : `<span class="log-ack-done" title="${log.acknowledgedBy || ''} 확인">✓ ${escapeHtmlMain(log.acknowledgedBy || '')}</span>`;

  const criticalBadge = isCritical && isUnack ? '<span class="log-critical-badge">⚠️</span>' : '';
  const message = getDisplayLogMessage(log);

  return `
    <div class="${cls}">
      <span class="log-row-time">${timeLabel}</span>
      <span class="log-row-msg">${criticalBadge}${escapeHtmlMain(message)}</span>
      <span class="log-row-action">${ackBtn}</span>
    </div>
  `;
}

// 모달 안의 [확인] 버튼 바인딩
function bindModalAckButtons() {
  document.querySelectorAll('[data-modal-log-act="ack"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const logId = btn.dataset.logId;
      try {
        const target = modalLogs.find(l => l.id === logId);
        if (target && target.action === 'autoRepack' && target.subAction === 'trigger' && target.acknowledged !== true) {
          await showAutoRepackConfirmModal(logId, target);
          return;
        }

        await acknowledgeLog(logId, getStaffLabelFromRole());
        // 모달 데이터 안에서 해당 로그도 갱신
        if (target) {
          target.acknowledged = true;
          target.acknowledgedBy = getStaffLabelFromRole();
        }
        // 메인 패널도 갱신 (당일 로그라면 영향)
        await loadCombinedLogs();
        refreshLogPanels();
        refreshModalList();
      } catch (err) {
        console.error('[6C-1B] 모달 확인 처리 실패:', err);
        alert('확인 처리 중 오류가 발생했습니다.');
      }
    });
  });
}

// ============================================================
// [묶음 6C-3] 자동 발행 — 메인 진입 시 점검 후 신규 로그 발행
// ============================================================

// 자동 발행 dedup — 같은 (action, subAction, date, dedupKey) 이미 있으면 skip.
// [묶음 6F] race condition 방지 — deterministic 문서 ID + setDoc 사용.
//   같은 사유면 항상 같은 문서 ID → 두 호출이 거의 동시에 발생해도 setDoc 덮어쓰기로 1건만 남음.
//   addDoc 시절엔 매번 랜덤 ID 생성돼서 race condition으로 중복 발행 가능했음.
// recordActivity 직접 호출하지 않고 setDoc 사용 — staff='시스템'은 currentUser 검증 우회 필요.
async function ensureAutoLog({ action, subAction, date, message, details, dedupKey }) {
  try {
    // 문서 ID — Firestore 허용 문자(영숫자/언더스코어/하이픈)만 남김
    const safeKey = `${action}_${subAction}_${date}_${dedupKey}`.replace(/[^\w-]/g, '_');
    const docId = `auto_${safeKey}`;
    const ref = doc(db, 'activityLogs', docId);

    // 1차 체크: 같은 ID 문서 존재 여부 (deterministic이라 단일 doc 조회로 빠름)
    const existing = await getDoc(ref);
    if (existing.exists()) return;

    // setDoc — 두 번 호출돼도 같은 ID에 덮어쓰기 → 1건만 존재
    await setDoc(ref, {
      action, subAction, date,
      staff: '시스템',
      uid: null,
      timestamp: serverTimestamp(),
      message,
      details: { ...(details || {}), dedupKey, autoTriggered: true },
      read: false,
      acknowledged: false,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgedByUid: null,
    });
  } catch (err) {
    console.error('[6C-3] 자동 발행 실패:', err);
  }
}

// 1. 📅 이벤트 당일 — events 컬렉션에서 date=today인 이벤트 1건당 1로그 (운영자 결정 ④ A)
async function triggerEventDueLogs(today) {
  try {
    const snap = await getDocs(query(
      collection(db, 'events'),
      where('date', '==', today),
    ));
    for (const evDoc of snap.docs) {
      const ev = { id: evDoc.id, ...evDoc.data() };
      await ensureAutoLog({
        action: 'event',
        subAction: 'dueToday',
        date: today,
        message: `📅 오늘 일정 — ${ev.title || '(제목 없음)'}`,
        details: { eventId: ev.id, title: ev.title || '' },
        dedupKey: `event:${ev.id}`,
      });
    }
  } catch (err) {
    // events 컬렉션 빈 채로 시작했을 때 정상
    console.warn('[6C-3] 이벤트 자동 발행 skip:', err.message);
  }
}

// 2. 📦 입고 예정일 도래 — schedules에서 date=today && status=scheduled (확인 필수)
async function triggerScheduleDueLogs(today) {
  try {
    const snap = await getDocs(query(
      collection(db, 'schedules'),
      where('date', '==', today),
    ));
    for (const sDoc of snap.docs) {
      const s = { id: sDoc.id, ...sDoc.data() };
      if (s.status !== 'scheduled') continue;
      const itemLabel = s.type === 'egg' ? '계란' : (s.itemNameSnapshot || '(품목)');
      await ensureAutoLog({
        action: 'scheduleDue',
        subAction: 'trigger',
        date: today,
        message: `📦 입고 예정일 도래 — ${itemLabel} ${s.orderedQty}${s.orderedUnit}`,
        details: {
          scheduleId: s.id,
          type: s.type,
          itemName: s.itemNameSnapshot,
          orderedQty: s.orderedQty,
          orderedUnit: s.orderedUnit,
        },
        dedupKey: `scheduleDue:${s.id}`,
      });
    }
  } catch (err) {
    console.error('[6C-3] 입고 예정 자동 발행 실패:', err);
  }
}

// 3. ⚠️ 최소재고 미달 — 계란 + 원육 + 봉투 (확인 필수, date=today로 dedup하니 매일 자동 반복)
async function triggerMinStockLogs(today) {
  try {
    // 계란
    if (eggStock.minimumQty > 0 && eggStock.currentQty < eggStock.minimumQty) {
      await ensureAutoLog({
        action: 'minStock',
        subAction: 'alert',
        date: today,
        message: `⚠️ 계란 부족 — 현재 ${eggStock.currentQty}개 / 최소 ${eggStock.minimumQty}개`,
        details: { kind: 'egg', current: eggStock.currentQty, minimum: eggStock.minimumQty },
        dedupKey: `minStock:egg`,
      });
    }

    // 원육 — meatTypes의 minimumQtyG 미달 (해당 type의 모든 stock remaining 합산)
    const mtSnap = await getDocs(collection(db, 'meatTypes'));
    const msSnap = await getDocs(collection(db, 'meatStocks'));
    const meatStocksData = msSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => !s.closed);

    for (const mtDoc of mtSnap.docs) {
      const mt = { id: mtDoc.id, ...mtDoc.data() };
      if (!mt.minimumQtyG) continue;
      const total = meatStocksData
        .filter(s => s.meatTypeId === mt.id)
        .reduce((sum, s) => sum + (s.remaining || 0), 0);
      if (total < mt.minimumQtyG) {
        await ensureAutoLog({
          action: 'minStock',
          subAction: 'alert',
          date: today,
          message: `⚠️ ${mt.name || '원육'} 부족 — 현재 ${(total/1000).toFixed(1)}kg / 최소 ${(mt.minimumQtyG/1000).toFixed(1)}kg`,
          details: { kind: 'meat', meatTypeId: mt.id, name: mt.name, current: total, minimum: mt.minimumQtyG },
          dedupKey: `minStock:meat:${mt.id}`,
        });
      }
    }

    // 봉투
    const bagSnap = await getDocs(collection(db, 'bagTypes'));
    for (const bDoc of bagSnap.docs) {
      const b = { id: bDoc.id, ...bDoc.data() };
      if (b.minimumQty && (b.currentQty || 0) < b.minimumQty) {
        await ensureAutoLog({
          action: 'minStock',
          subAction: 'alert',
          date: today,
          message: `⚠️ ${b.name || '봉투'} 부족 — 현재 ${b.currentQty || 0}장 / 최소 ${b.minimumQty}장`,
          details: { kind: 'bag', bagTypeId: b.id, name: b.name, current: b.currentQty || 0, minimum: b.minimumQty },
          dedupKey: `minStock:bag:${b.id}`,
        });
      }
    }

    const supplementTypesSnap = await getDocs(query(
      collection(db, 'supplementTypes'),
      where('active', '==', true),
    ));
    const supplementStockSnap = await getDocs(collection(db, 'supplementStock'));
    const supplementStockMap = new Map(
      supplementStockSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }])
    );
    const supplementMinQty = 5;

    for (const typeDoc of supplementTypesSnap.docs) {
      const type = { id: typeDoc.id, ...typeDoc.data() };
      const stock = supplementStockMap.get(type.id);
      const currentQty = stock ? Number(stock.currentQty || 0) : 0;
      if (currentQty >= supplementMinQty) continue;
      await ensureAutoLog({
        action: 'minStock',
        subAction: 'alert',
        date: today,
        message: `⚠️ ${type.name || '영양제'} 부족 — 현재 ${currentQty}봉 / 최소 ${supplementMinQty}봉`,
        details: {
          kind: 'supplement',
          supplementTypeId: type.id,
          name: type.name,
          current: currentQty,
          minimum: supplementMinQty,
        },
        dedupKey: `supplementMin:alert:${type.id}`,
      });
    }
  } catch (err) {
    console.error('[6C-3] 최소재고 자동 발행 실패:', err);
  }
}

// 자동 발행 통합 — loadAllData에서 호출
// [묶음 9 예정] 냉동창고 잔량 부족 (closingChecks 신규 체크 함수 필요)
// [묶음 9 예정] 생산 자동 재포장 (자동 재포장 모달 자체 미구현)
async function triggerAutoLogs(today) {
  await triggerEventDueLogs(today);
  await triggerScheduleDueLogs(today);
  await triggerMinStockLogs(today);
}

function renderProductionTableCard(p) {
  const ingredients = p.ingredientsSnapshot || [];
  const unitRowName = getProductionUnitRowName(p, ingredients);

  // [묶음 4A] batchNo 우선 → 없으면 round → 둘 다 없거나 round==1이면 표시 없음
  const roundBadge = p.batchNo
    ? ` <span>${p.batchNo}차</span>`
    : (p.round > 1 ? ` <span>${p.round}회차</span>` : '');

  return `
    <div class="main-production-card${(p.category === 'raw' || p.category === 'freezeDry') ? ' receivable' : ''}${p.received ? ' received' : ''}" data-id="${p.id}" style="--recipe-color:${p.color || '#ef7bd0'}">
      ${p.received ? '<div class="main-received-stamp">입고완료</div>' : ''}
      <div class="main-production-card-title">
        ${p.recipeName}${roundBadge}
      </div>
      <table class="main-ingredient-table">
        <thead>
          <tr>
            <th>부위</th>
            <th>생산수량</th>
            <th>단위</th>
          </tr>
        </thead>
        <tbody>
          <tr class="unit-row">
            <td>${unitRowName}</td>
            <td>${formatQty(p.productionUnitQty)}</td>
            <td>${getProductionUnitDisplayUnit(p)}</td>
          </tr>
          ${ingredients.map(ing => `
            <tr>
              <td>${ing.name}</td>
              <td>${formatIngredientQty(p, ing)}</td>
              <td>${getIngredientUnit(p, ing)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="main-production-meta">
        ${p.category === 'raw' ? `<span>${p.rawBoxQty || 0}박스</span>` : ''}
        ${p.category === 'freezeDry' ? renderFreezeDryProductionMeta(p) : ''}
        ${p.received ? renderReceivedBadge(p) : ''}
      </div>
    </div>
  `;
}

function renderReceivedBadge(p) {
  if (p.category === 'freezeDry') {
    const unit = p.receivedFreezeType === 'breadPan' ? '빵판' : '동결판';
    return `<span class="main-received-badge">✅ 입고완료 ${p.receivedFreezeQty || 0}${unit}</span>`;
  }
  return `<span class="main-received-badge">✅ 입고완료 ${p.receivedBox || 0}박스${p.receivedRemainder ? ` +${p.receivedRemainder}낱개` : ''}</span>`;
}

function showReceiptSummaryModal(targetProductions, dateStr) {
  const receiptRows = (targetProductions || [])
    .filter(p => p.category === 'raw' || p.category === 'freezeDry');
  let rawBoxes = 0;
  let rawRemainder = 0;
  let breadPanTotal = 0;
  let frozenPanTotal = 0;

  const rowsHtml = receiptRows.length === 0
    ? '<div style="color:#aaa;text-align:center;padding:18px;">입고 대상 생산이 없습니다.</div>'
    : receiptRows.map(p => {
      let summary = '<span style="color:#c53030;">미입고</span>';
      if (p.received) {
        if (p.category === 'raw') {
          const boxes = Number(p.receivedBox || 0);
          const remainder = Number(p.receivedRemainder || 0);
          rawBoxes += boxes;
          rawRemainder += remainder;
          summary = `${boxes}박스${remainder ? ` + ${remainder}낱개` : ''}`;
        } else {
          const qty = Number(p.receivedFreezeQty || 0);
          if (p.receivedFreezeType === 'breadPan') {
            breadPanTotal = round2(breadPanTotal + qty);
            summary = `${qty}빵판`;
          } else {
            frozenPanTotal += qty;
            summary = `${qty}동결판`;
          }
        }
      }
      return `
        <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #eee;">
          <span>${p.recipeName || p.id || '생산'}</span>
          <span style="font-weight:600;">${summary}</span>
        </div>
      `;
    }).join('');

  showModal(`
    <h3 class="modal-title">생산 입고 현황 — ${dateStr}</h3>
    <div style="background:#f8f9fa;border:1px solid #e5e5e5;border-radius:6px;padding:10px;margin-bottom:12px;font-size:13px;">
      <div>생식 합계: <b>${rawBoxes}</b>박스${rawRemainder ? ` + <b>${rawRemainder}</b>낱개` : ''}</div>
      <div>빵판 합계: <b>${breadPanTotal}</b>빵판</div>
      <div>동결판 합계: <b>${frozenPanTotal}</b>동결판</div>
    </div>
    <div style="font-size:13px;max-height:420px;overflow:auto;">
      ${rowsHtml}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);
}

// [spec_v27 P2] 생식 제품 입고 모달 — 판수×판당팩수+낱개 → 박스/낱개 환산, productions 완료 + productTransferRequests outbox
async function openProductReceiptModal(productionId) {
  const p = [
    ...selectedDateProductions,
    ...overdueProductions,
    ...productions,
    ...nextProductions,
  ].find(x => x.id === productionId);
  if (!p || p.category !== 'raw') return; // 동결건조 제품입고는 Phase 3
  if (p.date > getToday()) {
    alert('미래 날짜의 제품 입고는 입력할 수 없습니다.');
    return;
  }
  if (await blockIfClosed(p.date)) return;
  if (p.received) {
    const ok = await showConfirmModal({
      title: '입고완료 수정',
      message: `현재 입력: 판수 ${p.receivedPlates ?? '-'} / 낱개 ${p.receivedLoosePacks ?? 0} → 총 ${p.receivedTotalPacks ?? '-'}팩 = ${p.receivedBox ?? '-'}박스 + ${p.receivedRemainder ?? 0}낱개

입고완료 내용을 수정하시겠습니까?
저장하면 수정 이력이 재고앱으로 다시 전송됩니다.`,
      confirmText: '수정하기',
    });
    if (!ok) return;
  }

  const recipe = recipes.find(r => r.id === p.recipeId);
  const target = recipe?.target || p.target || '';

  let sysVals = {};
  try {
    const snap = await getDoc(doc(db, 'settings', 'systemValues'));
    if (snap.exists()) sysVals = snap.data();
  } catch (err) {
    console.error('[receipt] systemValues load failed:', err);
  }
  // 판당 팩수: 레시피별 오버라이드 우선 (예: 램/래빗 55g = 180팩/판), 없으면 시스템 설정값
  const recipeOverride = Number(recipe?.packsPerPlate);
  const hasOverride = Number.isFinite(recipeOverride) && recipeOverride > 0;
  const pppKey = target === 'cat' ? 'packsPerPlateCat' : target === 'dog' ? 'packsPerPlateDog' : null;
  const packsPerPlate = hasOverride ? recipeOverride : Number(pppKey ? sysVals[pppKey] : NaN);
  if (!Number.isFinite(packsPerPlate) || packsPerPlate <= 0) {
    const tgtLabel = target === 'cat' ? '고양이' : target === 'dog' ? '강아지' : '대상';
    alert(`설정 > 시스템 설정값에서 ${tgtLabel} 판당 팩수를 먼저 등록해주세요.`);
    return;
  }

  const methods = Array.isArray(recipe?.productionMethods)
    ? recipe.productionMethods.filter(m => m && m.methodKey && m.active !== false)
    : [];
  const methodOptions = methods.length > 0
    ? methods.map(m => `<option value="${m.methodKey}" ${p.receivedMethod === m.methodKey ? 'selected' : ''}>${m.label || m.methodKey}</option>`).join('')
    : '<option value="">방식 없음</option>';

  document.getElementById('productReceiptModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="productReceiptModal">
      <div class="modal-box" style="width:420px;">
        <h3 class="modal-title">제품 입고 — ${p.recipeName}</h3>
        <p style="font-size:12px;color:#888;margin:0 0 12px;">판당 팩수 ${packsPerPlate}팩/판${hasOverride ? ' (레시피 지정)' : ''} · 1박스 = 20팩</p>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">생산방식 (기록용)</label>
          <select id="pr_method" style="width:100%;padding:8px;border:1px solid #d0d0d0;border-radius:4px;">${methodOptions}</select>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <div class="form-group" style="flex:1;">
            <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">판수 *</label>
            <input type="number" id="pr_plates" min="0" step="1" value="${p.receivedPlates ?? ''}" placeholder="판수" style="width:100%;padding:8px;border:1px solid #d0d0d0;border-radius:4px;box-sizing:border-box;" />
          </div>
          <div class="form-group" style="flex:1;">
            <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">낱개(자투리 팩)</label>
            <input type="number" id="pr_loose" min="0" step="1" value="${p.receivedLoosePacks ?? 0}" style="width:100%;padding:8px;border:1px solid #d0d0d0;border-radius:4px;box-sizing:border-box;" />
          </div>
        </div>
        <div id="pr_result" style="font-size:13px;color:#1a1a1a;background:#f5f7f5;border-radius:6px;padding:10px;margin-bottom:14px;">판수를 입력하세요.</div>
        <div class="modal-actions">
          <button class="btn-secondary" id="pr_cancel">취소</button>
          <button class="btn-primary" id="pr_confirm">제품 입고</button>
        </div>
      </div>
    </div>
  `);

  const overlay = document.getElementById('productReceiptModal');
  const platesEl = document.getElementById('pr_plates');
  const looseEl = document.getElementById('pr_loose');
  const resultEl = document.getElementById('pr_result');
  const cleanup = () => overlay?.remove();

  function compute() {
    const plates = parseInt(platesEl.value, 10);
    const loose = parseInt(looseEl.value, 10) || 0;
    if (!Number.isInteger(plates) || plates < 0 || loose < 0) {
      resultEl.textContent = '판수를 입력하세요.';
      return null;
    }
    const totalPacks = plates * packsPerPlate + loose;
    const boxes = Math.floor(totalPacks / 10) / 2;
    const remainder = totalPacks % 10;
    resultEl.innerHTML = `총 <b>${totalPacks}</b>팩 → <b>${boxes}</b>박스 + <b>${remainder}</b>낱개`;
    return { plates, loose, totalPacks, boxes, remainder };
  }
  platesEl.addEventListener('input', compute);
  looseEl.addEventListener('input', compute);
  compute();

  document.getElementById('pr_cancel').addEventListener('click', cleanup);
  document.getElementById('pr_confirm').addEventListener('click', async () => {
    const r = compute();
    if (!r) { platesEl.focus(); return; }
    const method = document.getElementById('pr_method').value || null;
    const revision = (p.receivedRevision || 0) + 1;
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'productions', p.id), {
        received: true,
        receivedMethod: method,
        receivedPlates: r.plates,
        receivedLoosePacks: r.loose,
        receivedTotalPacks: r.totalPacks,
        receivedBox: r.boxes,
        receivedRemainder: r.remainder,
        receivedRevision: revision,
        receivedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      const idempotencyKey = `productions:${p.id}:${revision}`;
      batch.set(doc(db, 'productTransferRequests', idempotencyKey), {
        idempotencyKey,
        sourceApp: 'production',
        sourceCollection: 'productions',
        sourceId: p.id,
        eventType: 'productReceipt',
        revision,
        supersedesRevision: revision > 1 ? revision - 1 : null,
        status: 'pending',
        category: 'raw',
        recipeId: p.recipeId,
        recipeName: p.recipeName,
        target,
        plates: r.plates,
        packs: r.totalPacks,
        boxes: r.boxes,
        remainderPacks: r.remainder,
        producedDate: p.date,
        staff: p.staffName || '',
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      cleanup();
      await loadAllData();
      if (selectedProductionDate) {
        selectedDateProductions = calendarProductions.filter(p => p.date === selectedProductionDate);
        selectedDateBlockingData = await getAllBlockingItems(selectedProductionDate);
      }
      renderMainLayout();
    } catch (err) {
      console.error('[receipt] save failed:', err);
      alert('제품 입고 저장 중 오류가 발생했습니다: ' + (err.message || err));
    }
  });
}

async function loadReceiptStaffOptions(groups = ['senior', 'office']) {
  const options = [];
  for (const key of groups) {
    const snap = await getDoc(doc(db, 'staffGroups', key));
    if (!snap.exists()) continue;
    (snap.data().members || []).forEach(member => {
      if (member?.name) options.push(`<option value="${member.name}">${member.name}</option>`);
    });
  }
  return options.join('');
}

async function openFreezeDryReceiptModal(productionId) {
  const p = [
    ...selectedDateProductions,
    ...overdueProductions,
    ...productions,
    ...nextProductions,
  ].find(x => x.id === productionId);
  if (!p || p.category !== 'freezeDry') return;
  if (p.date > getToday()) {
    alert('미래 날짜의 동결건조 입고는 입력할 수 없습니다.');
    return;
  }
  if (await blockIfClosed(p.date)) return;

  const recipe = recipes.find(r => r.id === p.recipeId);
  const productName = recipe?.displayName || p.recipeName || recipe?.name || '동결건조';
  const isTender = p.received
    ? p.receivedFreezeType === 'frozenPan'
    : (p.requiresSeparation === false || recipe?.requiresSeparation === false);
  const unitLabel = isTender ? '동결판' : '빵판';

  if (p.received) {
    const ok = await showConfirmModal({
      title: '입고완료 수정',
      message: `현재 입력된 수량: ${p.receivedFreezeQty ?? '-'}${unitLabel}\n\n입고완료 내용을 수정하시겠습니까?\n수정 차이만큼 ${unitLabel} 재고 lot을 조정합니다.`,
      confirmText: '수정하기',
    });
    if (!ok) return;
    if (!p.receivedLotId) {
      alert('원본 lot을 찾을 수 없습니다. 빵판/동결판 수동 조정을 이용해주세요.');
      return;
    }
  }

  const defaultQty = isTender
    ? Math.round(Number(p.received ? p.receivedFreezeQty : p.freezePanQty || 0))
    : round2(Number(p.received ? p.receivedFreezeQty : p.breadPanQty || 0));
  const staffOptions = await loadReceiptStaffOptions(['senior', 'office']);

  document.getElementById('freezeDryReceiptModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="freezeDryReceiptModal">
      <div class="modal-box" style="width:420px;">
        <h3 class="modal-title">동결건조 입고 — ${productName}</h3>
        <p style="font-size:12px;color:#888;margin:0 0 12px;">${isTender ? '분리작업 불필요 → 동결판 재고 입고' : '분리작업 필요 → 빵판 재고 입고'}</p>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">${unitLabel} 수량 *</label>
          <input type="number" id="fd_qty" min="${isTender ? '1' : '0.01'}" step="${isTender ? '1' : '0.01'}" value="${defaultQty || ''}" style="width:100%;padding:8px;border:1px solid #d0d0d0;border-radius:4px;box-sizing:border-box;" />
        </div>
        <div class="form-group" style="margin-bottom:14px;">
          <label style="display:block;font-size:12px;color:#555;margin-bottom:4px;">담당자 *</label>
          <select id="fd_staff" style="width:100%;padding:8px;border:1px solid #d0d0d0;border-radius:4px;">
            <option value="">선택</option>
            ${staffOptions}
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" id="fd_cancel">취소</button>
          <button class="btn-primary" id="fd_confirm">${p.received ? '수정 저장' : '입고'}</button>
        </div>
      </div>
    </div>
  `);

  const overlay = document.getElementById('freezeDryReceiptModal');
  const cleanup = () => overlay?.remove();
  document.getElementById('fd_cancel').addEventListener('click', cleanup);
  document.getElementById('fd_confirm').addEventListener('click', async () => {
    const qty = isTender
      ? parseInt(document.getElementById('fd_qty').value, 10)
      : round2(parseFloat(document.getElementById('fd_qty').value) || 0);
    const staffName = document.getElementById('fd_staff').value;

    if (!Number.isFinite(qty) || qty <= 0) {
      alert(`${unitLabel} 수량은 0보다 커야 합니다.`);
      return;
    }
    if (!staffName) {
      alert('담당자를 선택해주세요.');
      return;
    }
    if (await blockIfClosed(p.date)) return;

    try {
      if (p.received && p.receivedLotId) {
        const saved = await adjustExistingFreezeDryReceipt({ p, productName, qty, staffName, isTender });
        if (!saved) return;
      } else if (isTender) {
        await saveTenderFreezeDryReceipt({ p, productName, qty, staffName });
      } else {
        await saveBreadPanFreezeDryReceipt({ p, productName, qty, staffName });
      }
      cleanup();
      await loadAllData();
      if (selectedProductionDate) {
        selectedDateProductions = calendarProductions.filter(p => p.date === selectedProductionDate);
        selectedDateBlockingData = await getAllBlockingItems(selectedProductionDate);
      }
      renderMainLayout();
    } catch (err) {
      console.error('[freezeDryReceipt] save failed:', err);
      alert('동결건조 입고 저장 중 오류가 발생했습니다: ' + (err.message || err));
    }
  });
}

async function adjustExistingFreezeDryReceipt({ p, productName, qty, staffName, isTender }) {
  const lotCollection = isTender ? 'frozenPanLots' : 'breadPanLots';
  const logCollection = isTender ? 'frozenPanLogs' : 'breadPanLogs';
  const lotRef = doc(db, lotCollection, p.receivedLotId);
  const lotSnap = await getDoc(lotRef);
  if (!lotSnap.exists()) {
    alert('원본 lot을 찾을 수 없습니다. 빵판/동결판 수동 조정을 이용해주세요.');
    return false;
  }

  const lot = lotSnap.data();
  const before = Number(lot.remaining || 0);
  const previousQty = Number(p.receivedFreezeQty || 0);
  const delta = isTender ? qty - previousQty : round2(qty - previousQty);
  if (delta === 0) {
    alert('변경된 수량이 없습니다.');
    return false;
  }

  const after = isTender ? before + delta : round2(before + delta);
  if (after < 0) {
    const usedQty = round2(Number(lot.initialQty || 0) - before);
    alert(`이미 ${usedQty}개가 사용되어 ${qty}${isTender ? '동결판' : '빵판'}으로 줄일 수 없습니다.`);
    return false;
  }

  const now = new Date();
  const batch = writeBatch(db);
  const logRef = doc(collection(db, logCollection));
  const nextInitialQty = isTender
    ? Number(lot.initialQty || 0) + delta
    : round2(Number(lot.initialQty || 0) + delta);

  batch.update(lotRef, {
    initialQty: nextInitialQty,
    remaining: after,
    closed: isTender ? after <= 0 : after <= 0.005,
    updatedAt: now,
  });

  const logPayload = {
    type: 'adjust',
    date: getToday(),
    productName: lot.productName || productName,
    qty: delta,
    before,
    after,
    lotId: p.receivedLotId,
    staffName,
    uid: null,
    note: null,
    reason: '제품입고 수정',
    batchId: null,
    ledgerId: null,
    timestamp: now,
  };
  if (!isTender) {
    logPayload.lotDate = lot.date;
    logPayload.expectedFrozenQty = null;
    logPayload.actualFrozenQty = null;
    logPayload.diff = null;
  }
  batch.set(logRef, logPayload);

  batch.update(doc(db, 'productions', p.id), {
    receivedFreezeQty: qty,
    receivedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
  return true;
}

async function saveBreadPanFreezeDryReceipt({ p, productName, qty, staffName }) {
  const now = new Date();
  const batch = writeBatch(db);
  const lotRef = doc(collection(db, 'breadPanLots'));
  const logRef = doc(collection(db, 'breadPanLogs'));

  batch.set(lotRef, {
    productName,
    date: p.date,
    staffName,
    initialQty: qty,
    remaining: qty,
    closed: false,
    note: null,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(logRef, {
    type: 'incoming',
    date: p.date,
    productName,
    qty,
    before: 0,
    after: qty,
    lotId: lotRef.id,
    lotDate: p.date,
    expectedFrozenQty: null,
    actualFrozenQty: null,
    diff: null,
    staffName,
    uid: null,
    note: null,
    reason: null,
    batchId: null,
    ledgerId: null,
    timestamp: now,
  });

  batch.update(doc(db, 'productions', p.id), {
    received: true,
    receivedFreezeType: 'breadPan',
    receivedFreezeQty: qty,
    receivedLotId: lotRef.id,
    receivedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
}

async function saveTenderFreezeDryReceipt({ p, productName, qty, staffName }) {
  const now = new Date();
  const batch = writeBatch(db);
  const lotRef = doc(collection(db, 'frozenPanLots'));
  const logRef = doc(collection(db, 'frozenPanLogs'));
  const ledgerRef = doc(collection(db, 'stockLedger'));

  batch.set(lotRef, {
    productName,
    date: p.date,
    staffName,
    initialQty: qty,
    remaining: qty,
    closed: false,
    source: 'tenderIn',
    sourceRefId: logRef.id,
    note: null,
    createdAt: now,
    updatedAt: now,
  });

  batch.set(logRef, {
    type: 'tenderIn',
    date: p.date,
    productName,
    qty,
    before: 0,
    after: qty,
    lotId: lotRef.id,
    staffName,
    uid: null,
    note: null,
    reason: null,
    batchId: null,
    ledgerId: null,
    timestamp: now,
  });

  batch.set(ledgerRef, {
    actionType: 'frozenPanTenderIn',
    actionId: logRef.id,
    timestamp: now,
    date: p.date,
    status: 'active',
    items: [{
      collection: 'frozenPanLots',
      docId: lotRef.id,
      field: 'remaining',
      delta: qty,
      before: 0,
      after: qty,
      label: `${productName} 동결판(텐더동결 입고)`,
      stockUpdatedAtSnapshot: now,
      isNewDoc: true,
    }],
  });

  batch.update(doc(db, 'productions', p.id), {
    received: true,
    receivedFreezeType: 'frozenPan',
    receivedFreezeQty: qty,
    receivedLotId: lotRef.id,
    receivedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
}

function getProductionUnitRowName(p, ingredients) {
  // snapshot 우선 (신규 생산은 isProductionUnit 포함)
  const fromSnapshot = ingredients.find(i => i.isProductionUnit);
  if (fromSnapshot) return fromSnapshot.name;
  // 구형 생산 fallback: 레시피에서 isProductionUnit 재료명
  const recipe = recipes.find(r => r.id === p.recipeId);
  const puIng = recipe?.ingredients?.find(i => i.isProductionUnit);
  return puIng?.name || p.productionUnitName || '생산단위';
}

function getProductionUnitDisplayUnit(p) {
  if (p.productionUnitName) return p.productionUnitName;
  const recipe = recipes.find(r => r.id === p.recipeId);
  const productionUnitIng = recipe?.ingredients?.find(ing => ing.isProductionUnit);
  return productionUnitIng?.unitName || productionUnitIng?.weightDisplayUnit || '';
}

function getIngredientDisplayUnit(p, ing) {
  if (ing.weightDisplayUnit === 'kg' || ing.weightDisplayUnit === 'g') {
    return ing.weightDisplayUnit;
  }

  const recipe = recipes.find(r => r.id === p.recipeId);
  const recipeIngredient = recipe?.ingredients?.find(item => (
    item.name === ing.name && (!ing.meatTypeId || item.meatTypeId === ing.meatTypeId)
  )) || recipe?.ingredients?.find(item => item.name === ing.name);

  if (recipeIngredient?.weightDisplayUnit === 'kg' || recipeIngredient?.weightDisplayUnit === 'g') {
    return recipeIngredient.weightDisplayUnit;
  }

  return ing.meatTypeId ? 'kg' : 'g';
}

function formatIngredientQty(p, ing) {
  const grams = Number(ing.requiredQtyG || 0);
  return formatIngredientQtyValue(grams, getIngredientDisplayUnit(p, ing));
}

function getIngredientUnit(p, ing) {
  return getIngredientDisplayUnit(p, ing);
}

function formatQty(value, maxDecimals = 1) {
  const num = Number(value || 0);
  if (Number.isInteger(num)) return String(num);
  return num.toLocaleString('ko-KR', { maximumFractionDigits: maxDecimals });
}

function buildIngredientGroups(targetProductions = productions) {
  const groups = new Map();
  targetProductions.forEach(p => {
    (p.ingredientsSnapshot || []).forEach(ing => {
      const ingName = ing.name || '';
      if (ingName === '물' || ingName.includes('노른자')) return;
      const key = ingName.trim();
      if (!key) return;
      const unit = getIngredientDisplayUnit(p, ing);
      const g = Number(ing.requiredQtyG || 0);
      const cur = groups.get(key);
      if (cur) {
        cur.totalG += g;
        if (unit === 'kg') cur.unit = 'kg';
        if (!cur.meatTypeId && ing.meatTypeId) cur.meatTypeId = ing.meatTypeId;
      } else {
        groups.set(key, { name: ing.name, totalG: g, unit, meatTypeId: ing.meatTypeId || null });
      }
    });
  });
  return groups;
}

function sortIngredientGroups(groups) {
  const rank = grp => (grp.meatTypeId && meatTypeCategoryMap.get(grp.meatTypeId) === 'produce') ? 1 : 0;
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.totalG - a.totalG);
}

function renderMeatNeeds(targetProductions = productions, isCompleted = false) {
  if (targetProductions.length === 0) return `<div style="color:#aaa;">${isCompleted ? '불러온 생산 없음' : '오늘 생산 없음'}</div>`;
  const groups = buildIngredientGroups(targetProductions);
  if (groups.size === 0) return '<div style="color:#aaa;">원료 출고 없음</div>';
  const sortedGroups = sortIngredientGroups(groups);
  return sortedGroups.map(grp => {
    const qty = formatIngredientQtyValue(grp.totalG, grp.unit);
    return `
    <div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #f5f5f5;">
      <span>${grp.name}</span>
      <span style="font-weight:600;">${qty} ${grp.unit}</span>
    </div>
  `;
  }).join('');
}

function renderQuickInfo(isCompleted) {
  const cards = [];

  // 1. 차단 항목 (빨강) — getAllBlockingItems 결과
  blockingData.items.forEach(it => {
    cards.push(`
      <div class="alert-card alert-card-blocker">
        <span class="alert-card-label">⛔ ${it.reason || it.label}</span>
        <button class="alert-card-jump" data-jump="${it.jumpMenu}">처리하러 가기 →</button>
      </div>
    `);
  });

  // 2. 경고 항목 (노랑) — 계란 부족
  if (eggStock.minimumQty > 0 && eggStock.currentQty < eggStock.minimumQty) {
    cards.push(`
      <div class="alert-card alert-card-warning">
        <span class="alert-card-label">⚠️ 계란 부족 (현재: ${eggStock.currentQty}개 / 최소: ${eggStock.minimumQty}개)</span>
        <button class="alert-card-jump" data-jump="egg">처리하러 가기 →</button>
      </div>
    `);
  }

  // 3. 정보 항목 (초록) — 내일생산불러오기 완료
  if (isCompleted) {
    cards.push(`
      <div class="alert-card alert-card-info">
        <span class="alert-card-label">✅ 내일생산불러오기 완료</span>
      </div>
    `);
  }

  if (cards.length === 0) {
    return '<div class="alert-empty">오늘 처리할 항목 없음</div>';
  }

  return cards.join('');
}

async function handleTomorrowLoad(runDate) {
  const today = getToday();
  const baseDate = runDate || today;
  const isRetroactive = baseDate !== today;
  const targetProductions = isRetroactive ? overdueNextProductions : nextProductions;
  const activeCompletionDoc = isRetroactive ? overdueCompletionDoc : completionDoc;

  if (targetProductions.length === 0) {
    alert('다음 영업일에 등록된 생산이 없습니다.');
    return;
  }
  if (activeCompletionDoc?.status === 'completed') {
    alert('내일생산불러오기는 하루 1회만 가능합니다.');
    return;
  }

  const blockers = await gatherTomorrowLoadBlockers(baseDate, targetProductions);
  if (blockers.length > 0) {
    showTomorrowLoadBlockersModal(blockers);
    return;
  }

  const staffSnap = await getDoc(doc(db, 'staffGroups', 'lead'));
  const members = staffSnap.exists() ? staffSnap.data().members || [] : [];

  showModal(`
    <h3 class="modal-title">내일생산불러오기</h3>
    <p style="font-size:12px;color:#888;margin-bottom:16px;">
      ${isRetroactive ? `※ ${baseDate} 소급 실행입니다. 해당일에 했어야 할 차감을 지금 수행합니다.<br>` : ''}
      다음 영업일(${getNextBusinessDay(baseDate)}) 생산 기준으로 원육/봉투 재고가 차감됩니다.
    </p>
    <div class="form-group">
      <label>담당자 *</label>
      <select id="m_staff">
        <option value="">선택</option>
        ${members.map(m => `<option value="${m.name}">${m.name}</option>`).join('')}
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">취소</button>
      <button class="btn-primary" id="btnConfirmLoad">확인</button>
    </div>
  `);

  document.getElementById('btnConfirmLoad').addEventListener('click', async () => {
    const staff = document.getElementById('m_staff').value;
    if (!staff) { alert('담당자를 선택해주세요.'); return; }
    closeModal();
    await executeProductionLoad(baseDate, staff, targetProductions);
  });
}
// ============================================================
// [묶음 6E-1] 내일생산불러오기 차단 5조건 통합 사전 검사
// ============================================================
//
// 스펙 5절 차단 조건:
//   1. 입고 예정 미완료 — blockingData에서 가져옴
//   2. 원료 재고 부족 — meatNeeds vs (재포장+전처리+냉동창고) 합계
//   3. 봉투 재고 부족 — bagNeeds vs bagTypes.currentQty
//   4. 자동 재포장 확인 미완료 — [묶음 9 대기] 자동 재포장 모달 자체 미구현
//   5. 계란 출고 미입력 — blockingData에서 가져옴
//
// 한 팝업에 모두 나열. 차단 0개일 때만 담당자 모달 진입.

async function gatherTomorrowLoadBlockers(today, targetProductions = nextProductions) {
  const blockers = [];

  // 차단 1, 5, 8 — blockingData 활용 (이미 loadAllData에서 로드됨)
  // closingChecks.js의 items 중 입고 예정, 계란 출고, 제품입고 차단 항목
  blockingData.items.forEach(it => {
    if (it.jumpMenu === 'schedule') {
      // 입고 예정 미완료
      blockers.push({
        kind: 'schedule',
        text: `📦 ${it.reason || it.label}`,
        jumpMenu: 'schedule',
      });
    } else if (it.jumpMenu === 'egg') {
      // 계란 출고 미입력
      blockers.push({
        kind: 'egg',
        text: `🥚 ${it.reason || it.label}`,
        jumpMenu: 'egg',
      });
    } else if (it.label === '제품입고 미완료') {
      // 제품입고 미완료
      blockers.push({
        kind: 'productTransfer',
        text: `📦 ${it.reason || it.label}`,
        jumpMenu: 'main',
      });
    }
  });

  // 차단 2, 3 — 다음 영업일 생산 기준 필요량 계산
  const meatNeeds = {};
  const bagNeeds = {};

  for (const p of targetProductions) {
    (p.ingredientsSnapshot || []).forEach(ing => {
      if (ing.autoDeductInventory && ing.meatTypeId) {
        if (!meatNeeds[ing.meatTypeId]) meatNeeds[ing.meatTypeId] = { neededG: 0, name: ing.name };
        meatNeeds[ing.meatTypeId].neededG += ing.requiredQtyG;
      }
    });
    const recipe = recipes.find(r => r.id === p.recipeId);
    if (recipe?.category === 'raw' && recipe.bagTypeId) {
      const boxQty = p.rawBoxQty || 0;
      const bagSnap = await getDoc(doc(db, 'bagTypes', recipe.bagTypeId));
      if (bagSnap.exists()) {
        bagNeeds[recipe.bagTypeId] = (bagNeeds[recipe.bagTypeId] || 0) + (boxQty * 20); // 1제품박스=20팩=봉투20장
      }
    }
  }

  // 봉투 부족
  for (const [bagTypeId, needed] of Object.entries(bagNeeds)) {
    const bagSnap = await getDoc(doc(db, 'bagTypes', bagTypeId));
    if (!bagSnap.exists()) continue;
    const bagData = bagSnap.data();
    const current = bagData.currentQty || 0;
    if (current < needed) {
      blockers.push({
        kind: 'bag',
        text: `🛍️ ${bagData.name || ''} 봉투 재고 부족 — 필요 ${needed}장 / 현재 ${current}장`,
        jumpMenu: 'bag',
      });
    }
  }

  // 원육 부족 (재포장 + 전처리 + 냉동창고 합계 기준)
  // meatTypes 이름 조회 (ing.name이 없는 ID만 Firestore fetch)
  const meatTypeNameMap = {};
  const unknownIds = Object.entries(meatNeeds)
    .filter(([, v]) => !v.name)
    .map(([id]) => id);
  await Promise.all(unknownIds.map(async id => {
    try {
      const snap = await getDoc(doc(db, 'meatTypes', id));
      if (snap.exists()) meatTypeNameMap[id] = snap.data().name || id;
      else meatTypeNameMap[id] = id;
    } catch {
      meatTypeNameMap[id] = id;
    }
  }));

  for (const [meatTypeId, { neededG, name: ingName }] of Object.entries(meatNeeds)) {
    const repackedSum = meatStocks
      .filter(s => s.meatTypeId === meatTypeId && s.stage === 'repacked' && s.remaining > 0)
      .reduce((sum, s) => sum + s.remaining, 0);
    const processedSum = meatStocks
      .filter(s => s.meatTypeId === meatTypeId && s.stage === 'processed' && s.remaining > 0)
      .reduce((sum, s) => sum + s.remaining, 0);
    const frozenSum = meatStocks
      .filter(s => s.meatTypeId === meatTypeId && s.stage === 'frozen' && s.remaining > 0)
      .reduce((sum, s) => sum + s.remaining, 0);
    const totalAvailable = repackedSum + processedSum + frozenSum;

    if (totalAvailable < neededG) {
      const meatName = meatStocks.find(s => s.meatTypeId === meatTypeId)?.meatNameSnapshot || ingName || meatTypeNameMap[meatTypeId] || meatTypeId;
      blockers.push({
        kind: 'meat',
        text: `🥩 ${meatName} 원료 재고 부족 — 필요 ${(neededG/1000).toFixed(1)}kg / 현재 ${(totalAvailable/1000).toFixed(1)}kg (재포장 ${(repackedSum/1000).toFixed(1)} + 전처리 ${(processedSum/1000).toFixed(1)} + 냉동창고 ${(frozenSum/1000).toFixed(1)})`,
        jumpMenu: 'meat',
      });
    }
  }

  // 차단 4 — 자동 재포장 확인 미완료
  const autoRepackSnap = await getDocs(query(
    collection(db, 'activityLogs'),
    where('date', '==', today),
    where('action', '==', 'autoRepack')
  ));
  const pendingAutoRepackLogs = autoRepackSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(log =>
      (log.subAction === 'trigger' || log.subAction === 'diff') &&
      log.acknowledged !== true
    );

  if (pendingAutoRepackLogs.length > 0) {
    blockers.push({
      kind: 'autoRepack',
      text: `🔄 자동 재포장 확인 미완료 ${pendingAutoRepackLogs.length}건`,
      jumpMenu: 'main',
    });
  }

  return blockers;
}

// 차단 항목 통합 팝업
function showTomorrowLoadBlockersModal(blockers) {
  const itemsHtml = blockers.map((b, idx) => {
    const number = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][idx] || `${idx + 1}.`;
    return `
      <div class="tload-blocker-row">
        <span class="tload-blocker-num">${number}</span>
        <span class="tload-blocker-text">${escapeHtmlMain(b.text)}</span>
        <button class="tload-blocker-jump" data-jump="${b.jumpMenu}">처리하러 →</button>
      </div>
    `;
  }).join('');

  showModal(`
    <h3 class="modal-title">내일생산불러오기를 진행할 수 없습니다</h3>
    <p style="font-size:12px;color:#666;margin-bottom:12px;">
      아래 항목을 확인해주세요.
    </p>
    <div class="tload-blocker-list">
      ${itemsHtml}
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-secondary" onclick="closeModal()">확인</button>
    </div>
  `);

  // 점프 버튼
  document.querySelectorAll('.tload-blocker-jump').forEach(btn => {
    btn.addEventListener('click', () => {
      const menuId = btn.dataset.jump;
      closeModal();
      setCurrentMenu(menuId);
      renderLayout();
      renderPage(menuId);
    });
  });
}

async function executeProductionLoad(today, staffName, targetProductions = nextProductions) {
  const nextBizDay = getNextBusinessDay(today);
  try {
    const meatNeeds = {};
    const bagNeeds = {};

    for (const p of targetProductions) {
      const recipe = recipes.find(r => r.id === p.recipeId);
      if (!recipe) continue;
      (p.ingredientsSnapshot || []).forEach(ing => {
        if (ing.autoDeductInventory && ing.meatTypeId) {
          meatNeeds[ing.meatTypeId] = (meatNeeds[ing.meatTypeId] || 0) + ing.requiredQtyG;
        }
      });
      if (recipe.category === 'raw' && recipe.bagTypeId) {
        const boxQty = p.rawBoxQty || 0;
        const bagSnap = await getDoc(doc(db, 'bagTypes', recipe.bagTypeId));
        if (bagSnap.exists()) {
          bagNeeds[recipe.bagTypeId] = (bagNeeds[recipe.bagTypeId] || 0) + (boxQty * 20); // 1제품박스=20팩=봉투20장
        }
      }
    }

    // 봉투 재고 체크
    for (const [bagTypeId, needed] of Object.entries(bagNeeds)) {
      const bagSnap = await getDoc(doc(db, 'bagTypes', bagTypeId));
      if (bagSnap.exists()) {
        const current = bagSnap.data().currentQty || 0;
        if (current < needed) {
          alert(`봉투가 부족하여 내일 생산을 불러올 수 없습니다.\n${bagSnap.data().name || ''} 봉투: 현재 ${current}장 / 필요 ${needed}장`);
          return;
        }
      }
    }

        // 원육 합계 부족 사전 체크 (재포장 + 전처리 + 냉동창고)
    // 단위중량 올림 차감 고려
    for (const [meatTypeId, neededG] of Object.entries(meatNeeds)) {
      const repackedSum = meatStocks
        .filter(s => s.meatTypeId === meatTypeId && s.stage === 'repacked' && s.remaining > 0)
        .reduce((sum, s) => sum + s.remaining, 0);

      const processedLots = meatStocks
        .filter(s => s.meatTypeId === meatTypeId && s.stage === 'processed' && s.remaining > 0)
        .sort((a, b) => (a.processedDate || '').localeCompare(b.processedDate || ''));
      const processedSum = processedLots.reduce((sum, s) => sum + s.remaining, 0);

      const frozenSum = meatStocks
        .filter(s => s.meatTypeId === meatTypeId && s.stage === 'frozen' && s.remaining > 0)
        .reduce((sum, s) => sum + s.remaining, 0);

      const totalAvailable = repackedSum + processedSum + frozenSum;

      if (totalAvailable < neededG) {
        const meatName = meatStocks.find(s => s.meatTypeId === meatTypeId)?.meatNameSnapshot || meatTypeId;
        alert(
          `${meatName} 재고가 부족하여 내일 생산을 불러올 수 없습니다.\n\n` +
          `필요량: ${(neededG/1000).toFixed(1)}kg\n` +
          `현재 합계: ${(totalAvailable/1000).toFixed(1)}kg\n` +
          `  - 재포장: ${(repackedSum/1000).toFixed(1)}kg\n` +
          `  - 전처리: ${(processedSum/1000).toFixed(1)}kg\n` +
          `  - 냉동창고: ${(frozenSum/1000).toFixed(1)}kg`
        );
        return;
      }
    }

    const ledgerItems = [];
    const productionBatchId = `productionCompletion:${today}`;

    // 원육 FIFO 차감
    for (const [meatTypeId, neededG] of Object.entries(meatNeeds)) {
      let remaining = neededG;

      const repackedStocks = meatStocks
        .filter(s => s.meatTypeId === meatTypeId && s.stage === 'repacked' && s.remaining > 0)
        .sort((a, b) => (a.repackedDate || '').localeCompare(b.repackedDate || ''));

      for (const s of repackedStocks) {
        if (remaining <= 0) break;
        const deduct = Math.min(s.remaining, remaining);
        const newRemaining = s.remaining - deduct;
        await updateDoc(doc(db, 'meatStocks', s.id), { remaining: newRemaining, closed: newRemaining <= 0, updatedAt: new Date() });
        ledgerItems.push({ collection: 'meatStocks', docId: s.id, field: 'remaining', delta: -deduct, before: s.remaining, after: newRemaining, label: `${s.meatNameSnapshot} 재포장`, stockUpdatedAtSnapshot: new Date() });

        await recordMeatLog({
          type: 'productionDeduct',
          date: today,
          meatTypeId,
          meatNameSnapshot: s.meatNameSnapshot,
          stage: 'repacked',
          meatStockId: s.id,
          delta: -deduct,
          before: s.remaining,
          after: newRemaining,
          staff: staffName,
          reason: '내일생산불러오기 차감',
          batchId: productionBatchId,
        });

        remaining -= deduct;
      }

      if (remaining > 0) {
        const processedStocks = meatStocks
          .filter(s => s.meatTypeId === meatTypeId && s.stage === 'processed' && s.remaining > 0)
          .sort((a, b) => (a.processedDate || '').localeCompare(b.processedDate || ''));

        for (const s of processedStocks) {
          if (remaining <= 0) break;
          const unitW = s.unitWeightG || 1;
          const deductG = Math.min(s.remaining, Math.ceil(remaining / unitW) * unitW);
          const newRemaining = s.remaining - deductG;
          await updateDoc(doc(db, 'meatStocks', s.id), { remaining: newRemaining, closed: newRemaining <= 0, updatedAt: new Date() });
          ledgerItems.push({ collection: 'meatStocks', docId: s.id, field: 'remaining', delta: -deductG, before: s.remaining, after: newRemaining, label: `${s.meatNameSnapshot} 전처리`, stockUpdatedAtSnapshot: new Date() });

          await recordMeatLog({
            type: 'productionDeduct',
            date: today,
            meatTypeId,
            meatNameSnapshot: s.meatNameSnapshot,
            stage: 'processed',
            meatStockId: s.id,
            delta: -deductG,
            before: s.remaining,
            after: newRemaining,
            staff: staffName,
            reason: '내일생산불러오기 차감',
            batchId: productionBatchId,
          });

          // 잉여분 → 재포장으로 자동 입고
          const surplusG = deductG - remaining;
          if (surplusG > 0) {
            const existingRepacked = meatStocks.find(rs =>
              rs.meatTypeId === meatTypeId && rs.stage === 'repacked' && rs.remaining > 0
            );

            if (existingRepacked) {
              const newRepackedRemaining = existingRepacked.remaining + surplusG;
              await updateDoc(doc(db, 'meatStocks', existingRepacked.id), {
                remaining: newRepackedRemaining,
                closed: false,
                updatedAt: new Date(),
              });
              ledgerItems.push({
                collection: 'meatStocks',
                docId: existingRepacked.id,
                field: 'remaining',
                delta: surplusG,
                before: existingRepacked.remaining,
                after: newRepackedRemaining,
                label: `${s.meatNameSnapshot} 재포장 자동입고`,
                stockUpdatedAtSnapshot: new Date(),
              });

              await recordMeatLog({
                type: 'repackedIn',
                date: today,
                meatTypeId,
                meatNameSnapshot: s.meatNameSnapshot,
                stage: 'repacked',
                meatStockId: existingRepacked.id,
                delta: surplusG,
                before: existingRepacked.remaining,
                after: newRepackedRemaining,
                staff: staffName,
                reason: '생산 자동 재포장 (기존 lot 합산)',
                batchId: productionBatchId,
              });

              // [묶음 6E-2] 자동 재포장 발생 → 활동 로그 발행 (확인 필수)
              // 기존 재포장 lot에 잔여분 합산. 운영자가 메인 화면 생산 로그에서 [확인] 클릭 필요.
              await recordActivity({
                action: 'autoRepack',
                subAction: 'trigger',
                date: today,
                staff: '시스템',
                message: `🔄 생산 자동 재포장 — ${s.meatNameSnapshot} ${(surplusG/1000).toFixed(2)}kg (전처리 ${s.unitWeightG}g 단위 차감 후 잔여, 기존 재포장 lot 합산)`,
                details: {
                  meatTypeId,
                  meatName: s.meatNameSnapshot,
                  surplusG,
                  processedUnitWeightG: s.unitWeightG,
                  processedStockId: s.id,
                  repackedStockId: existingRepacked.id,
                  mode: 'merged',
                  batchId: productionBatchId,
                },
              });

              existingRepacked.remaining = newRepackedRemaining;
            } else {
              const newRepackedRef = await addDoc(collection(db, 'meatStocks'), {
                meatTypeId,
                meatNameSnapshot: s.meatNameSnapshot,
                stage: 'repacked',
                incomingDate: today,
                repackedDate: today,
                unitWeightG: null,
                unitCount: null,
                initialQtyG: surplusG,
                remaining: surplusG,
                batchId: productionBatchId,
                staffName,
                note: '생산 자동 재포장',
                closed: false,
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              ledgerItems.push({
                collection: 'meatStocks',
                docId: newRepackedRef.id,
                field: 'remaining',
                delta: surplusG,
                before: 0,
                after: surplusG,
                label: `${s.meatNameSnapshot} 재포장 자동신규`,
                stockUpdatedAtSnapshot: new Date(),
                isNewDoc: true,
              });

              await recordMeatLog({
                type: 'repackedIn',
                date: today,
                meatTypeId,
                meatNameSnapshot: s.meatNameSnapshot,
                stage: 'repacked',
                meatStockId: newRepackedRef.id,
                delta: surplusG,
                before: 0,
                after: surplusG,
                staff: staffName,
                reason: '생산 자동 재포장 (신규 lot)',
                batchId: productionBatchId,
              });

              // [묶음 6E-2] 자동 재포장 발생 → 활동 로그 발행 (확인 필수)
              // 기존 lot 없어 신규 재포장 lot 생성. 운영자가 [확인] 클릭 필요.
              await recordActivity({
                action: 'autoRepack',
                subAction: 'trigger',
                date: today,
                staff: '시스템',
                message: `🔄 생산 자동 재포장 — ${s.meatNameSnapshot} ${(surplusG/1000).toFixed(2)}kg (전처리 ${s.unitWeightG}g 단위 차감 후 잔여, 신규 재포장 lot)`,
                details: {
                  meatTypeId,
                  meatName: s.meatNameSnapshot,
                  surplusG,
                  processedUnitWeightG: s.unitWeightG,
                  processedStockId: s.id,
                  repackedStockId: newRepackedRef.id,
                  mode: 'newLot',
                  batchId: productionBatchId,
                },
              });

              meatStocks.push({
                id: newRepackedRef.id,
                meatTypeId,
                meatNameSnapshot: s.meatNameSnapshot,
                stage: 'repacked',
                remaining: surplusG,
                unitWeightG: null,
              });
            }
          }

          remaining -= deductG;
        }
      }

      if (remaining > 0) {
        const frozenStocks = meatStocks
          .filter(s => s.meatTypeId === meatTypeId && s.stage === 'frozen' && s.remaining > 0)
          .sort((a, b) => (a.incomingDate || '').localeCompare(b.incomingDate || ''));

        for (const s of frozenStocks) {
          if (remaining <= 0) break;
          const deduct = Math.min(s.remaining, remaining);
          const newRemaining = s.remaining - deduct;
          await updateDoc(doc(db, 'meatStocks', s.id), { remaining: newRemaining, closed: newRemaining <= 0, updatedAt: new Date() });
          ledgerItems.push({ collection: 'meatStocks', docId: s.id, field: 'remaining', delta: -deduct, before: s.remaining, after: newRemaining, label: `${s.meatNameSnapshot} 냉동창고`, stockUpdatedAtSnapshot: new Date() });

          await recordMeatLog({
            type: 'productionDeduct',
            date: today,
            meatTypeId,
            meatNameSnapshot: s.meatNameSnapshot,
            stage: 'frozen',
            meatStockId: s.id,
            delta: -deduct,
            before: s.remaining,
            after: newRemaining,
            staff: staffName,
            reason: '내일생산불러오기 차감',
            batchId: productionBatchId,
          });

          remaining -= deduct;
        }
      }
    }

    // 봉투 차감
    for (const [bagTypeId, neededPcs] of Object.entries(bagNeeds)) {
      const bagSnap = await getDoc(doc(db, 'bagTypes', bagTypeId));
      if (bagSnap.exists()) {
        const current = bagSnap.data().currentQty || 0;
        const newQty = current - neededPcs;
        await updateDoc(doc(db, 'bagTypes', bagTypeId), { currentQty: newQty, updatedAt: new Date() });
        ledgerItems.push({ collection: 'bagTypes', docId: bagTypeId, field: 'currentQty', delta: -neededPcs, before: current, after: newQty, label: `${bagSnap.data().name} 봉투`, stockUpdatedAtSnapshot: new Date() });
        await addDoc(collection(db, 'bagLogs'), { date: today, timestamp: new Date(), bagTypeId, bagNameSnapshot: bagSnap.data().name, type: 'autoDeduct', qty: -neededPcs, before: current, after: newQty, staffName, note: '내일생산불러오기 자동차감' });
      }
    }

    // ledger 저장
    const ledgerRef = await addDoc(collection(db, 'stockLedger'), {
      actionType: 'productionCompletion',
      actionId: today,
      timestamp: new Date(),
      runDate: today,
      status: 'active',
      items: ledgerItems,
    });

    // productionCompletion 저장
    await setDoc(doc(db, 'productionCompletion', today), {
      runDate: today,
      targetProductionDate: nextBizDay,
      status: 'completed',
      idempotencyKey: `productionCompletion:${today}`,
      staffName,
      ledgerId: ledgerRef.id,
      completedAt: new Date(),
    });

    for (const p of targetProductions) {
      await updateDoc(doc(db, 'productions', p.id), { lockedByCompletion: true });
    }

    await loadAllData();
    renderMainLayout();
    alert('내일생산불러오기 완료!');

  } catch (err) {
    console.error(err);
    alert('오류가 발생했습니다: ' + err.message);
  }
}

async function handleCancelCompletion() {
  const __c = await showConfirmModal({ title:'내일생산불러오기 취소', message:'내일생산불러오기를 취소하시겠습니까?\n차감된 재고가 복원됩니다.', confirmText:'취소', danger:true }); if (!__c) return;
  const reason = await showPromptModal({
    title: '내일생산불러오기 취소',
    message: '재고가 전부 롤백되고 마감 차단 항목이 다시 활성화됩니다.',
    label: '취소 사유',
    placeholder: '예: 생산 일정 변경',
    required: true,
    multiline: true,
  });
  if (reason === null) return;
  if (!reason) return;

  const today = getToday();
  const cancelStaffName = completionDoc?.staffName || 'unknown';
  const productionBatchId = `productionCompletion:${completionDoc?.runDate || today}`;

  try {
    if (completionDoc?.ledgerId) {
      const ledgerSnap = await getDoc(doc(db, 'stockLedger', completionDoc.ledgerId));
      if (ledgerSnap.exists()) {
        const items = ledgerSnap.data().items || [];
        for (const item of items) {
          const docSnap = await getDoc(doc(db, item.collection, item.docId));
          if (!docSnap.exists()) continue;
          const currentVal = docSnap.data()[item.field];

          if (currentVal !== item.after) {
            const __c = await showConfirmModal({
              title: '재고 변동 감지',
              message: `내일생산불러오기 이후 ${item.label} 재고가 변경된 이력이 있습니다.\n내일생산불러오기 당시 차감분만 복원됩니다.\n\n강제 복원하시겠습니까?`,
              confirmText: '강제 복원',
              danger: true,
            });
            if (!__c) continue;
          }

          // 자동 재포장 신규 lot은 remaining=0 + closed=true 처리
          if (item.isNewDoc) {
            const newRemaining = currentVal - item.delta; // 보통 0
            await updateDoc(doc(db, item.collection, item.docId), {
              [item.field]: newRemaining,
              closed: true,
              updatedAt: new Date(),
            });
          } else {
            await updateDoc(doc(db, item.collection, item.docId), {
              [item.field]: currentVal - item.delta,
              closed: false,
              updatedAt: new Date(),
            });
          }

          // meatStocks만 meatLogs 기록 (봉투/계란은 대상 아님)
          if (item.collection === 'meatStocks') {
            const docData = docSnap.data();
            await recordMeatLog({
              type: 'productionRollback',
              date: today,
              meatTypeId: docData.meatTypeId || null,
              meatNameSnapshot: docData.meatNameSnapshot || '',
              stage: docData.stage || 'frozen',
              meatStockId: item.docId,
              delta: -item.delta,
              before: currentVal,
              after: currentVal - item.delta,
              staff: cancelStaffName,
              reason: `내일생산불러오기 취소 - ${reason}`,
              batchId: productionBatchId,
            });
          }
        }
        await updateDoc(doc(db, 'stockLedger', completionDoc.ledgerId), { status: 'rolledBack', rolledBackAt: new Date() });
      }
    }

    if (completionDoc?.id) {
      await updateDoc(doc(db, 'productionCompletion', completionDoc.id), { status: 'cancelled', cancelReason: reason, cancelledAt: new Date() });
    }

    for (const p of nextProductions) {
      await updateDoc(doc(db, 'productions', p.id), { lockedByCompletion: false });
    }

    await loadAllData();
    renderMainLayout();
    alert('취소 완료! 재고가 복원되었습니다.');

  } catch (err) {
    console.error(err);
    alert('오류가 발생했습니다: ' + err.message);
  }
}

// [묶음 6E-3] 마감 새로고침 — 다음 영업일 생산 변경 시 롤백 + 재차감
//   사용 시나리오: 사무가 다음 영업일 생산 추가/수정/삭제 → 차감과 실제 생산 사이 불일치
//   흐름: 1) 롤백 → 2) 차단 5조건 재검사 → 3) 담당자 재선택 → 4) 재차감 → 5) 사무 로그 발행
//   권한: 모든 role (admin + office + production) — 운영자 결정
//   차단 발견 시: 롤백 완료 상태로 두고 함수 종료. 사용자가 차단 처리 후 [내일생산불러오기]로 재마감.
async function handleRefreshCompletion() {
  // [권한 매트릭스 E3] production은 메인 새로고침(ledger 롤백+재차감) 불가
  if (currentUserRole !== 'admin' && currentUserRole !== 'office') {
    alert('새로고침은 대표/사무실 계정만 가능합니다.');
    return;
  }

  if (completionDoc?.status !== 'completed') {
    alert('마감 상태에서만 새로고침이 가능합니다.');
    return;
  }
  if (nextProductions.length === 0) {
    alert('다음 영업일에 등록된 생산이 없습니다.');
    return;
  }

  const __c = await showConfirmModal({
    title: '내일생산불러오기 새로고침',
    message: '기존 차감을 롤백하고 변경된 다음 영업일 생산 기준으로 다시 차감합니다.\n진행하시겠습니까?',
    confirmText: '진행',
    danger: false,
  });
  if (!__c) return;

  const reason = await showPromptModal({
    title: '내일생산불러오기 새로고침',
    message: '롤백 후 차단 항목이 다시 검사됩니다.',
    label: '새로고침 사유',
    placeholder: '예: 다음 영업일 생산 추가',
    required: true,
    multiline: true,
  });
  if (reason === null || !reason) return;

  const today = getToday();
  const oldStaffName = completionDoc?.staffName || 'unknown';
  const productionBatchId = `productionCompletion:${completionDoc?.runDate || today}`;

  try {
    // === 1단계: 롤백 (handleCancelCompletion 로직 그대로) ===
    if (completionDoc?.ledgerId) {
      const ledgerSnap = await getDoc(doc(db, 'stockLedger', completionDoc.ledgerId));
      if (ledgerSnap.exists()) {
        const items = ledgerSnap.data().items || [];
        for (const item of items) {
          const docSnap = await getDoc(doc(db, item.collection, item.docId));
          if (!docSnap.exists()) continue;
          const currentVal = docSnap.data()[item.field];

          if (currentVal !== item.after) {
            const __cf = await showConfirmModal({
              title: '재고 변동 감지',
              message: `이전 마감 이후 ${item.label} 재고가 변경된 이력이 있습니다.\n마감 당시 차감분만 복원됩니다.\n\n강제 복원하시겠습니까?`,
              confirmText: '강제 복원',
              danger: true,
            });
            if (!__cf) continue;
          }

          // 자동 재포장 신규 lot은 remaining=0 + closed=true
          if (item.isNewDoc) {
            const newRemaining = currentVal - item.delta;
            await updateDoc(doc(db, item.collection, item.docId), {
              [item.field]: newRemaining,
              closed: true,
              updatedAt: new Date(),
            });
          } else {
            await updateDoc(doc(db, item.collection, item.docId), {
              [item.field]: currentVal - item.delta,
              closed: false,
              updatedAt: new Date(),
            });
          }

          if (item.collection === 'meatStocks') {
            const docData = docSnap.data();
            await recordMeatLog({
              type: 'productionRollback',
              date: today,
              meatTypeId: docData.meatTypeId || null,
              meatNameSnapshot: docData.meatNameSnapshot || '',
              stage: docData.stage || 'frozen',
              meatStockId: item.docId,
              delta: -item.delta,
              before: currentVal,
              after: currentVal - item.delta,
              staff: oldStaffName,
              reason: `새로고침 롤백 - ${reason}`,
              batchId: productionBatchId,
            });
          }
        }
        await updateDoc(doc(db, 'stockLedger', completionDoc.ledgerId), {
          status: 'rolledBack',
          rolledBackAt: new Date(),
        });
      }
    }

    if (completionDoc?.id) {
      await updateDoc(doc(db, 'productionCompletion', completionDoc.id), {
        status: 'cancelled',
        cancelReason: `새로고침: ${reason}`,
        cancelledAt: new Date(),
      });
    }

    for (const p of nextProductions) {
      await updateDoc(doc(db, 'productions', p.id), { lockedByCompletion: false });
    }

    // 데이터 다시 로드 — 재검사 정확하게
    await loadAllData();

    // === 2단계: 차단 5조건 재검사 (롤백된 재고 상태 기준) ===
    const blockers = await gatherTomorrowLoadBlockers(today);
    if (blockers.length > 0) {
      renderMainLayout();
      alert('롤백은 완료됐습니다.\n차단 항목이 발견되어 재차감을 진행할 수 없습니다.\n차단 항목 처리 후 [내일생산불러오기] 버튼으로 다시 진행해주세요.');
      showTomorrowLoadBlockersModal(blockers);
      return;
    }

    // === 3단계: 담당자 재선택 모달 ===
    const staffSnap = await getDoc(doc(db, 'staffGroups', 'lead'));
    const members = staffSnap.exists() ? staffSnap.data().members || [] : [];

    showModal(`
      <h3 class="modal-title">새로고침 — 담당자 선택</h3>
      <p style="font-size:12px;color:#888;margin-bottom:16px;">
        롤백 완료. 다음 영업일(${getNextBusinessDay(today)}) 생산 기준으로 재차감합니다.
      </p>
      <div class="form-group">
        <label>담당자 *</label>
        <select id="m_refresh_staff">
          <option value="">선택</option>
          ${members.map(m => `<option value="${m.name}">${m.name}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal()">취소 (마감 안 된 상태로 유지)</button>
        <button class="btn-primary" id="btnConfirmRefresh">재차감 진행</button>
      </div>
    `);

    document.getElementById('btnConfirmRefresh').addEventListener('click', async () => {
      const newStaff = document.getElementById('m_refresh_staff').value;
      if (!newStaff) { alert('담당자를 선택해주세요.'); return; }
      closeModal();

      // === 4단계: 재차감 ===
      await executeProductionLoad(today, newStaff);

      // === 5단계: 사무 로그 발행 (확인 필수) ===
      // executeProductionLoad가 내부적으로 loadAllData + renderMainLayout + alert까지 이미 끝낸 상태.
      // 메인은 이 시점에 옛 로그 기준으로 그려져 있음. recordActivity 후 로그 패널만 다시 그려서 즉시 반영.
      try {
        await recordActivity({
          action: 'closing',
          subAction: 'refresh',
          date: today,
          staff: newStaff,
          message: `🔄 내일생산불러오기 새로고침 — 사유: ${reason} / 담당: ${newStaff} (이전 담당: ${oldStaffName})`,
          details: {
            previousStaff: oldStaffName,
            newStaff,
            reason,
            runDate: getNextBusinessDay(today),
          },
        });
        // [묶음 6E-3] 신규 로그 즉시 화면 반영 — loadCombinedLogs로 데이터 다시 받고 패널만 재렌더
        await loadCombinedLogs();
        refreshLogPanels();
      } catch (err) {
        console.warn('[6E-3] 새로고침 활동 로그 발행 실패:', err);
      }
    });

  } catch (err) {
    console.error('[6E-3] 새로고침 실패:', err);
    alert('오류가 발생했습니다: ' + err.message);
    await loadAllData();
    renderMainLayout();
  }
}

// [묶음 6E-4] selectedDate 모드 해제 — 1번 화면을 다시 오늘 기준(또는 마감 후 다음 영업일)으로 표시
function handleBackToToday() {
  selectedProductionDate = null;
  selectedDateProductions = [];
  selectedDateBlockingData = null;
  renderMainLayout();
}

function showBigView() {
  const isCompleted = completionDoc?.status === 'completed';
  const isViewingSelectedDate = selectedProductionDate !== null;
  const isOverdueClosingMode = !isViewingSelectedDate && overdueClosingDate !== null;
  const displayProductions = isViewingSelectedDate
    ? selectedDateProductions
    : (isOverdueClosingMode ? overdueProductions : (isCompleted ? nextProductions : productions));
  const title = isViewingSelectedDate
    ? `${selectedProductionDate} 생산 현황`
    : (isOverdueClosingMode ? `${overdueClosingDate} 생산 현황` : (isCompleted ? `${getNextBusinessDay(getToday())} 불러온 생산` : `${getToday()} 생산 현황`));

  showModal(`
    <h3 class="modal-title">${title}</h3>
    <div class="main-production-grid big-view">
      ${displayProductions.length === 0 ? '<p style="color:#aaa">생산 없음</p>' :
        displayProductions.map(p => renderProductionTableCard(p)).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">닫기</button>
    </div>
  `);
}

function showModal(html) {
  const existing = document.getElementById('modalOverlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  const isWide = html.includes('main-production-grid big-view');
  overlay.id = 'modalOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box ${isWide ? 'modal-wide' : ''}">${html}</div>`;
  document.body.appendChild(overlay);
  // 외부 클릭 닫힘 비활성화 (묶음 1F: 모달 사라짐 이슈 우회)
}

window.closeModal = function() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.remove();
};
