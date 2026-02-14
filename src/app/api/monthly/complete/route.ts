import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

function getNextMonth(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m, 1); // m is already 1-based, so m = next month (0-based)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

    // 当月レコード（この会社のみ）を取得
    const currentSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", currentMonth)
      .get();

    const companyDocs = currentSnapshot.docs.filter((doc) => {
      const data = doc.data();
      const rawName = data.companyShortName || data.companyName || "";
      const displayName = aliasMappings[rawName] || rawName;
      return matchingNames.has(rawName) || displayName === companyName;
    });

    if (companyDocs.length === 0) {
      return NextResponse.json({
        success: false,
        message: `${currentMonth} の ${companyName} のレコードが見つかりません。`,
      });
    }

    // 翌月に既にレコードがあるか確認（この会社のみ）
    const nextSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", nextMonth)
      .get();

    const existingNextByRecordId = new Set<string>();
    nextSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const rawName = data.companyShortName || data.companyName || "";
      const displayName = aliasMappings[rawName] || rawName;
      if (matchingNames.has(rawName) || displayName === companyName) {
        if (data.kintoneRecordId) existingNextByRecordId.add(data.kintoneRecordId);
      }
    });

    let created = 0;
    let skipped = 0;
    const alerts: string[] = [];

    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;

    for (const doc of companyDocs) {
      const prev = doc.data();

      // 退社済みはスキップ
      if (prev.status === "退社") continue;

      // 既に翌月にレコードがある場合はスキップ
      if (prev.kintoneRecordId && existingNextByRecordId.has(prev.kintoneRecordId)) {
        skipped++;
        continue;
      }

      const events: string[] = [];

      // アラート: 前月の確認が未完了
      if (!prev.confirmed) {
        alerts.push(`${prev.name}: ${currentMonth}が未確認`);
        events.push(`注意: ${currentMonth}未確認`);
      }

      // アラート: 退社日が翌月
      if (prev.leaveDate && prev.leaveDate.startsWith(nextMonth)) {
        alerts.push(`${prev.name}: 退社予定(${prev.leaveDate})`);
        events.push(`退社予定: ${prev.leaveDate} - 日割り計算要確認`);
      }

      const docRef = adminDb.collection("monthlyPayroll").doc();
      batch.set(docRef, {
        month: nextMonth,
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
        deemedOvertimePay: prev.deemedOvertimePay || 0,
        residentTax: prev.residentTax || 0,
        socialInsuranceGrade: prev.socialInsuranceGrade || "",
        unitPrice: prev.unitPrice || 0,
        bonus: 0, // 賞与は翌月に引き継がない
        socialInsurance: prev.socialInsurance,
        employmentInsurance: prev.employmentInsurance,
        healthStandardMonthly: prev.healthStandardMonthly || "",
        pensionStandardMonthly: prev.pensionStandardMonthly || "",
        // 月メモは引き継がない、人メモは引き継ぐ
        memo: "",
        employeeMemo: prev.employeeMemo || "",
        confirmed: false,
        events,
        lastSyncedAt: new Date().toISOString(),
      });

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
      created,
      skipped,
      alerts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "翌月レコード生成に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
