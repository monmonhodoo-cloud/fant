import fs from 'node:fs/promises';
import admin from 'firebase-admin';
import { timestampForPath } from './firestoreConfig.mjs';

const PROJECT_ID = 'fant-e5ae5';
const BATCH_LIMIT = 450;

function hasArg(name) {
  return process.argv.includes(name);
}

async function listAll(query) {
  const snap = await query.get();
  return snap.docs;
}

async function deleteInBatches(db, label, docs) {
  let deleted = 0;
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const slice = docs.slice(i, i + BATCH_LIMIT);
    for (const doc of slice) batch.delete(doc.ref);
    await batch.commit();
    deleted += slice.length;
    console.log(`[production-delete] ${label}: deleted ${deleted}/${docs.length}`);
  }
}

function summarizeDocs(docs, dateField = 'date') {
  const byDate = new Map();
  for (const doc of docs) {
    const data = doc.data();
    const date = data[dateField] || data.runDate || '(no date)';
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

  const productions = await listAll(db.collection('productions'));
  const completions = await listAll(db.collection('productionCompletion'));
  const transferRequests = await listAll(
    db.collection('productTransferRequests').where('sourceCollection', '==', 'productions'),
  );

  const targets = [
    { label: 'productions', docs: productions },
    { label: 'productionCompletion', docs: completions },
    { label: 'productTransferRequests(sourceCollection=productions)', docs: transferRequests },
  ];

  console.log(`[production-delete] mode: ${execute ? 'execute' : 'dry-run'}`);
  console.log(`[production-delete] project: ${PROJECT_ID}`);
  for (const target of targets) {
    console.log(`  - ${target.label}: ${target.docs.length}`);
    for (const [date, count] of summarizeDocs(target.docs).slice(0, 20)) {
      console.log(`      ${date}: ${count}`);
    }
  }

  const total = targets.reduce((sum, target) => sum + target.docs.length, 0);
  console.log(`[production-delete] total target docs: ${total}`);

  const backup = {
    createdAt: new Date().toISOString(),
    projectId: PROJECT_ID,
    targets: Object.fromEntries(
      targets.map((target) => [
        target.label,
        target.docs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: doc.data() })),
      ]),
    ),
  };
  const backupPath = `production-input-delete-backup-${timestampForPath()}.json`;
  await fs.writeFile(backupPath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`[production-delete] backup written: ${backupPath}`);

  if (!execute) {
    console.log('[production-delete] dry-run only. No documents deleted.');
    return;
  }

  for (const target of targets) {
    await deleteInBatches(db, target.label, target.docs);
  }

  console.log('[production-delete] done');
}

main().catch((err) => {
  console.error('[production-delete] failed:', err);
  process.exit(1);
});
