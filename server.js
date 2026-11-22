require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FirestoreSessionStore = require('./firestore-session-store');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { db, FieldValue, Timestamp } = require('./firebase');

const requiredSecrets = ['SESSION_SECRET'];
for (const name of requiredSecrets) {
  if (!process.env[name] || process.env[name].length < 32) {
    throw new Error(`${name} must be set to a random value of at least 32 characters.`);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const cookieSecure = process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';
const configRef = db.collection('electionConfig').doc('main');
const candidatesRef = db.collection('candidates');
const awardsRef = db.collection('awards');
const requiredAwardCount = 6;
const maxVotesPerAward = 55;
const votingDurationMs = 10 * 60 * 1000;
const sessionStore = new FirestoreSessionStore();
let autoCloseTimer;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: 'award.sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    maxAge: 8 * 60 * 60 * 1000
  }
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function timestampMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? null : millis;
}

function awardVoteCount(award) {
  const results = award.results || {};
  return Object.values(results).reduce((total, count) => total + Math.max(0, Number(count) || 0), 0);
}

function voteLimitReached(config, awards = []) {
  return Number(config.totalBallots || 0) >= maxVotesPerAward ||
    awards.some(award => awardVoteCount(award) >= maxVotesPerAward);
}

function publicStatus(config, awards = []) {
  const now = Date.now();
  const start = timestampMillis(config.startAt);
  const end = timestampMillis(config.endAt);
  return Boolean(config.isOpen) && !voteLimitReached(config, awards) &&
    (start === null || now >= start) && end !== null && now < end
    ? 'open'
    : 'closed';
}

function dateToIso(value) {
  const millis = timestampMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function dateToTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function validDocumentId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id);
}

async function getConfig() {
  const snapshot = await configRef.get();
  if (!snapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
  const config = snapshot.data();
  const end = timestampMillis(config.endAt);
  if (!config.isOpen || (end !== null && Date.now() < end)) return config;

  return db.runTransaction(async tx => {
    const currentSnapshot = await tx.get(configRef);
    if (!currentSnapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    const current = currentSnapshot.data();
    const currentEnd = timestampMillis(current.endAt);
    if (current.isOpen && (currentEnd === null || Date.now() >= currentEnd)) {
      tx.update(configRef, { isOpen: false, updatedAt: FieldValue.serverTimestamp() });
      return { ...current, isOpen: false };
    }
    return current;
  });
}

function scheduleAutoClose(deadline) {
  clearTimeout(autoCloseTimer);
  const deadlineMillis = timestampMillis(deadline);
  if (deadlineMillis === null) return;

  const closeExpiredVoting = async () => {
    try {
      const nextDeadline = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(configRef);
        if (!snapshot.exists) return null;
        const config = snapshot.data();
        if (!config.isOpen) return null;
        const currentEnd = timestampMillis(config.endAt);
        if (currentEnd !== null && Date.now() < currentEnd) return config.endAt;
        transaction.update(configRef, { isOpen: false, updatedAt: FieldValue.serverTimestamp() });
        return null;
      });
      if (nextDeadline) scheduleAutoClose(nextDeadline);
    } catch (error) {
      console.error(`Automatic voting closure failed: ${error.message}`);
      autoCloseTimer = setTimeout(closeExpiredVoting, 10000);
      if (typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
    }
  };

  autoCloseTimer = setTimeout(closeExpiredVoting, Math.max(0, deadlineMillis - Date.now()));
  if (typeof autoCloseTimer.unref === 'function') autoCloseTimer.unref();
}

async function getCandidates(transaction, ordered = true) {
  const query = ordered ? candidatesRef.orderBy('sortOrder') : candidatesRef;
  const snapshot = transaction ? await transaction.get(query) : await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getAwards(transaction) {
  const query = awardsRef.orderBy('sortOrder');
  const snapshot = transaction ? await transaction.get(query) : await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function createCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.session.csrfToken || token.length !== req.session.csrfToken.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))) {
    return res.status(403).json({ error: 'Your session expired. Refresh the page and try again.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Administrator sign-in required.' });
  next();
}

