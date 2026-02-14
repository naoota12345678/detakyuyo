import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function getCredential() {
  const base64 = process.env.FIREBASE_PRIVATE_KEY;
  if (!base64) throw new Error("FIREBASE_PRIVATE_KEY is not set");

  // Base64 → JSON文字列 → オブジェクト
  const json = Buffer.from(base64, "base64").toString("utf-8");
  const serviceAccount = JSON.parse(json);

  return cert({
    projectId: serviceAccount.project_id,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  });
}

const apps = getApps();

if (apps.length === 0) {
  initializeApp({ credential: getCredential() });
}

export const adminDb = getFirestore("detakyuyo");
export const adminAuth = getAuth();
