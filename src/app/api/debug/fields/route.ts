import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET() {
  const snapshot = await adminDb
    .collection("monthlyPayroll")
    .where("month", "==", "2026-02")
    .limit(300)
    .get();

  const groupByShortName = new Map<string, number>();
  const groupByCompanyName = new Map<string, number>();
  const samples: { name: string; companyName: string; companyShortName: string; branchName: string }[] = [];

  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const sn = data.companyShortName || "(なし)";
    const cn = data.companyName || "(なし)";
    groupByShortName.set(sn, (groupByShortName.get(sn) || 0) + 1);
    groupByCompanyName.set(cn, (groupByCompanyName.get(cn) || 0) + 1);
    if (samples.length < 10) {
      samples.push({
        name: data.name,
        companyName: cn,
        companyShortName: sn,
        branchName: data.branchName || "(なし)",
      });
    }
  });

  return NextResponse.json({
    total: snapshot.size,
    companyShortNames: Object.fromEntries([...groupByShortName].sort()),
    companyNames: Object.fromEntries([...groupByCompanyName].sort()),
    samples,
  });
}
