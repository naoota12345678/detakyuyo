import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET() {
  const payrollSnapshot = await adminDb
    .collection("monthlyPayroll")
    .where("month", "==", "2026-02")
    .get();

  // branchName と companyShortName が異なるレコードを探す
  const mismatched: { name: string; branchName: string; companyShortName: string; companyName: string }[] = [];
  const companyShortNames = new Set<string>();

  payrollSnapshot.docs.forEach((doc) => {
    const data = doc.data();
    const branch = data.branchName || "";
    const csn = data.companyShortName || "";
    companyShortNames.add(csn || data.companyName || "");

    // branchName の先頭部分と companyShortName が一致しないケースを抽出
    if (branch && csn && !branch.startsWith(csn) && !csn.startsWith(branch)) {
      mismatched.push({
        name: data.name,
        branchName: branch,
        companyShortName: csn,
        companyName: data.companyName || "",
      });
    }
  });

  // 「パーソナル札幌」「福座」「心療内科」に関連するレコード
  const targets = ["パーソナル札幌", "福座", "心療内科"];
  const targetRecords = payrollSnapshot.docs
    .filter((doc) => {
      const data = doc.data();
      const csn = data.companyShortName || data.companyName || "";
      return targets.some((t) => csn.includes(t));
    })
    .map((doc) => {
      const data = doc.data();
      return {
        name: data.name,
        branchName: data.branchName || "(空)",
        companyShortName: data.companyShortName || "(空)",
        companyName: data.companyName || "(空)",
        kintoneRecordId: data.kintoneRecordId,
      };
    });

  return NextResponse.json({
    totalRecords: payrollSnapshot.size,
    uniqueCompanyShortNames: companyShortNames.size,
    mismatchedCount: mismatched.length,
    mismatched: mismatched.slice(0, 20),
    targetRecords,
  });
}
