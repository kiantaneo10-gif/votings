import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyB7J2mjCm8zD_gxEY66Q4PxxdMMKTWSD9k",
  authDomain: "votings-1.onrender.com",
  projectId: "votings-a4db3",
  storageBucket: "votings-a4db3.firebasestorage.app",
  messagingSenderId: "524100923505",
  appId: "1:524100923505:web:ccfb6b8732a9bd3907ebd0",
  measurementId: "G-D38479MLS7"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
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
  const result = await getRedirectResult(auth);
  if (result) voter = result.user;
  return result ? result.user : null;
}

export async function signInWithGoogle() {
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
  if (!user) return null;
  return user.getIdToken();
}

export async function signOutVoter() {
  await signOut(auth);
  voter = null;
}
