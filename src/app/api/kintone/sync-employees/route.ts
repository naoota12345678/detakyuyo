import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { fetchAllRecords } from "@/lib/kintone";
import {
  mapKintoneToEmployee,
  EMPLOYEE_FIELD_CODES,
  EmployeeData,
  stripEntityType,
} from "@/lib/kintone-mapping";
import { isRetired } from "@/lib/employee-utils";

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
    extraAllowance1: 0,
    extraAllowance1Name: "",
    extraAllowance2: 0,
    extraAllowance2Name: "",
    extraAllowance3: 0,
    extraAllowance3Name: "",
    extraDeduction1: 0,
    extraDeduction1Name: "",
    extraDeduction2: 0,
    extraDeduction2Name: "",
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

export async function POST(request: NextRequest) {
  try {
    const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
    const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;

    if (!appId || !token) {
      return NextResponse.json(
        { error: "kintone 従業員設定が不足しています" },
        { status: 500 }
      );
    }

    // オプション: 会社単位同期のパラメータ
    let targetCompany: string | null = null;
    try {
      const body = await request.json();
      if (body.companyShortName) {
        targetCompany = body.companyShortName;
      }
    } catch {
      // bodyなし（全体同期）の場合は無視
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

    // 会社単位同期の場合、対象会社が受託先に存在するか確認
    if (targetCompany && !validShortNames.has(targetCompany)) {
      return NextResponse.json(
        { error: `受託先に存在しない会社です: ${targetCompany}` },
        { status: 400 }
      );
    }

    // 会社単位同期の場合、validShortNames を対象会社のみに絞る
    const syncTargetNames = targetCompany
      ? new Set<string>([targetCompany])
      : validShortNames;

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

        // 受託先フィルタ: branchName が同期対象に含まれない従業員はスキップ
        // 法人格付き（"株式会社 ムロランミート"）も法人格除去して再比較
        if (!syncTargetNames.has(emp.branchName) && !syncTargetNames.has(stripEntityType(emp.branchName))) {
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
          const manuallyEdited: Record<string, string> = existingData.manuallyEditedFields || {};
          const changeEvents: string[] = [];
          const skippedFields: string[] = [];

          // baseSalary: 手動編集済みならスキップ
          if (existingData.baseSalary !== emp.baseSalary) {
            if (manuallyEdited.baseSalary) {
              skippedFields.push("baseSalary");
            } else {
              changeEvents.push(
                `基本給変更: ${existingData.baseSalary} → ${emp.baseSalary}`
              );
            }
          }
          // companyName: UIで編集不可なので常に検知
          if (existingData.companyName !== emp.companyName) {
            changeEvents.push(
              `所属変更: ${existingData.companyName} → ${emp.companyName}`
            );
          }
          // employmentType: 手動編集済みならスキップ
          if (existingData.employmentType !== emp.employmentType) {
            if (manuallyEdited.employmentType) {
              skippedFields.push("employmentType");
            } else {
              changeEvents.push(
                `雇用形態変更: ${existingData.employmentType} → ${emp.employmentType}`
              );
            }
          }
          // commutingAllowance: 手動編集済みならスキップ
          if (existingData.commutingAllowance !== emp.commutingAllowance) {
            if (manuallyEdited.commutingAllowance) {
              skippedFields.push("commutingAllowance");
            } else {
              changeEvents.push(
                `通勤手当変更: ${existingData.commutingAllowance} → ${emp.commutingAllowance}`
              );
            }
          }

          // companyShortName が未設定なら常に更新対象にする
          const needsShortName = !existingData.companyShortName && emp.companyShortName;

          if (changeEvents.length > 0 || needsShortName) {
            const updateData: Record<string, unknown> = {
              name: emp.name,
              companyName: emp.companyName,
              companyShortName: emp.companyShortName,
              // 手動編集済みフィールドはアプリの値を保持
              branchName: manuallyEdited.branchName ? existingData.branchName : emp.branchName,
              employmentType: manuallyEdited.employmentType ? existingData.employmentType : emp.employmentType,
              baseSalary: manuallyEdited.baseSalary ? existingData.baseSalary : emp.baseSalary,
              commutingAllowance: manuallyEdited.commutingAllowance ? existingData.commutingAllowance : emp.commutingAllowance,
              socialInsurance: emp.socialInsurance,
              employmentInsurance: emp.employmentInsurance,
              healthStandardMonthly: emp.healthStandardMonthly,
              pensionStandardMonthly: emp.pensionStandardMonthly,
              lastSyncedAt: new Date().toISOString(),
            };

            const allNewEvents = [...changeEvents];
            if (skippedFields.length > 0) {
              allNewEvents.push(`手動編集保持: ${skippedFields.join(", ")}`);
            }

            if (allNewEvents.length > 0) {
              const existingEvents: string[] = existingData.events || [];
              updateData.events = [...existingEvents, ...allNewEvents];
              events.push(`${emp.name}: ${allNewEvents.join(", ")}`);
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
    // 同期対象の会社の従業員だけが対象（会社単位同期時は対象会社のみ）
    const retiredRecordIds = new Set<string>();
    for (const [recordId, doc] of existingByRecordId) {
      if (!syncedRecordIds.has(recordId)) {
        const data = doc.data()!;
        // 同期対象の会社の従業員かチェック
        const empBranch = data.branchName || data.companyShortName || "";
        if (!syncTargetNames.has(empBranch) && !syncTargetNames.has(stripEntityType(empBranch))) continue; // 対象外はスキップ

        retiredRecordIds.add(recordId);
        const existingEvents: string[] = data.events || [];

        if (!isRetired(data.status)) {
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
    // 会社単位同期時は他社レコード誤削除防止のためスキップ
    let cleaned = 0;
    if (!targetCompany) {
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
    }

    return NextResponse.json({
      success: true,
      month,
      targetCompany,
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
