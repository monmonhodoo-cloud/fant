/**
 * fixRecipeMeatTypeLinks.mjs
 * 
 * 작업 목록:
 * 1. meatType '닭넓적살' → '닭정육' 이름 변경
 * 2. 레시피 원료명 rename (자른토끼내장→토끼내장, 자른양간→양간, 자른양염통→양염통, 오리정육→오리로스)
 * 3. 모든 레시피 원료에 meatTypeId 일괄 연결 + autoDeductInventory 보정
 * 4. 닭간 중복(LomeZ0A...) meatStocks 3개 meatTypeId 교정 후 meatType 삭제
 * 5. 닭염통·토끼내장 미사용 중복 meatType 삭제
 *
 * 사용: DRY_RUN=true node scripts/fixRecipeMeatTypeLinks.mjs  (확인)
 *       DRY_RUN=false node scripts/fixRecipeMeatTypeLinks.mjs (실행)
 */

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseConfig } from './firestoreConfig.mjs';

const DRY_RUN = process.env.DRY_RUN !== 'false';
console.log(`=== ${DRY_RUN ? 'DRY-RUN (읽기 전용)' : '🔴 EXECUTE (실제 변경)'} ===\n`);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
await signInWithEmailAndPassword(getAuth(app), process.env.FB_EMAIL, process.env.FB_PASS);

// ── 상수 ──────────────────────────────────────────────────────────────────

// 레시피 원료명 rename (적용 후 NAME_MAP으로 매핑)
const RECIPE_RENAMES = {
  '자른토끼내장': '토끼내장',
  '자른양간': '양간',
  '자른양염통': '양염통',
  '오리정육': '오리로스',
};

// 원료명 → meatTypeId (rename 적용 후 기준)
const NAME_MAP = {
  '닭가슴살':  'lUhCdoVSEW5LgOj6hyhU',
  '닭정육':    'NGqsI0cRjnqu7XlTAZw0',  // 닭넓적살에서 rename 예정
  '통닭':      'm8KDTu5yuLVpVaeiGWmK',
  '닭안심':    'L8nOD7MzwL1txZIADRbm',
  '닭목뼈':    '5dASxN0C6lCbG4UfTwnZ',
  '닭간':      '74eSDE8ICKo8CAQivRAB',
  '닭염통':    'HR05Si1qydQ8JUDhoxUx',
  '오리안심':  'zM0l2bCdGBfOk0vDsEHR',
  '오리목살':  '4BEiTs3LZzpdKqw10VRN',
  '오리로스':  'f5M6pvR5NHr8gTm9fouS',
  '오리뼈정육':'KOdGG2aTPlfvOI9V5WmU',
  '양엉덩이':  'voNEp6lNzpAj1ZtbDdg6',
  '양어깨살':  'FWW6fMBeexYImDbk8nfW',
  '양간':      'GijzegIW924DZuY6xC7l',
  '양염통':    'Ve7DZbbq7Z0fnHgdR1d7',
  '양제비추리':'eKSjeQUQtEnn4Y44bd46',
  '토끼원육':  'myNn0vjmnGlwAzIUfUIF',
  '토끼내장':  'g5ulJ54XA2WQWnBqYNk7',
  '대구순살':  'SFbETjEvFpQzdbYL5WNb',
  '황다랑어':  'EEPTqRvaFEbzb5essnzQ',
  '메추리':    'Ae1hSASq7BMjIN9jXh8c',
};

// 재고 추적 안 함 → autoDeductInventory=false 강제
const NO_DEDUCT = new Set(['소고기', '돼지안심', '물', '정제수']);

// 닭간 중복 처리
const CHICKEN_LIVER_WRONG = 'LomeZ0AtYrcAAA6Qa5Hb';
const CHICKEN_LIVER_RIGHT = '74eSDE8ICKo8CAQivRAB';

// 삭제할 중복 meatType id
const DELETE_MEAT_TYPES = [
  'LomeZ0AtYrcAAA6Qa5Hb',  // 닭간 중복 (재고 교정 후 삭제)
  'rPcRFMSHnBVHY3s7NyoI',  // 닭염통 중복 (완전 미사용)
  'MZXiplxt2dHflPe1Qgii',  // 토끼내장 중복 (inactive, 미사용)
];

