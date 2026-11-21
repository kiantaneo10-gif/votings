const session = require('express-session');
const { db, Timestamp } = require('./firebase');

const sessionTtlMs = 8 * 60 * 60 * 1000;

function expiryFor(sessionData) {
  const expiry = sessionData.cookie && sessionData.cookie.expires
    ? new Date(sessionData.cookie.expires)
    : new Date(Date.now() + sessionTtlMs);
  return Number.isNaN(expiry.getTime()) ? new Date(Date.now() + sessionTtlMs) : expiry;
}

class FirestoreSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = db.collection('sessions');
  }

  get(sessionId, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    const ref = this.sessions.doc(sessionId);
    ref.get().then(snapshot => {
      if (!snapshot.exists) return done(null, null);
      const record = snapshot.data();
      if (!record.expiresAt || record.expiresAt.toMillis() <= Date.now()) {
        return ref.delete().then(() => done(null, null));
      }
      done(null, record.session);
    }).catch(done);
  }

  set(sessionId, sessionData, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    let serializableSession;
    try {
      serializableSession = JSON.parse(JSON.stringify(sessionData));
    } catch (error) {
      return done(error);
    }
    this.sessions.doc(sessionId).set({
      session: serializableSession,
      expiresAt: Timestamp.fromDate(expiryFor(sessionData))
    }).then(() => done(null)).catch(done);
  }

  touch(sessionId, sessionData, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    this.sessions.doc(sessionId).set({
      expiresAt: Timestamp.fromDate(expiryFor(sessionData))
    }, { merge: true }).then(() => done(null)).catch(done);
  }

  destroy(sessionId, callback) {
    const done = typeof callback === 'function' ? callback : () => {};
    this.sessions.doc(sessionId).delete().then(() => done(null)).catch(done);
  }
}

module.exports = FirestoreSessionStore;
