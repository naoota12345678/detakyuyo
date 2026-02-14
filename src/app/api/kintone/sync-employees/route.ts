import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { fetchAllRecords } from "@/lib/kintone";
import {
  mapKintoneToEmployee,
  EMPLOYEE_FIELD_CODES,
  EmployeeData,
} from "@/lib/kintone-mapping";

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function buildPayrollDoc(emp: EmployeeData, month: string) {
  return {
    month,
    kintoneRecordId: emp.kintoneRecordId,
    employeeNumber: emp.employeeNumber,
    name: emp.name,
    nameKana: emp.nameKana,
    companyName: emp.companyName,
    companyShortName: emp.companyShortName,
    branchName: emp.branchName,
    employmentType: emp.employmentType,
    hireDate: emp.hireDate,
    leaveDate: emp.leaveDate,
    status: emp.status,
    baseSalary: emp.baseSalary,
    commutingAllowance: emp.commutingAllowance,
    commutingType: "月額",
    socialInsurance: emp.socialInsurance,
    employmentInsurance: emp.employmentInsurance,
    healthStandardMonthly: emp.healthStandardMonthly,
    pensionStandardMonthly: emp.pensionStandardMonthly,
    // 給与計算関連（初期値）
    overtimeHours: 0,
    overtimePay: 0,
    otherAllowances: 0,
    deductions: 0,
    totalPayment: 0,
    allowance1: 0,
    allowance1Name: "",
    allowance2: 0,
    allowance2Name: "",
    allowance3: 0,
    allowance3Name: "",
    allowance4: 0,
    allowance4Name: "",
    allowance5: 0,
    allowance5Name: "",
    allowance6: 0,
    allowance6Name: "",
    deemedOvertimePay: 0,
    residentTax: 0,
    socialInsuranceGrade: "",
    unitPrice: 0,
    bonus: 0,
    memo: "",
    employeeMemo: "",
    confirmed: false,
    events: [] as string[],
    lastSyncedAt: new Date().toISOString(),
  };
}

