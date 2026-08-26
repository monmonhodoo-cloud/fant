# AGENTS.md — 판타펫 생산관리 앱 (Fantapet Management)

This project uses two separate AI coding agents with different responsibilities.

## Codex's role

- senior software architect
- codebase analyst
- structure and scalability reviewer
- long-term maintainability reviewer
- risk detection and refactoring planner

Codex is responsible for:

- understanding the overall architecture
- analyzing data flow and dependencies
- identifying technical debt and structural risks
- reviewing implementation quality
- detecting hidden bugs and scalability issues
- protecting long-term maintainability
- planning safe phased improvements

Codex should NOT aggressively rewrite the entire project or implement massive uncontrolled changes.

## Codex's role

- implementation engineer
- execution agent
- terminal and testing operator
- feature implementation specialist

Codex is responsible for:

- implementing requested features
- modifying files safely
- running commands and tests
- fixing errors
- verifying functionality after changes
- performing isolated incremental code changes

Codex should NOT independently redesign the architecture or perform massive refactors without instruction.

## Shared rules for BOTH agents

- preserve existing behavior unless explicitly instructed otherwise
- avoid touching unrelated files
- prefer small safe incremental changes
- avoid unnecessary abstractions, frameworks, or libraries
- protect Firebase and Firestore consistency
- prevent inventory corruption or duplicate write issues
- maintain compatibility with current project structure
- prioritize stability, readability, and maintainability over speed

## Critical protected systems

- Firebase Authentication
- Firestore write consistency
- supplement deduction logic (영양제 자동차감)
- production round/batchNo auto-recalculation
- conversion table application (effectiveDate ≤ productionDate, createdAt desc tie-break)
- role and permission systems
- shared state synchronization with inventory app

## Required workflow

1. Understand existing implementation first
2. Analyze risks before modifying code
3. Implement only the requested scope
4. Keep changes isolated
5. Verify the application still works
6. Clearly explain:
   - changed files
   - reasons for changes
   - modified functionality
   - possible side effects

Both agents must collaborate like engineers working in a real production software environment.

---

## Project context

This project is the **Fantapet Management Web App** (생산관리 앱) — one of two interconnected internal web apps used by Fantapet (a pet food company) for operations management. Both apps share the same Firebase project (`fant-e5ae5`) but have clearly delineated responsibilities (Option A app split).

### Tech stack (confirmed)

- Vanilla JavaScript + Vite
- Firebase: Auth + Firestore + Hosting (no Cloud Functions on this app)
- Region: `asia-northeast3` (Seoul)
- Routing: custom page-based router (`src/router.js`, `src/pages/`)
- UI: vanilla HTML/CSS + custom CSS classes
- Drag and drop: SortableJS
- Package manager: npm
- Deployment: GitHub Pages (base path: `/fant/`)
- Hosting URL: https://green-cloud-workroom.github.io/fant/
- GitHub: https://github.com/green-cloud-workroom/fant

### Current state — Phase 1 code complete (as of 2026-05-18)

- All Phase 1 code work closed: D-시리즈 / §1 영양제 표 / §5 rules + Custom Claims / §6 삭제 UI / Phase 2a 휴일 마스터 / Phase 2b 환산표 + method / 4차 묶음 (E-2~E-5 마스터 드래그 정렬) / 5차 묶음 (E-6/E-7 카드 드래그 + 카테고리 순서)
- E-8 폐기 결정 (시드 후 운영 데이터로 재검토)
- See `docs/fantapet_handoff_v28.md` for full session record

### Next phase: Seed input + production entry

- Scope: 시드 체크리스트 v3 작성 → 검증 잔재 정리 → 마스터 데이터 시드 → 운영 직전 점검
- After seed: enter Phase 2c (in-app wipe, conversion auto-suggest, statistics tab 7, production forecast)
- Then Phase 4 (natural verification) and Phase 5 (concurrent operation start)

---

## Project documents (priority order)

All project documents are in Korean. Read in this order when starting a session:

1. **`docs/fantapet_handoff_v28.md`** — current state, all decisions, blockers (latest handoff)
2. **`docs/fantapet_spec_v26.md`** — most recent spec (Phase 2b conversion table + method)
3. **`docs/fantapet_spec_v25.md`** — Phase 2a holiday master spec
4. **`docs/fantapet_spec_v24.md`** — pre-Phase 2 baseline (D-series, §1, §5, §6)
5. **`docs/fantapet_spec_v22.md`** + **`v23.md`** — historical reference (3차 묶음 and earlier)
6. **`docs/codebase.md`** — current code structure inventory

