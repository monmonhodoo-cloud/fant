import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, orderBy, query } from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseConfig } from './firestoreConfig.mjs';
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
await signInWithEmailAndPassword(getAuth(app), process.env.FB_EMAIL, process.env.FB_PASS);
const snap = await getDocs(query(collection(db, 'meatTypes'), orderBy('sortOrder')));
snap.docs.forEach(d => {
  const m = d.data();
  console.log(`${(m.name||'?').padEnd(16)} id=${d.id}  active=${m.active??true}  cat=${m.category||'meat'}`);
});