export async function POST() {
  try {
    const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
    const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;

    if (!appId || !token) {
      return NextResponse.json(
        { error: "kintone 従業員設定が不足しています" },
        { status: 500 }
      );
    }

    const month = getCurrentMonth();

    // companySettings から給与受託先の shortName 一覧を取得（フィルタ用）
    const companySnapshot = await adminDb
      .collection("companySettings")
      .where("isPayrollClient", "==", true)
      .get();
    const validShortNames = new Set<string>();
    companySnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.shortName) {
        validShortNames.add(data.shortName);
      }
    });

    // kintone から在籍者 + 退社日が今日以降の退社予定者を取得
    const today = new Date().toISOString().split("T")[0];
    const records = await fetchAllRecords(
      appId,
      token,
      EMPLOYEE_FIELD_CODES,
      `在籍状況 in ("在籍") or 退社日 >= "${today}"`
    );

    // 既存の当月レコードを取得
    const existingSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", month)
      .get();

    const existingByRecordId = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    existingSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.kintoneRecordId) {
        existingByRecordId.set(data.kintoneRecordId, doc);
      }
    });

    let created = 0;
    let updated = 0;
    let retired = 0;
    let skipped = 0;
    const events: string[] = [];
    const errors: string[] = [];

    // バッチ書き込み（500件制限があるため分割）
    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;

    const syncedRecordIds = new Set<string>();

    for (const record of records) {
      try {
        const emp = mapKintoneToEmployee(record);

        // 受託先フィルタ: branchName が companySettings に存在しない従業員はスキップ
        if (!validShortNames.has(emp.branchName)) {
          skipped++;
          continue;
        }

        syncedRecordIds.add(emp.kintoneRecordId);

        const existing = existingByRecordId.get(emp.kintoneRecordId);

        if (!existing) {
          // 新規レコード作成
          const docRef = adminDb.collection("monthlyPayroll").doc();
          const newDoc = buildPayrollDoc(emp, month);

          // 入社日が当月ならイベント追加
          if (emp.hireDate && emp.hireDate.startsWith(month)) {
            newDoc.events.push(`入社: ${emp.hireDate}`);
          }

          batch.set(docRef, newDoc);
          created++;
          batchCount++;
        } else {
          // 既存レコードの変更検知
          const existingData = existing.data()!;
          const changeEvents: string[] = [];

          if (existingData.baseSalary !== emp.baseSalary) {
            changeEvents.push(
              `基本給変更: ${existingData.baseSalary} → ${emp.baseSalary}`
            );
          }
          if (existingData.companyName !== emp.companyName) {
            changeEvents.push(
              `所属変更: ${existingData.companyName} → ${emp.companyName}`
            );
          }
          if (existingData.employmentType !== emp.employmentType) {
            changeEvents.push(
              `雇用形態変更: ${existingData.employmentType} → ${emp.employmentType}`
            );
          }
          if (existingData.commutingAllowance !== emp.commutingAllowance) {
            changeEvents.push(
              `通勤手当変更: ${existingData.commutingAllowance} → ${emp.commutingAllowance}`
            );
          }

          // companyShortName が未設定なら常に更新対象にする
          const needsShortName = !existingData.companyShortName && emp.companyShortName;

          if (changeEvents.length > 0 || needsShortName) {
            const updateData: Record<string, unknown> = {
              name: emp.name,
              companyName: emp.companyName,
              companyShortName: emp.companyShortName,
              branchName: emp.branchName,
              employmentType: emp.employmentType,
              baseSalary: emp.baseSalary,
              commutingAllowance: emp.commutingAllowance,
              socialInsurance: emp.socialInsurance,
              employmentInsurance: emp.employmentInsurance,
              healthStandardMonthly: emp.healthStandardMonthly,
              pensionStandardMonthly: emp.pensionStandardMonthly,
              lastSyncedAt: new Date().toISOString(),
            };

            if (changeEvents.length > 0) {
              const existingEvents: string[] = existingData.events || [];
              updateData.events = [...existingEvents, ...changeEvents];
              events.push(`${emp.name}: ${changeEvents.join(", ")}`);
            }

            batch.update(existing.ref, updateData);
            updated++;
            batchCount++;
          }
        }

        if (batchCount >= BATCH_LIMIT) {
          await batch.commit();
          batch = adminDb.batch();
          batchCount = 0;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
      }
    }

    // 退職検知: 既存レコードにあるが kintone 在籍者にいない人
    // 受託先の従業員だけが対象（branchName が validShortNames に含まれる）
    const retiredRecordIds = new Set<string>();
    for (const [recordId, doc] of existingByRecordId) {
      if (!syncedRecordIds.has(recordId)) {
        const data = doc.data()!;
        // 受託先の従業員かチェック
        const empBranch = data.branchName || data.companyShortName || "";
        if (!validShortNames.has(empBranch)) continue; // 非受託先はスキップ

        retiredRecordIds.add(recordId);
        const existingEvents: string[] = data.events || [];

        if (data.status !== "退社") {
          batch.update(doc.ref, {
            status: "退社",
            events: [...existingEvents, `退社検知: ${new Date().toISOString().split("T")[0]}`],
            lastSyncedAt: new Date().toISOString(),
          });
          retired++;
          batchCount++;
          events.push(`${data.name}: 退社検知`);
        }
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    // 非受託先の monthlyPayroll レコードを削除（退社者は残す）
    let cleaned = 0;
    let cleanBatch = adminDb.batch();
    let cleanCount = 0;
    for (const doc of existingSnapshot.docs) {
      const data = doc.data();
      const rid = data.kintoneRecordId;
      if (!syncedRecordIds.has(rid) && !retiredRecordIds.has(rid)) {
        cleanBatch.delete(doc.ref);
        cleaned++;
        cleanCount++;
        if (cleanCount >= BATCH_LIMIT) {
          await cleanBatch.commit();
          cleanBatch = adminDb.batch();
          cleanCount = 0;
        }
      }
    }
    if (cleanCount > 0) {
      await cleanBatch.commit();
    }

    return NextResponse.json({
      success: true,
      month,
      totalKintoneRecords: records.length,
      skipped,
      created,
      updated,
      retired,
      cleaned,
      events,
      errors,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "従業員同期に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
