import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

function getMonthStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getPreviousMonth(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return getMonthStr(prev);
}

function getMonthBefore(monthStr: string): string {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return getMonthStr(d);
}

function getCurrentMonth(): string {
  return getMonthStr(new Date());
}

export async function POST() {
  try {
    const prevMonth = getPreviousMonth();
    const currentMonth = getCurrentMonth();

    // 当月レコードが既に存在するか確認
    const existingSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", currentMonth)
      .limit(1)
      .get();

    if (!existingSnapshot.empty) {
      return NextResponse.json({
        success: false,
        message: `${currentMonth} のレコードは既に存在します。従業員同期で更新してください。`,
        existingCount: existingSnapshot.size,
      });
    }

    // 前月レコードを取得
    const prevSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", prevMonth)
      .get();

    if (prevSnapshot.empty) {
      return NextResponse.json({
        success: false,
        message: `${prevMonth} のレコードが見つかりません。先に従業員同期を実行してください。`,
      });
    }

    // 前々月のデータを取得（月額変更検知用）
    const twoMonthsAgo = getMonthBefore(prevMonth);
    const twoMonthsAgoSnapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", twoMonthsAgo)
      .get();

    const twoMonthsAgoByRecordId = new Map<string, FirebaseFirestore.DocumentData>();
    twoMonthsAgoSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data.kintoneRecordId) {
        twoMonthsAgoByRecordId.set(data.kintoneRecordId, data);
      }
    });

    let created = 0;
    const alerts: string[] = [];
    const errors: string[] = [];

    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;

    for (const doc of prevSnapshot.docs) {
      try {
        const prev = doc.data();

        // 退社済みはスキップ
        if (prev.status === "退社") continue;

        const events: string[] = [];

        // アラート: 前月の確認が未完了
        if (!prev.confirmed) {
          alerts.push(`${prev.name}: 前月(${prevMonth})が未確認`);
          events.push(`注意: 前月(${prevMonth})未確認`);
        }

        // アラート: 退社日が当月
        if (prev.leaveDate && prev.leaveDate.startsWith(currentMonth)) {
          alerts.push(`${prev.name}: 退社予定(${prev.leaveDate})`);
          events.push(`退社予定: ${prev.leaveDate} - 日割り計算要確認`);
        }

        // アラート: 入社日が前月（日割り戻し忘れ防止）
        if (prev.hireDate && prev.hireDate.startsWith(prevMonth)) {
          const hireDay = parseInt(prev.hireDate.split("-")[2], 10);
          if (hireDay > 1) {
            alerts.push(`${prev.name}: 前月入社(${prev.hireDate}) - 日割り調整確認`);
            events.push(`確認: 前月入社日割り調整済みか要確認`);
          }
        }

        // 月額変更アラート: 前々月→前月で基本給や単価が上がった場合
        const oldData = twoMonthsAgoByRecordId.get(prev.kintoneRecordId);
        if (oldData) {
          // 基本給の増額チェック
          if (prev.baseSalary > oldData.baseSalary && oldData.baseSalary > 0) {
            const diff = prev.baseSalary - oldData.baseSalary;
            alerts.push(`${prev.name}: 月額変更対象 - 基本給 ${oldData.baseSalary.toLocaleString()} → ${prev.baseSalary.toLocaleString()}（+${diff.toLocaleString()}）`);
            events.push(`⚠ 月額変更対象: 基本給 ${oldData.baseSalary.toLocaleString()} → ${prev.baseSalary.toLocaleString()}`);
          }
          // パート・アルバイトの単価増額チェック
          const isPartTime = prev.employmentType === "パート" || prev.employmentType === "アルバイト";
          const prevUnitPrice = prev.unitPrice || 0;
          const oldUnitPrice = oldData.unitPrice || 0;
          if (isPartTime && prevUnitPrice > oldUnitPrice && oldUnitPrice > 0) {
            alerts.push(`${prev.name}: 月額変更対象 - 単価 ${oldUnitPrice.toLocaleString()} → ${prevUnitPrice.toLocaleString()}`);
            events.push(`⚠ 月額変更対象: 単価 ${oldUnitPrice.toLocaleString()} → ${prevUnitPrice.toLocaleString()}`);
          }
        }

        const docRef = adminDb.collection("monthlyPayroll").doc();
        batch.set(docRef, {
          month: currentMonth,
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
          // 全ての数字を引き継ぎ
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      currentMonth,
      previousMonth: prevMonth,
      previousRecords: prevSnapshot.size,
      created,
      alerts,
      errors,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "月次レコード生成に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