function toResults(candidates, voteCounts = null) {
  const counts = candidates.map(candidate =>
    Number(voteCounts ? voteCounts[candidate.id] || 0 : candidate.votes || 0) || 0);
  const totalVotes = counts.reduce((sum, votes) => sum + votes, 0);
  const results = candidates.map((candidate, index) => ({
    id: candidate.id,
    name: candidate.name,
    votes: counts[index],
    percentage: totalVotes ? counts[index] / totalVotes * 100 : 0
  }));
  const highest = results.length ? Math.max(...results.map(candidate => candidate.votes)) : 0;
  const leaders = results.filter(candidate => candidate.votes === highest && highest > 0);
  return { totalVotes, results, highest, leaders };
}

function summarizeAward(award, candidates, status) {
  const result = toResults(candidates, award.results || {});
  const winner = status === 'closed' && result.totalVotes > 0
    ? {
        tie: result.leaders.length > 1,
        candidates: result.leaders.map(candidate => candidate.name),
        votes: result.highest,
        percentage: result.highest / result.totalVotes * 100,
        totalVotes: result.totalVotes
      }
    : null;
  return {
    id: award.id,
    title: award.title,
    totalVotes: result.totalVotes,
    results: result.results,
    currentLeader: result.leaders.map(candidate => candidate.name).join(' / ') || 'No votes yet',
    winner
  };
}

async function deleteCollection(collectionRef) {
  let deleted = 0;
  while (true) {
    const snapshot = await collectionRef.limit(400).get();
    if (snapshot.empty) return deleted;
    const batch = db.batch();
    snapshot.docs.forEach(document => batch.delete(document.ref));
    await batch.commit();
    deleted += snapshot.size;
  }
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' }
});

app.get('/api/csrf', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: createCsrfToken(req) });
});

app.get('/api/public', asyncRoute(async (req, res) => {
  const [config, candidates, awards] = await Promise.all([getConfig(), getCandidates(), getAwards()]);
  const status = publicStatus(config, awards);
  const limitReached = voteLimitReached(config, awards);
  res.set('Cache-Control', 'no-store');
  res.json({
    status,
    totalBallots: Number(config.totalBallots || 0),
    maxVotesPerAward,
    limitReached,
    awards: awards.map(award => {
      const summary = summarizeAward(award, candidates, status);
      return {
        id: summary.id,
        title: summary.title,
        candidates: candidates.map(({ id, name }) => ({ id, name })),
        winner: summary.winner
      };
    }),
    startAt: dateToIso(config.startAt),
    endAt: dateToIso(config.endAt)
  });
}));

app.post('/api/login', loginLimiter, requireCsrf, asyncRoute(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username) || !password || password.length > 200) {
    return res.status(400).json({ error: 'Enter a valid username and password.' });
  }
  const adminSnapshot = await db.collection('admins').doc(username.toLowerCase()).get();
  const admin = adminSnapshot.exists ? adminSnapshot.data() : null;
  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.adminId = adminSnapshot.id;
  req.session.adminUsername = admin.username;
  const csrfToken = createCsrfToken(req);
  res.json({ authenticated: true, username: admin.username, csrfToken });
}));

app.get('/api/admin/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    authenticated: Boolean(req.session.adminId),
    username: req.session.adminUsername || null,
    csrfToken: createCsrfToken(req)
  });
});

app.post('/api/logout', requireAdmin, requireCsrf, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('award.sid', { httpOnly: true, sameSite: 'lax', secure: cookieSecure });
    res.json({ ok: true });
  });
});

app.use('/api/admin', requireAdmin);

app.get('/api/admin/summary', asyncRoute(async (req, res) => {
  const [config, candidates, awards] = await Promise.all([getConfig(), getCandidates(), getAwards()]);
  const status = publicStatus(config, awards);
  const awardSummaries = awards.map(award => summarizeAward(award, candidates, status));
  res.set('Cache-Control', 'no-store');
  res.json({
    totalVotes: Number(config.totalBallots || 0),
    candidateCount: candidates.length,
    awardCount: awards.length,
    status,
    hasStarted: Boolean(config.hasStarted),
    awards: awardSummaries,
    startAt: dateToIso(config.startAt),
    endAt: dateToIso(config.endAt)
  });
}));

