require('dotenv').config();
const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, FieldValue, getFirestore, Timestamp } = require('firebase-admin/firestore');

const projectId = process.env.FIREBASE_PROJECT_ID || 'votings-a4db3';
const app = getApps().length
  ? getApps()[0]
  : initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

module.exports = { app, db, FieldPath, FieldValue, projectId, Timestamp };
