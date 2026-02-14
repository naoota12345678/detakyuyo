import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET() {
  const doc = await adminDb.collection("appSettings").doc("companyAliases").get();
  return NextResponse.json(doc.exists ? doc.data() : { empty: true });
}
