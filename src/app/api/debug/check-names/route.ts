import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

function normalize(s: string): string {
  return s.replace(/[\s　\u3000]+/g, "");
}

export async function POST(request: NextRequest) {
  try {
    const { names, company } = await request.json();
    const snap = await adminDb.collection("monthlyPayroll").get();

    // Also get all names for this company for debugging
    const companyEmployees = new Map<string, { status: string; months: string[] }>();

    const results: { name: string; found: boolean; status?: string; company?: string; months?: string }[] = [];

    for (const doc of snap.docs) {
      const d = doc.data();
      const cn = d.companyShortName || d.companyName || "";
      if (company && !cn.includes(company)) continue;

      const empName = d.name || "";
      if (!companyEmployees.has(empName)) {
        companyEmployees.set(empName, { status: d.status || "", months: [] });
      }
      const entry = companyEmployees.get(empName)!;
      if (d.month) entry.months.push(d.month);
      if (d.status) entry.status = d.status;
    }

    for (const name of names as string[]) {
      const norm = normalize(name);
      let found = false;
      for (const [empName, data] of companyEmployees) {
        if (normalize(empName) === norm) {
          const sortedMonths = data.months.sort();
          results.push({
            name,
            found: true,
            status: data.status || "なし",
            months: `${sortedMonths[0]}~${sortedMonths[sortedMonths.length - 1]} (${sortedMonths.length}件)`,
          });
          found = true;
          break;
        }
      }
      if (!found) {
        results.push({ name, found: false });
      }
    }

    return NextResponse.json({ results, totalCompanyEmployees: companyEmployees.size });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
