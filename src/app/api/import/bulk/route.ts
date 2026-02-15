import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

type EmployeeImport = {
  name: string;
  matchName?: string; // Firestore上の名前が異なる場合
  baseSalary?: number;
  commutingAllowance?: number;
  allowance1?: number;
  allowance1Name?: string;
  allowance2?: number;
  allowance2Name?: string;
  allowance3?: number;
  allowance3Name?: string;
  allowance4?: number;
  allowance4Name?: string;
  allowance5?: number;
  allowance5Name?: string;
  allowance6?: number;
  allowance6Name?: string;
  extraAllowance1?: number;
  extraAllowance1Name?: string;
  extraAllowance2?: number;
  extraAllowance2Name?: string;
  extraAllowance3?: number;
  extraAllowance3Name?: string;
  extraDeduction1?: number;
  extraDeduction1Name?: string;
  extraDeduction2?: number;
  extraDeduction2Name?: string;
  deemedOvertimePay?: number;
  residentTax?: number;
  unitPrice?: number;
  bonus?: number;
  memo?: string;
};

const IMPORT_FIELDS = [
  "baseSalary", "commutingAllowance",
  "allowance1", "allowance1Name", "allowance2", "allowance2Name",
  "allowance3", "allowance3Name", "allowance4", "allowance4Name",
  "allowance5", "allowance5Name", "allowance6", "allowance6Name",
  "extraAllowance1", "extraAllowance1Name",
  "extraAllowance2", "extraAllowance2Name",
  "extraAllowance3", "extraAllowance3Name",
  "extraDeduction1", "extraDeduction1Name",
  "extraDeduction2", "extraDeduction2Name",
  "deemedOvertimePay", "residentTax", "unitPrice", "bonus", "memo",
] as const;

export async function POST(request: NextRequest) {
  try {
    const { month, employees } = (await request.json()) as {
      month: string;
      employees: EmployeeImport[];
    };

    if (!month || !employees?.length) {
      return NextResponse.json({ error: "month and employees required" }, { status: 400 });
    }

    // 対象月のレコードを取得
    const targetSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", month)
      .get();

    const targetByName = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    targetSnapshot.docs.forEach((doc) => {
      const d = doc.data();
      if (d.name) targetByName.set(d.name, doc);
    });

    // 対象月にレコードがない場合、他の月から従業員情報を取得
    let refByName = new Map<string, FirebaseFirestore.DocumentData>();
    if (targetByName.size === 0) {
      const allSnapshot = await adminDb.collection("monthlyPayroll").get();
      // 最新月のデータを優先
      const latestByName = new Map<string, { month: string; data: FirebaseFirestore.DocumentData }>();
      allSnapshot.docs.forEach((doc) => {
        const d = doc.data();
        if (!d.name) return;
        const existing = latestByName.get(d.name);
        if (!existing || d.month > existing.month) {
          latestByName.set(d.name, { month: d.month, data: d });
        }
      });
      latestByName.forEach((v, k) => refByName.set(k, v.data));
    }

    let updated = 0;
    let created = 0;
    const notFound: string[] = [];
    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;

    for (const emp of employees) {
      const lookupName = emp.matchName || emp.name;

      // 1. 対象月に既存レコードがあればupdate
      const existingDoc = targetByName.get(lookupName);
      if (existingDoc) {
        const updateData: Record<string, unknown> = {};
        for (const f of IMPORT_FIELDS) {
          if ((emp as Record<string, unknown>)[f] !== undefined) {
            updateData[f] = (emp as Record<string, unknown>)[f];
          }
        }
        if (Object.keys(updateData).length > 0) {
          batch.update(existingDoc.ref, updateData);
          updated++;
          batchCount++;
        }
        continue;
      }

      // 2. 他の月のデータを参照して新規作成（なければ空で作成）
      const refData = refByName.get(lookupName) || {};

      const docRef = adminDb.collection("monthlyPayroll").doc();
      const newDoc: Record<string, unknown> = {
        month,
        kintoneRecordId: refData.kintoneRecordId || "",
        employeeNumber: refData.employeeNumber || "",
        name: refData.name || emp.name,
        nameKana: refData.nameKana || "",
        companyName: refData.companyName || "",
        companyShortName: refData.companyShortName || "",
        branchName: refData.branchName || "",
        employmentType: refData.employmentType || "",
        hireDate: refData.hireDate || "",
        leaveDate: refData.leaveDate || "",
        status: refData.status || "",
        baseSalary: refData.baseSalary || 0,
        commutingAllowance: refData.commutingAllowance || 0,
        socialInsurance: refData.socialInsurance || "",
        employmentInsurance: refData.employmentInsurance || "",
        healthStandardMonthly: refData.healthStandardMonthly || "",
        pensionStandardMonthly: refData.pensionStandardMonthly || "",
        overtimeHours: 0,
        overtimePay: 0,
        otherAllowances: 0,
        deductions: 0,
        totalPayment: 0,
        allowance1: 0, allowance1Name: "",
        allowance2: 0, allowance2Name: "",
        allowance3: 0, allowance3Name: "",
        allowance4: 0, allowance4Name: "",
        allowance5: 0, allowance5Name: "",
        allowance6: 0, allowance6Name: "",
        extraAllowance1: 0, extraAllowance1Name: "",
        extraAllowance2: 0, extraAllowance2Name: "",
        extraAllowance3: 0, extraAllowance3Name: "",
        extraDeduction1: 0, extraDeduction1Name: "",
        extraDeduction2: 0, extraDeduction2Name: "",
        deemedOvertimePay: 0,
        residentTax: 0,
        unitPrice: 0,
        bonus: 0,
        memo: "",
        confirmed: false,
        events: [],
        lastSyncedAt: new Date().toISOString(),
      };

      // インポートデータで上書き
      for (const f of IMPORT_FIELDS) {
        if ((emp as Record<string, unknown>)[f] !== undefined) {
          newDoc[f] = (emp as Record<string, unknown>)[f];
        }
      }

      batch.set(docRef, newDoc);
      created++;
      batchCount++;

      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        batch = adminDb.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      month,
      totalInput: employees.length,
      updated,
      created,
      notFound,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
