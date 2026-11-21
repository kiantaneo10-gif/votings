require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, FieldValue } = require('./firebase');

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !/^[a-zA-Z0-9._-]{3,80}$/.test(username) || !password || password.length < 12) {
    throw new Error('Set ADMIN_USERNAME (3–80 letters, numbers, dot, underscore or dash) and an ADMIN_PASSWORD of at least 12 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const adminRef = db.collection('admins').doc(username.toLowerCase());
  await adminRef.set({
    username,
    passwordHash,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  console.log(`Administrator "${username}" is ready in Firestore.`);
}

main().catch(error => {
  console.error(`Could not create administrator: ${error.message}`);
  process.exitCode = 1;
});
