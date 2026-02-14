import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET() {
  const snapshot = await adminDb.collection("companySettings").get();
  const data = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  // ノースワン関連だけフィルタ
  const filtered = data.filter((d: Record<string, unknown>) => {
    const name = String(d.shortName || d.officialName || "");
    return name.includes("ノースワン") || name.includes("ノース");
  });
  return NextResponse.json({ total: data.length, filtered });
}
