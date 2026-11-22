import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  RecaptchaVerifier,
  signInWithPhoneNumber,
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
const auth = getAuth(app);

let voter = null;
let phoneAuthUser = null;
let phoneConfirmation = null;
let phoneRecaptcha = null;
let resolveAuthReady;
const authReady = new Promise(resolve => { resolveAuthReady = resolve; });
let authInitialized = false;

onAuthStateChanged(auth, user => {
  voter = user;
  phoneAuthUser = null;
  if (!authInitialized) {
    authInitialized = true;
    resolveAuthReady();
  }
});

export async function getCurrentVoter() {
  await authReady;
  if (!voter) return null;
  if (phoneAuthUser !== voter) {
    const token = await voter.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'phone') {
      await signOut(auth);
      voter = null;
      return null;
    }
    phoneAuthUser = voter;
  }
  return voter;
}

export async function sendPhoneVerificationCode(phoneNumber) {
  const normalizedPhoneNumber = phoneNumber.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhoneNumber)) {
    throw new Error('Enter your phone number in international format, starting with + and your country code.');
  }

  try {
    if (!phoneRecaptcha) await initializePhoneRecaptcha();
    phoneConfirmation = await signInWithPhoneNumber(auth, normalizedPhoneNumber, phoneRecaptcha);
  } catch (error) {
    resetPhoneVerification();
    throw error;
  }
}

export async function verifyPhoneVerificationCode(code) {
  if (!phoneConfirmation) throw new Error('Request an SMS verification code first.');
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error('Enter the six-digit verification code from your SMS.');
  }
  const result = await phoneConfirmation.confirm(normalizedCode);
  voter = result.user;
  phoneConfirmation = null;
  return result.user;
}

export async function initializePhoneRecaptcha() {
  if (!phoneRecaptcha) {
    phoneRecaptcha = new RecaptchaVerifier(auth, 'phone-recaptcha-container', {});
  }
  await phoneRecaptcha.render();
}

export function resetPhoneVerification() {
  phoneConfirmation = null;
  if (phoneRecaptcha) {
    phoneRecaptcha.clear();
    phoneRecaptcha = null;
  }
}

export async function getVoterIdToken() {
  const user = await getCurrentVoter();
  if (!user) return null;
  return user.getIdToken();
}

export async function signOutVoter() {
  await signOut(auth);
  voter = null;
  phoneAuthUser = null;
  resetPhoneVerification();
}
