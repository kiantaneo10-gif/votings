import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
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
const auth = Capacitor.isNativePlatform()
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

let voter = null;
let resolveAuthReady;
const authReady = new Promise(resolve => { resolveAuthReady = resolve; });
let authInitialized = false;

onAuthStateChanged(auth, user => {
  voter = user;
  if (!authInitialized) {
    authInitialized = true;
    resolveAuthReady();
  }
});

export async function getCurrentVoter() {
  await authReady;
  return voter;
}

export async function completeGoogleRedirect() {
  if (Capacitor.isNativePlatform()) return null;
  const result = await getRedirectResult(auth);
  if (result) voter = result.user;
  return result ? result.user : null;
}

export async function signInWithGoogle() {
  if (Capacitor.isNativePlatform()) {
    const result = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true });
    const idToken = result.credential && result.credential.idToken;
    if (!idToken) throw new Error('Google sign-in did not return an ID token. Check the native Firebase app configuration.');
    const credential = GoogleAuthProvider.credential(idToken);
    const userCredential = await signInWithCredential(auth, credential);
    voter = userCredential.user;
    return voter;
  }

  const mobileBrowser = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
  if (mobileBrowser) {
    await signInWithRedirect(auth, provider);
    return null;
  }
  const result = await signInWithPopup(auth, provider);
  voter = result.user;
  return result.user;
}

export async function getVoterIdToken() {
  const user = await getCurrentVoter();
  return user ? user.getIdToken() : null;
}

export async function signOutVoter() {
  await signOut(auth);
  voter = null;
}
