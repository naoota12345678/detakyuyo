import { NextRequest, NextResponse } from "next/server";
import { fetchAllRecords, getFieldValue } from "@/lib/kintone";
import { mapKintoneToEmployee } from "@/lib/kintone-mapping";

function normalize(s: string): string {
  return s.replace(/[\s　\u3000]+/g, "");
}

export async function POST(request: NextRequest) {
  try {
    const { names, searchKana } = await request.json();
    const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
    const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;

    if (!appId || !token) {
      return NextResponse.json({ error: "Missing kintone env" }, { status: 500 });
    }

    const allRecords = await fetchAllRecords(appId, token);

    // If searchKana is provided, search by kana reading (partial match)
    if (searchKana) {
      const kanaMatches = allRecords
        .filter((r) => {
          const kana = getFieldValue(r, "氏名よみがな") || "";
          return kana.includes(searchKana);
        })
        .map((r) => {
          const emp = mapKintoneToEmployee(r);
          return {
            name: emp.name,
            nameKana: emp.nameKana,
            employeeNumber: emp.employeeNumber,
            company: emp.companyShortName || emp.companyName,
            status: emp.leaveDate ? `退社(${emp.leaveDate})` : "在籍",
            kintoneRecordId: emp.kintoneRecordId,
          };
        });
      return NextResponse.json({ kanaMatches });
    }

    // Search by name
    const results = [];
    for (const name of names as string[]) {
      const norm = normalize(name);
      const match = allRecords.find((r) => normalize(getFieldValue(r, "氏名") || "") === norm);
      if (!match) {
        results.push({ name, found: false });
      } else {
        const emp = mapKintoneToEmployee(match);
        results.push({
          name,
          found: true,
          employeeNumber: emp.employeeNumber,
          kintoneRecordId: emp.kintoneRecordId,
          company: emp.companyShortName || emp.companyName,
          status: emp.leaveDate ? `退社(${emp.leaveDate})` : "在籍",
          branchName: emp.branchName,
          baseSalary: emp.baseSalary,
          commutingAllowance: emp.commutingAllowance,
        });
      }
    }

    return NextResponse.json({ results, totalKintoneRecords: allRecords.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
