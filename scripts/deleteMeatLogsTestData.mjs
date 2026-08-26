import fs from 'node:fs/promises';
import admin from 'firebase-admin';
import { timestampForPath } from './firestoreConfig.mjs';

const PROJECT_ID = 'fant-e5ae5';
const COLLECTION = 'meatLogs';
const BATCH_LIMIT = 450;

function hasArg(name) {
  return process.argv.includes(name);
}

async function deleteInBatches(db, docs) {
  let deleted = 0;
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const slice = docs.slice(i, i + BATCH_LIMIT);
    for (const doc of slice) batch.delete(doc.ref);
    await batch.commit();
    deleted += slice.length;
    console.log(`[meatlogs-delete] deleted ${deleted}/${docs.length}`);
  }
}

function summarizeDocs(docs) {
  const byDate = new Map();
  for (const doc of docs) {
    const data = doc.data();
    const date = data.date || data.createdDate || data.timestamp?.toDate?.().toISOString().slice(0, 10) || '(no date)';
    byDate.set(date, (byDate.get(date) || 0) + 1);
  }
  return [...byDate.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}

async function main() {
  const execute = hasArg('--execute');

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: PROJECT_ID,
  });

  const db = admin.firestore();
  const docs = (await db.collection(COLLECTION).get()).docs;

  console.log(`[meatlogs-delete] mode: ${execute ? 'execute' : 'dry-run'}`);
  console.log(`[meatlogs-delete] project: ${PROJECT_ID}`);
  console.log(`[meatlogs-delete] ${COLLECTION}: ${docs.length}`);
  for (const [date, count] of summarizeDocs(docs).slice(0, 50)) {
    console.log(`  - ${date}: ${count}`);
  }

  const backupPath = `meatlogs-delete-backup-${timestampForPath()}.json`;
  await fs.writeFile(
    backupPath,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      projectId: PROJECT_ID,
      collection: COLLECTION,
      docs: docs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: doc.data() })),
    }, null, 2),
    'utf8',
  );
  console.log(`[meatlogs-delete] backup written: ${backupPath}`);

  if (!execute) {
    console.log('[meatlogs-delete] dry-run only. No documents deleted.');
    return;
  }

  await deleteInBatches(db, docs);
  console.log('[meatlogs-delete] done');
}

main().catch((err) => {
  console.error('[meatlogs-delete] failed:', err);
  process.exit(1);
});
