import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month") || "2026-01";
  const company = request.nextUrl.searchParams.get("company") || "";

  const snapshot = await adminDb
    .collection("monthlyPayroll")
    .where("month", "==", month)
    .get();

  const names = snapshot.docs
    .map((doc) => {
      const d = doc.data();
      return {
        name: d.name,
        companyShortName: d.companyShortName || "",
        branchName: d.branchName || "",
      };
    })
    .filter((r) => !company || r.companyShortName.includes(company) || r.branchName.includes(company));

  return NextResponse.json({
    month,
    total: snapshot.size,
    filtered: names.length,
    names: names.map((n) => n.name).sort(),
  });
}