app.put('/api/admin/awards/:id', requireCsrf, asyncRoute(async (req, res) => {
  const id = req.params.id;
  const title = typeof req.body.title === 'string' ? req.body.title.trim().replace(/\s+/g, ' ') : '';
  if (!validDocumentId(id) || title.length < 2 || title.length > 120) {
    return res.status(400).json({ error: 'Enter an award name between 2 and 120 characters.' });
  }
  const awardRef = awardsRef.doc(id);
  await db.runTransaction(async transaction => {
    const [config, award] = await Promise.all([
      transaction.get(configRef),
      transaction.get(awardRef)
    ]);
    if (!config.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    if (config.data().hasStarted) throw new HttpError(409, 'Award names are locked after voting has started. Reset the election to edit them.');
    if (!award.exists) throw new HttpError(404, 'Award not found.');
    transaction.update(awardRef, { title, updatedAt: FieldValue.serverTimestamp() });
  });
  res.json({ ok: true });
}));

app.get('/api/admin/candidates', asyncRoute(async (req, res) => {
  const candidates = await getCandidates();
  res.json({ candidates: candidates.map(({ id, name }) => ({ id, name })) });
}));

app.put('/api/admin/candidates/:id', requireCsrf, asyncRoute(async (req, res) => {
  const id = req.params.id;
  const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
  if (!validDocumentId(id) || name.length < 2 || name.length > 120) {
    return res.status(400).json({ error: 'Enter a candidate name between 2 and 120 characters.' });
  }
  const candidateRef = candidatesRef.doc(id);
  await db.runTransaction(async transaction => {
    const [config, candidate] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidateRef)
    ]);
    if (!config.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    if (config.data().hasStarted) throw new HttpError(409, 'Candidate names are locked after voting has started.');
    if (!candidate.exists) throw new HttpError(404, 'Candidate not found.');
    transaction.update(candidateRef, { name, updatedAt: FieldValue.serverTimestamp() });
  });
  res.json({ ok: true });
}));

app.post('/api/admin/candidates', requireCsrf, asyncRoute(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ error: 'Enter a name between 2 and 120 characters.' });
  }
  const candidateRef = candidatesRef.doc(crypto.randomBytes(12).toString('hex'));
  await db.runTransaction(async transaction => {
    const [config, candidates, awards] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidatesRef.orderBy('sortOrder')),
      transaction.get(awardsRef.orderBy('sortOrder'))
    ]);
    if (!config.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    if (config.data().hasStarted) throw new HttpError(409, 'Candidates are locked after voting has started.');
    if (candidates.size >= 3) throw new HttpError(409, 'There are already three candidates. Remove one before adding another.');
    const nextOrder = candidates.docs.reduce((highest, doc) => Math.max(highest, Number(doc.get('sortOrder') || 0)), 0) + 1;
    transaction.create(candidateRef, {
      name,
      votes: 0,
      sortOrder: nextOrder,
      createdAt: FieldValue.serverTimestamp()
    });
    awards.docs.forEach(award => {
      transaction.update(award.ref, { [`results.${candidateRef.id}`]: 0 });
    });
  });
  res.status(201).json({ ok: true });
}));

app.delete('/api/admin/candidates/:id', requireCsrf, asyncRoute(async (req, res) => {
  const id = req.params.id;
  if (!validDocumentId(id)) return res.status(400).json({ error: 'Invalid candidate.' });
  const candidateRef = candidatesRef.doc(id);
  await db.runTransaction(async transaction => {
    const [config, candidate, candidates, awards] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidateRef),
      transaction.get(candidatesRef.orderBy('sortOrder')),
      transaction.get(awardsRef.orderBy('sortOrder'))
    ]);
    if (!config.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    if (config.data().hasStarted) throw new HttpError(409, 'Candidates are locked after voting has started.');
    if (!candidate.exists) throw new HttpError(404, 'Candidate not found.');
    if (candidates.size <= 1) throw new HttpError(409, 'At least one candidate must remain.');
    transaction.delete(candidateRef);
    awards.docs.forEach(award => {
      transaction.update(award.ref, { [`results.${id}`]: FieldValue.delete() });
    });
  });
  res.json({ ok: true });
}));

