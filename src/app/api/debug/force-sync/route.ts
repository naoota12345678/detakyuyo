import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { fetchAllRecords } from "@/lib/kintone";
import { mapKintoneToEmployee, EmployeeData } from "@/lib/kintone-mapping";

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  try {
    const { kintoneRecordIds, targetCompanyShortName } = await request.json();
    const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
    const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;

    if (!appId || !token) {
      return NextResponse.json({ error: "Missing kintone env" }, { status: 500 });
    }

    if (!kintoneRecordIds || !Array.isArray(kintoneRecordIds) || kintoneRecordIds.length === 0) {
      return NextResponse.json({ error: "kintoneRecordIds required" }, { status: 400 });
    }

    const month = getCurrentMonth();

    // Fetch all kintone records (no filter - include retired)
    const allRecords = await fetchAllRecords(appId, token);

    // Find target records
    const targetEmps: EmployeeData[] = [];
    for (const rid of kintoneRecordIds) {
      const record = allRecords.find((r) => {
        const val = r["レコード番号"]?.value;
        return String(val) === String(rid);
      });
      if (record) {
        targetEmps.push(mapKintoneToEmployee(record));
      }
    }

    if (targetEmps.length === 0) {
      return NextResponse.json({ error: "No matching records found in kintone" }, { status: 404 });
    }

    // Get existing monthlyPayroll for this month
    const existingSnap = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", month)
      .get();

    const existingByRecordId = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    const existingByName = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    for (const doc of existingSnap.docs) {
      const data = doc.data();
      if (data.kintoneRecordId) existingByRecordId.set(data.kintoneRecordId, doc);
      if (data.name) existingByName.set(data.name, doc);
    }

    const results: { name: string; action: string; employeeNumber: string }[] = [];
    const batch = adminDb.batch();

    for (const emp of targetEmps) {
      const overrideCompany = targetCompanyShortName || emp.companyShortName;

      // Check if already exists by kintoneRecordId or name
      const existing = existingByRecordId.get(emp.kintoneRecordId) || existingByName.get(emp.name);

      if (existing) {
        // Update existing record with kintone data
        batch.update(existing.ref, {
          kintoneRecordId: emp.kintoneRecordId,
          employeeNumber: emp.employeeNumber,
          nameKana: emp.nameKana,
          companyShortName: overrideCompany,
          branchName: emp.branchName,
          employmentType: emp.employmentType,
          hireDate: emp.hireDate,
          leaveDate: emp.leaveDate,
          socialInsurance: emp.socialInsurance,
          employmentInsurance: emp.employmentInsurance,
          healthStandardMonthly: emp.healthStandardMonthly,
          pensionStandardMonthly: emp.pensionStandardMonthly,
          lastSyncedAt: new Date().toISOString(),
        });
        results.push({ name: emp.name, action: "updated", employeeNumber: emp.employeeNumber });
      } else {
        // Create new record
        const docRef = adminDb.collection("monthlyPayroll").doc();
        batch.set(docRef, {
          month,
          kintoneRecordId: emp.kintoneRecordId,
          employeeNumber: emp.employeeNumber,
          name: emp.name,
          nameKana: emp.nameKana,
          companyName: emp.companyName,
          companyShortName: overrideCompany,
          branchName: emp.branchName,
          employmentType: emp.employmentType,
          hireDate: emp.hireDate,
          leaveDate: emp.leaveDate,
          status: emp.leaveDate ? "退社予定" : "在籍",
          baseSalary: emp.baseSalary,
          commutingAllowance: emp.commutingAllowance,
          commutingType: "月額",
          socialInsurance: emp.socialInsurance,
          employmentInsurance: emp.employmentInsurance,
          healthStandardMonthly: emp.healthStandardMonthly,
          pensionStandardMonthly: emp.pensionStandardMonthly,
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
          deemedOvertimePay: 0,
          residentTax: 0,
          socialInsuranceGrade: "",
          unitPrice: 0,
          bonus: 0,
          memo: "",
          employeeMemo: "",
          confirmed: false,
          events: [`手動同期: ${new Date().toISOString().split("T")[0]}`],
          lastSyncedAt: new Date().toISOString(),
        });
        results.push({ name: emp.name, action: "created", employeeNumber: emp.employeeNumber });
      }
    }

    await batch.commit();

    return NextResponse.json({ success: true, month, results });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
