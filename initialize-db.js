require('dotenv').config();
const { db, FieldValue, projectId, Timestamp } = require('./firebase');

const seedCandidates = ['Avery Bennett', 'Jordan Ellis', 'Riley Carter'];
const seedAwards = [
  "People's Choice Award",
  'Best Performer',
  'Best Singer',
  'Best Dancer',
  'Best Host',
  'Rising Star'
];
const configRef = db.collection('electionConfig').doc('main');
const candidatesRef = db.collection('candidates');
const awardsRef = db.collection('awards');
const votesRef = db.collection('votes');

async function main() {
  await db.runTransaction(async transaction => {
    const [configSnapshot, candidateSnapshot, awardSnapshot, existingVotes] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidatesRef.orderBy('sortOrder')),
      transaction.get(awardsRef),
      transaction.get(votesRef.limit(1))
    ]);

    if (awardSnapshot.empty && !existingVotes.empty) {
      throw new Error('Legacy single-award votes exist. Export or reset the old election before creating the six-award ballot.');
    }

    if (!configSnapshot.exists) {
      transaction.create(configRef, {
        awardTitle: "People's Choice Award",
        isOpen: false,
        hasStarted: false,
        startAt: Timestamp.now(),
        endAt: null,
        totalBallots: 0,
        updatedAt: FieldValue.serverTimestamp()
      });
    } else if (typeof configSnapshot.get('totalBallots') !== 'number') {
      transaction.update(configRef, { totalBallots: 0 });
    }

    if (candidateSnapshot.empty) {
      seedCandidates.forEach((name, index) => {
        transaction.create(candidatesRef.doc(`candidate-${index + 1}`), {
          name,
          votes: 0,
          sortOrder: index + 1,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    }

    if (awardSnapshot.size > seedAwards.length) {
      throw new Error(`Found ${awardSnapshot.size} awards; exactly ${seedAwards.length} are supported.`);
    }

    const candidateIds = candidateSnapshot.empty
      ? seedCandidates.map((_, index) => `candidate-${index + 1}`)
      : candidateSnapshot.docs.map(candidate => candidate.id);
    const candidateNames = new Map(candidateSnapshot.empty
      ? seedCandidates.map((name, index) => [`candidate-${index + 1}`, name])
      : candidateSnapshot.docs.map(candidate => [candidate.id, candidate.get('name')]));
    const existingAwards = new Map(awardSnapshot.docs.map(award => [award.id, award]));
    if ([...existingAwards.keys()].some(id => !seedAwards.some((_, index) => id === `award-${index + 1}`))) {
      throw new Error('Unexpected award document IDs found. Resolve them before initializing the six-award ballot.');
    }
    seedAwards.forEach((title, index) => {
      const id = `award-${index + 1}`;
      const existing = existingAwards.get(id);
      if (!existing) {
        transaction.create(awardsRef.doc(id), {
          title,
          sortOrder: index + 1,
          nominees: candidateIds.map(candidateId => ({
            id: candidateId,
            name: candidateNames.get(candidateId)
          })),
          results: Object.fromEntries(candidateIds.map(candidateId => [candidateId, 0])),
          createdAt: FieldValue.serverTimestamp()
        });
        return;
      }

      const awardData = existing.data();
      const results = { ...(awardData.results || {}) };
      candidateIds.forEach(candidateId => {
        if (typeof results[candidateId] !== 'number') results[candidateId] = 0;
      });
      const nominees = Array.isArray(awardData.nominees) && awardData.nominees.length
        ? awardData.nominees
        : candidateIds.map(candidateId => ({
            id: candidateId,
            name: candidateNames.get(candidateId)
          }));
      if (!awardData.sortOrder || JSON.stringify(results) !== JSON.stringify(awardData.results || {}) ||
          JSON.stringify(nominees) !== JSON.stringify(awardData.nominees || [])) {
        transaction.update(existing.ref, {
          sortOrder: awardData.sortOrder || index + 1,
          nominees,
          results
        });
      }
    });
  });

  const [config, candidates, awards] = await Promise.all([
    configRef.get(),
    candidatesRef.orderBy('sortOrder').get(),
    awardsRef.orderBy('sortOrder').get()
  ]);
  if (!config.exists) throw new Error('Firestore election configuration was not initialized.');
  console.log(`Firestore initialized for project ${projectId}: ${awards.size} awards and ${candidates.size} candidates.`);
}

main().catch(error => {
  console.error(`Could not initialize Firestore: ${error.message}`);
  process.exitCode = 1;
});