app.put('/api/admin/schedule', requireCsrf, asyncRoute(async (req, res) => {
  const startAt = req.body.startAt ? dateToTimestamp(req.body.startAt) : null;
  if (req.body.startAt && !startAt) return res.status(400).json({ error: 'Enter a valid start date.' });
  await db.runTransaction(async transaction => {
    const configSnapshot = await transaction.get(configRef);
    if (!configSnapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    if (publicStatus(configSnapshot.data()) === 'open') {
      throw new HttpError(409, 'Close voting before changing its schedule.');
    }
    transaction.update(configRef, {
      startAt,
      endAt: null,
      isOpen: false,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  scheduleAutoClose(null);
  res.json({ ok: true });
}));

app.post('/api/admin/voting/:action', requireCsrf, asyncRoute(async (req, res) => {
  const action = req.params.action;
  if (!['start', 'close', 'reopen'].includes(action)) {
    return res.status(404).json({ error: 'Unknown voting action.' });
  }
  let endAt = null;
  await db.runTransaction(async transaction => {
    const [configSnapshot, candidates, awards] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidatesRef.orderBy('sortOrder')),
      transaction.get(awardsRef.orderBy('sortOrder'))
    ]);
    if (!configSnapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    const config = configSnapshot.data();
    if (action !== 'close' && voteLimitReached(config, awards.docs.map(award => award.data()))) {
      throw new HttpError(409, `The maximum of ${maxVotesPerAward} votes per award has been reached.`);
    }
    if (action !== 'close' && candidates.size !== 3) {
      throw new HttpError(409, 'Exactly three candidates are required before voting can open.');
    }
    if (action !== 'close' && awards.size !== requiredAwardCount) {
      throw new HttpError(409, `Exactly ${requiredAwardCount} awards are required before voting can open.`);
    }
    if (action !== 'close' && config.startAt && Date.now() < timestampMillis(config.startAt)) {
      throw new HttpError(409, 'Voting cannot open before its configured start date.');
    }
    if (action === 'start' || action === 'reopen') {
      endAt = Timestamp.fromDate(new Date(Date.now() + votingDurationMs));
      transaction.update(configRef, {
        isOpen: true,
        hasStarted: true,
        endAt,
        updatedAt: FieldValue.serverTimestamp()
      });
    } else {
      transaction.update(configRef, {
        isOpen: false,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
  });
  scheduleAutoClose(action === 'close' ? null : endAt);
  res.json({ ok: true });
}));

app.post('/api/admin/reset', requireCsrf, asyncRoute(async (req, res) => {
  await db.runTransaction(async transaction => {
    const [configSnapshot, candidates, awards] = await Promise.all([
      transaction.get(configRef),
      transaction.get(candidatesRef.orderBy('sortOrder')),
      transaction.get(awardsRef.orderBy('sortOrder'))
    ]);
    if (!configSnapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    awards.docs.forEach(award => {
      const results = Object.fromEntries(candidates.docs.map(candidate => [candidate.id, 0]));
      transaction.update(award.ref, { results });
    });
    transaction.update(configRef, {
      isOpen: false,
      hasStarted: false,
      totalBallots: 0,
      endAt: null,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  scheduleAutoClose(null);
  await Promise.all([
    deleteCollection(db.collection('votes')),
    deleteCollection(db.collection('voters'))
  ]);
  res.json({ ok: true });
}));

app.get('/api/admin/export.csv', asyncRoute(async (req, res) => {
  const [candidates, awards] = await Promise.all([getCandidates(), getAwards()]);
  const quote = value => {
    const safeValue = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${String(safeValue).replace(/"/g, '""')}"`;
  };
  const lines = [
    ['Award', 'Candidate name', 'Votes', 'Percentage'].map(quote).join(',')
  ];
  awards.forEach(award => {
    const result = toResults(candidates, award.results || {});
    result.results.forEach(candidate => {
      lines.push([
        award.title,
        candidate.name,
        candidate.votes,
        candidate.percentage.toFixed(2) + '%'
      ].map(quote).join(','));
    });
  });
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="award-voting-results.csv"',
    'Cache-Control': 'no-store'
  });
  res.send(`\uFEFF${lines.join('\r\n')}`);
}));

app.post('/api/vote', requireCsrf, asyncRoute(async (req, res) => {
  const voterName = typeof req.body.voterName === 'string'
    ? req.body.voterName.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';
  const nameParts = voterName.split(' ');
  if (voterName.length < 3 || voterName.length > 120 ||
      nameParts.length < 2 || /[\u0000-\u001f\u007f]/.test(voterName)) {
    return res.status(400).json({ error: 'Enter the voter’s full name (first and last name, 3 to 120 characters).' });
  }
  const selections = req.body.selections;
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
    return res.status(400).json({ error: 'Choose one candidate for every award.' });
  }
  if (Object.keys(selections).length !== requiredAwardCount) {
    return res.status(400).json({ error: `Select one nominee for all ${requiredAwardCount} awards before submitting.` });
  }
  const limitReached = await db.runTransaction(async transaction => {
    const configSnapshot = await transaction.get(configRef);
    if (!configSnapshot.exists) throw new Error('Firestore election configuration is missing. Run npm run initialize-db.');
    const config = configSnapshot.data();
    if (Number(config.totalBallots || 0) >= maxVotesPerAward) {
      throw new HttpError(409, `The maximum of ${maxVotesPerAward} votes per award has been reached.`);
    }

    const [awardSnapshot, candidateSnapshot] = await Promise.all([
      transaction.get(awardsRef.orderBy('sortOrder')),
      transaction.get(candidatesRef.orderBy('sortOrder'))
    ]);
    if (awardSnapshot.size !== requiredAwardCount || candidateSnapshot.size !== 3) {
      throw new HttpError(409, 'The six-award ballot is not ready for voting.');
    }
    const awardData = awardSnapshot.docs.map(award => award.data());
    if (voteLimitReached(config, awardData)) {
      throw new HttpError(409, `The maximum of ${maxVotesPerAward} votes per award has been reached.`);
    }
    if (publicStatus(config, awardData) !== 'open') throw new HttpError(409, 'Voting is currently closed.');
    const candidateIds = new Set(candidateSnapshot.docs.map(candidate => candidate.id));
    const awardIds = new Set(awardSnapshot.docs.map(award => award.id));
    if (Object.keys(selections).some(id => !awardIds.has(id))) {
      throw new HttpError(400, 'The ballot contains an unknown award.');
    }
    const missingAward = awardSnapshot.docs.find(award =>
      !Object.prototype.hasOwnProperty.call(selections, award.id)
    );
    if (missingAward) throw new HttpError(400, `Choose one candidate for ${missingAward.get('title')}.`);
    if (Object.keys(selections).length !== requiredAwardCount) {
      throw new HttpError(400, `Choose exactly one candidate for each of the ${requiredAwardCount} awards.`);
    }
    const ballot = {};
    for (const award of awardSnapshot.docs) {
      const candidateId = selections[award.id];
      if (typeof candidateId !== 'string' || !validDocumentId(candidateId) || !candidateIds.has(candidateId)) {
        throw new HttpError(400, `Choose a valid candidate for ${award.get('title')}.`);
      }
      ballot[award.id] = candidateId;
    }
    const voterKey = crypto.createHash('sha256').update(voterName.toLowerCase('en-US')).digest('hex');
    const voterRef = db.collection('voters').doc(voterKey);
    const voterSnapshot = await transaction.get(voterRef);
    if (voterSnapshot.exists) {
      throw new HttpError(409, 'This voter name has already submitted a ballot.');
    }
    const voteRef = db.collection('votes').doc(crypto.randomBytes(16).toString('hex'));
    transaction.create(voteRef, {
      voterName,
      selections: ballot,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(voterRef, {
      name: voterName,
      createdAt: FieldValue.serverTimestamp()
    });
    awardSnapshot.docs.forEach(award => {
      transaction.update(award.ref, {
        [`results.${ballot[award.id]}`]: FieldValue.increment(1)
      });
    });
    const nextBallotCount = Number(config.totalBallots || 0) + 1;
    const limitWillBeReached = nextBallotCount >= maxVotesPerAward ||
      awardData.some(award => awardVoteCount(award) + 1 >= maxVotesPerAward);
    transaction.update(configRef, {
      totalBallots: FieldValue.increment(1),
      ...(limitWillBeReached ? {
        isOpen: false,
        endAt: null,
        updatedAt: FieldValue.serverTimestamp()
      } : {})
    });
    return limitWillBeReached;
  });
  if (limitReached) scheduleAutoClose(null);
  res.json({ ok: true, awardsVoted: requiredAwardCount, limitReached });
}));

app.use(express.static(path.join(__dirname, 'dist'), { index: false }));
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
app.get('/Votings.html', (req, res) => res.redirect(302, '/'));

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  console.error(error.message);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({
    error: error.status ? error.message : 'The request could not be completed. Please try again.'
  });
});

async function start() {
  const config = await getConfig();
  if (config.isOpen) scheduleAutoClose(config.endAt);
  app.listen(port, () => console.log(`Award Voting System listening on http://localhost:${port}`));
}

start().catch(error => {
  console.error(`Unable to start: ${error.message}`);
  process.exit(1);
});