If a `판타펫_재고관리_*.md` file is present in `docs/`, those are the inventory app's documents — reference only when working on cross-app boundaries (shared collections, custom claims).

---

## Critical boundaries (Option A app split)

- **Production app (this repo)**: production planning, recipe/conversion table, holidays master, actual production input
- **Inventory app (separate repo)**: order forecast (read-only + memo only), inventory operations, donation/disposal, picking/packing, name matching

Shared collections (both apps read; specified writer):
- `recipes`, `holidays`, `staff`, `staffGroups` → **production app writes** (this repo), inventory app reads only
- `forecastDaily`, `forecastAnalytics` → inventory app writes, both apps read
- `activityLogs` → both apps write (with `details.app: 'inventory' | 'production'`)

**Never put inventory-app concerns (order forecast UI, donation/disposal, picking/packing) into this repo.** If asked to, ask 호두 first.

---

## spec_v26 정정 사항 (9건 누적, handoff에 박힘)

These are amendments to spec_v26 discovered during implementation. Always cross-check spec text with these corrections before implementing related features:

| # | Original (spec_v26) | Correction (in code) |
|---|---|---|
| 1 | §1-5 `action:'supplement', subAction:'adjust'` | `action:'supplementStock', subAction:'manualAdjust'` |
| 2 | §1-2 자동차감 = 각 생산 클릭 상세 | 그날 net 합계만 표시 |
| 3 | §1-2 수동조정 사유 = 열 헤더 1개 | 상단 고정 사유 입력칸 |
| 4 | §3-4 `activityLogs update: if false` | `acknowledged` 계열 필드만 update 허용 |
| 5 | §5-2 컬렉션별 write 매트릭스 | 코드 현실 반영 추가 |
| 6 | §5-5 "콘솔 수동 부여" | Admin SDK 스크립트 (Console UI 부재) |
| 7 | §5-2 "bagLogs delete: admin only" | admin + office (cascade 권한) |
| 8 | §2-4 환산값 적용 규칙 | 같은 effectiveDate 다중 이력 시 createdAt desc 우선 |
| 9 | §2-4 미래 effectiveDate 처리 | 차단 안 함. conversionHistory fallback + 사용자 안내 배지 표시 |

---

## Known issues / caveats

### 1. `prompt()` / native dialog blocked in deployed SPA

`prompt()` is blocked in the deployed GitHub Pages SPA environment (discovered during §1 work, fixed in `1d3efff`). For input, always use inline UI or `showModal`. `alert()` works but `prompt()` / `confirm()` may be blocked depending on environment.

### 2. Public data API (공공데이터포털) 5-year limit

The Korean holiday API does not provide data beyond 5 years out. Currently `HOLIDAY_DATA_END_YEAR = 2027` is set as a safety net. Around June 2027, retry fetching 2028 data. Yellow banner shows from 2027-10-01, red banner from 2028-01-01 (admin/office only).

### 3. Firestore rules auto-deploy via GitHub Actions

`.github/workflows/firebase-rules.yml` deploys rules automatically on push to main. `FIREBASE_RULES_SERVICE_ACCOUNT` secret is registered (verified during Phase 2b deployment). Rules changes go through this workflow — manual `firebase deploy --only firestore:rules` is fallback only.

### 4. recipe.js / meat 모달 add/edit 권한 가드 누락

UI buttons are visible to all roles but Firestore rules block writes. Cosmetic issue. To be fixed before production launch or during seed cleanup. Tracked as 운영 발견사항 #20.

### 5. productions soft delete vs recipes deletion policy

§6 recipe deletion checks `productions` and `schedules` count. Whether the query includes `status: 'deleted'` documents is unverified. Check during seed prep or 4·5차 cleanup. Tracked as 운영 발견사항 v26 #69.

### 6. Test accounts (current verification accounts)

Custom claims use the cross-app model:
`{ app: string[], roles: { inventory?: 'owner'|'admin'|'qc', production?: 'admin'|'office'|'production' } }`.
The production app reads only `roles.production`; do not write a bare top-level `role` claim.

- `alice@fantapet.com` - `app: ['inventory', 'production']`, `roles: { inventory: 'owner', production: 'admin' }`
- `admin@fantapet.com` - `app: ['inventory', 'production']`, `roles: { inventory: 'admin', production: 'office' }`
- `qc@fantapet.com` - `app: ['inventory', 'production']`, `roles: { inventory: 'qc', production: 'production' }`
- production role accounts - to be created during seed step

