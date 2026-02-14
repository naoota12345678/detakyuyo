import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function parsePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  // Try JSON parse first (handles double-quoted/escaped strings)
  try {
    const parsed = JSON.parse(key);
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON, continue
  }
  // Fall back to manual \n replacement
  return key.replace(/\\n/g, "\n").trim();
}

const apps = getApps();

if (apps.length === 0) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: parsePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    }),
  });
}

export const adminDb = getFirestore("detakyuyo");
export const adminAuth = getAuth();
