/**
 * fixRecipeMeatTypeLinks2.mjs — 2차 수정본
 * meatTypeId 일괄 연결 + autoDeductInventory 정규화
 */
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseConfig } from './firestoreConfig.mjs';

const DRY_RUN = process.env.DRY_RUN !== 'false';
console.log(`=== ${DRY_RUN ? 'DRY-RUN' : '🔴 EXECUTE'} ===\n`);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
await signInWithEmailAndPassword(getAuth(app), process.env.FB_EMAIL, process.env.FB_PASS);
console.log('로그인 성공');

const NAME_MAP = {
  '닭가슴살':  'lUhCdoVSEW5LgOj6hyhU',
  '닭정육':    'NGqsI0cRjnqu7XlTAZw0',
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

const RENAME_MAP = {
  '자른토끼내장': '토끼내장',
  '자른양간':     '양간',
  '자른양염통':   '양염통',
  '오리정육':     '오리로스',
};

// 재고 추적 안 함 → autoDeductInventory 무조건 false
const NO_DEDUCT = new Set(['소고기', '돼지안심', '물', '정제수', '노른자']);

const recipeSnap = await getDocs(collection(db, 'recipes'));
let updated = 0;

for (const rdoc of recipeSnap.docs) {
  const r = rdoc.data();
  if (r.status === 'deleted') continue;

  let changed = false;
  const newIngredients = (r.ingredients || []).map(ing => {
    let name = ing.name;
    let meatTypeId = ing.meatTypeId || null;
    let autoDeductInventory = ing.autoDeductInventory ?? true;

    // 1. 이름 rename
    if (RENAME_MAP[name]) {
      name = RENAME_MAP[name];
      changed = true;
    }

    // 2. no-deduct 강제
    if (NO_DEDUCT.has(name)) {
      if (autoDeductInventory !== false) { autoDeductInventory = false; changed = true; }
      return { ...ing, name, meatTypeId: null, autoDeductInventory };
    }

    // 3. meatTypeId 연결
    const mappedId = NAME_MAP[name];
    if (mappedId && meatTypeId !== mappedId) {
      meatTypeId = mappedId;
      autoDeductInventory = true;
      changed = true;
    }

    return { ...ing, name, meatTypeId, autoDeductInventory };
  });

  if (changed) {
    console.log(`수정: [${r.name}] (doc=${rdoc.id})`);
    newIngredients.forEach(ing => {
      if (NAME_MAP[ing.name] && !ing.meatTypeId) console.log(`  ⚠️ 미연결: ${ing.name}`);
    });
    if (!DRY_RUN) {
      await updateDoc(doc(db, 'recipes', rdoc.id), { ingredients: newIngredients, updatedAt: new Date() });
    }
    updated++;
  }
}

console.log(`\n완료: ${updated}개 레시피 ${DRY_RUN ? '(dry-run)' : '저장됨'}`);