Cutover safety: do not push or merge Firestore rules changes to `main` before the Admin SDK re-claim has been executed and verified with live token reads. Push to `main` triggers the GitHub Actions rules deploy immediately.
Transitional rule: `hasRole` accepts BOTH the new `token.roles.production` and the legacy flat `token.role` during cutover. This legacy branch MUST be removed in a follow-up commit after the live re-claim is verified and all client tokens have refreshed.

**Passwords are NOT in this document.** Request from 호두 when verification requires login.

### 7. SortableJS global pattern

All drag-and-drop UIs (4차 + 5차 묶음) use SortableJS with `handle: '.drag-handle'`. admin/office only renders the handle, production role does not. Modal-based Sortable instances (E-4 meat, potentially future) must call `destroy()` on close to prevent memory leaks.

### 8. sortOrder policies (differ per collection)

- `bagTypes`, `recipes`: global continuous sequence (raw 0~N, freezeDry N+1~)
- `frozenProducts`, `meatTypes`: single sequence starting from 0
- `supplementTypes`: auto-calculated `recipe.sortOrder * 100 + unitIndex` (synced on recipe drag)
- `productions`: card drag within same date only, reuses existing sortOrder pool

### 9. Test data residue (시드 직전 정리 대상)

See `docs/fantapet_handoff_v28.md` §"시드 입력 전 정리 필요" for the full list. Includes inactive test recipes, status:'deleted' productions, conversionHistory verification entries, settings/systemValues + menuStaffGroups verification values, activityLogs accumulated logs, empty unitPresets on 4 operational recipes.

---

## Communication style with 호두

- Korean by default. Direct, concise, no emotional padding.
- When asking clarifying questions, always provide a recommended answer with reasoning.
- Distinguish blockers (must-fix to proceed) from improvements (Phase 2c / Phase 4 backlog items).
- Never claim file content is unavailable without first reading the actual file.
- If a memory or project file says X but the current code shows Y, surface the discrepancy explicitly — do not silently choose one.
- Do not psychoanalyze 호두's intent. Take messages at face value.
- Acknowledge mistakes briefly and move on. No self-flagellation.

---

## Required first steps for any new task

1. Read `docs/fantapet_handoff_v28.md` first for current state.
2. If the task touches a specific feature, check the relevant `spec_v*` document (latest = v26).
3. If the task touches Firestore, check `codebase.md` collection schema before writing any read/write code.
4. If the task seems to cross app boundaries (production vs inventory), check handoff §"재고관리 앱 협의" before making any architecture decision.
5. If anything is ambiguous, ASK 호두 with a recommended answer attached — do not guess.
6. After implementing: run `npm run build` and report results. For deploys: `npm run deploy` (gh-pages).

---

## Repository layout

```
fant/
├── AGENTS.md                    # this file
├── README.md
├── package.json
├── package-lock.json
├── vite.config.js               # base: '/fant/'
├── index.html
├── firestore.rules              # PR-based, auto-deployed via GitHub Actions
├── firebase.json
├── .firebaserc
├── .github/
│   └── workflows/
│       └── firebase-rules.yml   # rules auto-deploy on push
├── scripts/
│   ├── backupFirestorePreWipe.mjs
│   ├── fetchKoreanPublicHolidays.mjs
│   ├── firestoreConfig.mjs
│   ├── setCustomClaims.mjs
│   ├── wipeFirestoreOperationalData.mjs
│   └── wipeFirestoreOperationalDataAdmin.mjs
├── src/
│   ├── main.js
│   ├── router.js
│   ├── style.css
│   ├── firebase.js
│   ├── pages/                   # page-based structure
│   │   ├── bag.js
│   │   ├── egg.js
│   │   ├── frozenPan.js
│   │   ├── frozenProduct.js
│   │   ├── frozenSep.js
│   │   ├── main.js
│   │   ├── meat.js
│   │   ├── production.js
│   │   ├── recipe.js
│   │   ├── schedule.js
│   │   ├── settings.js
│   │   ├── stats.js
│   │   └── supplement.js
│   ├── services/
│   │   ├── activityLogs.js
│   │   ├── closingChecks.js
│   │   ├── closingChecksLogic.js
│   │   ├── holidayMaster.js
│   │   ├── meatLogs.js
│   │   ├── menuStaffGroups.js
│   │   └── systemValues.js
│   └── utils/
│       ├── closingGuard.js
│       ├── date.js
│       ├── modal.js
│       ├── number.js
│       ├── recipe.js
│       └── supplement.js
└── docs/                        # tracked
```

---

## Version history

- 2026-05-18: AGENTS.md created at seed input entry point (Phase 1 code complete, Phase 2b + 4차/5차 묶음 closed)