// ── 로드 ──────────────────────────────────────────────────────────────────
const recipeSnap = await getDocs(collection(db, 'recipes'));
const stockSnap  = await getDocs(collection(db, 'meatStocks'));

let totalChanges = 0;

// ── 1. meatType '닭넓적살' → '닭정육' ───────────────────────────────────
console.log('[ 1 ] meatType 이름 변경: 닭넓적살 → 닭정육');
console.log(`      id=NGqsI0cRjnqu7XlTAZw0`);
if (!DRY_RUN) {
  await updateDoc(doc(db, 'meatTypes', 'NGqsI0cRjnqu7XlTAZw0'), { name: '닭정육', updatedAt: new Date() });
}
totalChanges++;
console.log('      → 변경 예정\n');

// ── 2. 닭간 중복 meatStocks 교정 ────────────────────────────────────────
console.log('[ 2 ] 닭간 중복 meatStocks 교정 (LomeZ0A→74eSDE8)');
const wrongLiverStocks = stockSnap.docs.filter(d => d.data().meatTypeId === CHICKEN_LIVER_WRONG);
if (wrongLiverStocks.length === 0) {
  console.log('      → 대상 없음\n');
} else {
  wrongLiverStocks.forEach(d => {
    console.log(`      meatStocks/${d.id}  remaining=${d.data().remaining}g  date=${d.data().incomingDate}`);
    if (!DRY_RUN) {
      updateDoc(doc(db, 'meatStocks', d.id), { meatTypeId: CHICKEN_LIVER_RIGHT, updatedAt: new Date() });
    }
    totalChanges++;
  });
  console.log(`      → ${wrongLiverStocks.length}개 meatTypeId 교정\n`);
}

// ── 3. 레시피 원료 업데이트 ──────────────────────────────────────────────
console.log('[ 3 ] 레시피 원료 meatTypeId 연결 + 이름 정규화\n');

const recipeUpdates = [];

for (const rdoc of recipeSnap.docs) {
  const r = rdoc.data();
  if (r.status === 'deleted') continue;

  let changed = false;
  const newIngredients = (r.ingredients || []).map(ing => {
    let { name, meatTypeId, autoDeductInventory } = ing;

    // rename 적용
    if (RECIPE_RENAMES[name]) {
      console.log(`  [${r.name}] "${name}" → "${RECIPE_RENAMES[name]}"`);
      name = RECIPE_RENAMES[name];
      changed = true;
    }

    // NO_DEDUCT 처리
    if (NO_DEDUCT.has(name) && autoDeductInventory !== false) {
      console.log(`  [${r.name}] "${name}" autoDeductInventory: true → false`);
      autoDeductInventory = false;
      changed = true;
    }

    // meatTypeId 연결
    const mappedId = NAME_MAP[name];
    if (mappedId && meatTypeId !== mappedId) {
      console.log(`  [${r.name}] "${name}" meatTypeId 연결 → ${mappedId}`);
      meatTypeId = mappedId;
      if (autoDeductInventory === undefined) autoDeductInventory = true;
      changed = true;
    }

    return { ...ing, name, meatTypeId: meatTypeId || ing.meatTypeId || null, autoDeductInventory };
  });

  if (changed) {
    recipeUpdates.push({ id: rdoc.id, name: r.name, ingredients: newIngredients });
  }
}

console.log(`\n  → 변경 레시피 ${recipeUpdates.length}개`);
if (!DRY_RUN) {
  for (const u of recipeUpdates) {
    await updateDoc(doc(db, 'recipes', u.id), { ingredients: u.ingredients, updatedAt: new Date() });
    console.log(`  저장: ${u.name}`);
  }
}
totalChanges += recipeUpdates.length;

// ── 4. 중복 meatType 삭제 ────────────────────────────────────────────────
console.log('\n[ 4 ] 중복 meatType 삭제');
for (const id of DELETE_MEAT_TYPES) {
  console.log(`      meatTypes/${id}`);
  if (!DRY_RUN) {
    await deleteDoc(doc(db, 'meatTypes', id));
  }
  totalChanges++;
}
console.log(`      → ${DELETE_MEAT_TYPES.length}개 삭제 예정\n`);

// ── 요약 ──────────────────────────────────────────────────────────────────
console.log(`=== 완료: 총 ${totalChanges}건 ${DRY_RUN ? '(dry-run, 실제 변경 없음)' : '실제 반영'} ===`);
