import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyB7J2mjCm8zD_gxEY66Q4PxxdMMKTWSD9k",
  authDomain: "votings-a4db3.firebaseapp.com",
  projectId: "votings-a4db3",
  storageBucket: "votings-a4db3.firebasestorage.app",
  messagingSenderId: "524100923505",
  appId: "1:524100923505:web:ccfb6b8732a9bd3907ebd0",
  measurementId: "G-D38479MLS7"
};

const app = initializeApp(firebaseConfig);
const isNativePlatform = Capacitor.isNativePlatform();
const auth = isNativePlatform ? null : getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

let voter = null;
let authReady = Promise.resolve();

if (!isNativePlatform) {
  let resolveAuthReady;
  authReady = new Promise(resolve => { resolveAuthReady = resolve; });
  let authInitialized = false;

  onAuthStateChanged(auth, user => {
    voter = user;
    if (!authInitialized) {
      authInitialized = true;
      resolveAuthReady();
    }
  });
}

export async function getCurrentVoter() {
  if (isNativePlatform) {
    const result = await FirebaseAuthentication.getCurrentUser();
    voter = result.user;
    return voter;
  }
  await authReady;
  return voter;
}

export async function completeGoogleRedirect() {
  if (isNativePlatform) return null;
  const result = await getRedirectResult(auth);
  if (result) voter = result.user;
  return result ? result.user : null;
}

export async function signInWithGoogle() {
  if (isNativePlatform) {
    const result = await FirebaseAuthentication.signInWithGoogle();
    if (!result.user) {
      throw new Error('Google sign-in completed without a Firebase user. Check the native Firebase app configuration.');
    }
    voter = result.user;
    return voter;
  }

  const result = await signInWithPopup(auth, provider);
  voter = result.user;
  return result.user;
}

export async function getVoterIdToken() {
  const user = await getCurrentVoter();
  if (!user) return null;
  if (isNativePlatform) {
    const result = await FirebaseAuthentication.getIdToken();
    return result.token || null;
  }
  return user.getIdToken();
}

export async function signOutVoter() {
  if (isNativePlatform) {
    await FirebaseAuthentication.signOut();
  } else {
    await signOut(auth);
  }
  voter = null;
}
