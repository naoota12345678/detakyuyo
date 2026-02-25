import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { isRetired } from "@/lib/employee-utils";

function getNextMonth(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getPrevMonth(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMonthRecord(prev: Record<string, any>, targetMonth: string, events: string[]) {
  return {
    month: targetMonth,
    kintoneRecordId: prev.kintoneRecordId,
    employeeNumber: prev.employeeNumber,
    name: prev.name,
    nameKana: prev.nameKana || "",
    companyName: prev.companyName,
    companyShortName: prev.companyShortName || "",
    branchName: prev.branchName || "",
    employmentType: prev.employmentType,
    hireDate: prev.hireDate,
    leaveDate: prev.leaveDate,
    status: prev.status,
    baseSalary: prev.baseSalary,
    commutingAllowance: prev.commutingAllowance,
    commutingType: prev.commutingType || "月額",
    commutingUnitPrice: prev.commutingUnitPrice || 0,
    overtimeHours: prev.overtimeHours || 0,
    overtimePay: prev.overtimePay || 0,
    otherAllowances: prev.otherAllowances || 0,
    deductions: prev.deductions || 0,
    totalPayment: prev.totalPayment || 0,
    allowance1: prev.allowance1 || 0,
    allowance1Name: prev.allowance1Name || "",
    allowance2: prev.allowance2 || 0,
    allowance2Name: prev.allowance2Name || "",
    allowance3: prev.allowance3 || 0,
    allowance3Name: prev.allowance3Name || "",
    allowance4: prev.allowance4 || 0,
    allowance4Name: prev.allowance4Name || "",
    allowance5: prev.allowance5 || 0,
    allowance5Name: prev.allowance5Name || "",
    allowance6: prev.allowance6 || 0,
    allowance6Name: prev.allowance6Name || "",
    extraAllowance1: prev.extraAllowance1 || 0,
    extraAllowance1Name: prev.extraAllowance1Name || "",
    extraAllowance2: prev.extraAllowance2 || 0,
    extraAllowance2Name: prev.extraAllowance2Name || "",
    extraAllowance3: prev.extraAllowance3 || 0,
    extraAllowance3Name: prev.extraAllowance3Name || "",
    extraDeduction1: prev.extraDeduction1 || 0,
    extraDeduction1Name: prev.extraDeduction1Name || "",
    extraDeduction2: prev.extraDeduction2 || 0,
    extraDeduction2Name: prev.extraDeduction2Name || "",
    deemedOvertimePay: prev.deemedOvertimePay || 0,
    residentTax: prev.residentTax || 0,
    socialInsuranceGrade: prev.socialInsuranceGrade || "",
    unitPrice: prev.unitPrice || 0,
    bonus: 0,
    socialInsurance: prev.socialInsurance,
    employmentInsurance: prev.employmentInsurance,
    healthStandardMonthly: prev.healthStandardMonthly || "",
    pensionStandardMonthly: prev.pensionStandardMonthly || "",
    memo: "",
    employeeMemo: prev.employeeMemo || "",
    confirmed: false,
    events,
    lastSyncedAt: new Date().toISOString(),
  };
}

export async function POST(request: NextRequest) {
  try {
    const { companyName, currentMonth } = await request.json();

    if (!companyName || !currentMonth) {
      return NextResponse.json(
        { error: "companyName と currentMonth は必須です" },
        { status: 400 }
      );
    }

    const prevMonth = getPrevMonth(currentMonth);
    const nextMonth = getNextMonth(currentMonth);

    // エイリアスを取得
    const aliasDoc = await adminDb.doc("appSettings/companyAliases").get();
    const aliasMappings: Record<string, string> = aliasDoc.exists
      ? aliasDoc.data()?.mappings || {}
      : {};

    // companyName にマッチする元の名前一覧
    const matchingNames = new Set<string>();
    matchingNames.add(companyName);
    for (const [orig, display] of Object.entries(aliasMappings)) {
      if (display === companyName) matchingNames.add(orig);
    }

    const isCompanyMatch = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const data = doc.data();
      const rawName = data.companyShortName || data.companyName || "";
      const displayName = aliasMappings[rawName] || rawName;
      return matchingNames.has(rawName) || displayName === companyName;
    };

    // 前月・当月・翌月レコードを取得
    const [prevSnapshot, currentSnapshot, nextSnapshot] = await Promise.all([
      adminDb.collection("monthlyPayroll").where("month", "==", prevMonth).get(),
      adminDb.collection("monthlyPayroll").where("month", "==", currentMonth).get(),
      adminDb.collection("monthlyPayroll").where("month", "==", nextMonth).get(),
    ]);

    const prevCompanyDocs = prevSnapshot.docs.filter(isCompanyMatch);
    const companyDocs = currentSnapshot.docs.filter(isCompanyMatch);

    // 当月に既にいる社員のkintoneRecordId
    const currentRecordIds = new Set<string>();
    companyDocs.forEach((doc) => {
      const rid = doc.data().kintoneRecordId;
      if (rid) currentRecordIds.add(rid);
    });

    // 翌月に既にいる社員のkintoneRecordId
    const existingNextByRecordId = new Set<string>();
    nextSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const rawName = data.companyShortName || data.companyName || "";
      const displayName = aliasMappings[rawName] || rawName;
      if (matchingNames.has(rawName) || displayName === companyName) {
        if (data.kintoneRecordId) existingNextByRecordId.add(data.kintoneRecordId);
      }
    });

    let backfilled = 0;
    let created = 0;
    let skipped = 0;
    const alerts: string[] = [];

    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;

    // === Phase 1: 前月→当月の欠落補完 ===
    for (const doc of prevCompanyDocs) {
      const prev = doc.data();
      if (isRetired(prev.status)) continue;
      if (prev.kintoneRecordId && currentRecordIds.has(prev.kintoneRecordId)) continue;

      // 当月レコードを補完
      const currentRef = adminDb.collection("monthlyPayroll").doc();
      batch.set(currentRef, buildMonthRecord(prev, currentMonth, [`${prevMonth}から補完`]));
      backfilled++;
      batchCount++;

      // 翌月レコードも同時に生成（なければ）
      if (!prev.kintoneRecordId || !existingNextByRecordId.has(prev.kintoneRecordId)) {
        const nextRef = adminDb.collection("monthlyPayroll").doc();
        batch.set(nextRef, buildMonthRecord(prev, nextMonth, [`${prevMonth}から補完`]));
        created++;
        batchCount++;
        if (prev.kintoneRecordId) existingNextByRecordId.add(prev.kintoneRecordId);
      }

      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        batch = adminDb.batch();
        batchCount = 0;
      }
    }

    // === Phase 2: 当月→翌月生成（通常処理） ===
    for (const doc of companyDocs) {
      const prev = doc.data();

      if (isRetired(prev.status)) continue;

      if (prev.kintoneRecordId && existingNextByRecordId.has(prev.kintoneRecordId)) {
        skipped++;
        continue;
      }

      const events: string[] = [];

      if (!prev.confirmed) {
        alerts.push(`${prev.name}: ${currentMonth}が未確認`);
        events.push(`注意: ${currentMonth}未確認`);
      }

      if (prev.leaveDate && prev.leaveDate.startsWith(nextMonth)) {
        alerts.push(`${prev.name}: 退社予定(${prev.leaveDate})`);
        events.push(`退社予定: ${prev.leaveDate} - 日割り計算要確認`);
      }

      const docRef = adminDb.collection("monthlyPayroll").doc();
      batch.set(docRef, buildMonthRecord(prev, nextMonth, events));

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
      companyName,
      currentMonth,
      nextMonth,
      sourceRecords: companyDocs.length,
      backfilled,
      created,
      skipped,
      alerts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "翌月レコード生成に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
