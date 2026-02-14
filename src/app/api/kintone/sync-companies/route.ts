import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { fetchAllRecords } from "@/lib/kintone";
import {
  mapKintoneToCompany,
  CLIENT_FIELD_CODES,
  parseClosingDay,
  parsePayDay,
} from "@/lib/kintone-mapping";

export async function POST() {
  try {
    const appId = process.env.KINTONE_CLIENT_APP_ID;
    const token = process.env.KINTONE_CLIENT_API_TOKEN;

    if (!appId || !token) {
      return NextResponse.json(
        { error: "kintone クライアント設定が不足しています" },
        { status: 500 }
      );
    }

    // kintone からクライアント一覧を取得
    const records = await fetchAllRecords(appId, token, CLIENT_FIELD_CODES);

    let synced = 0;
    let skipped = 0;
    let deleted = 0;
    const errors: string[] = [];
    const syncedCompanies: string[] = [];
    const syncedDocIds = new Set<string>();

    const batch = adminDb.batch();

    for (const record of records) {
      try {
        const company = mapKintoneToCompany(record);

        // 給与業務受託が "〇" の企業のみ同期
        if (!company.isPayrollClient) {
          skipped++;
          continue;
        }

        // ドキュメントIDはクライアント番号、なければ企業省略名をスラッグ化
        const docId = company.clientNumber || company.shortName || company.officialName;
        if (!docId) {
          errors.push(`ドキュメントID生成不可: ${company.officialName}`);
          continue;
        }

        const docRef = adminDb.collection("companySettings").doc(docId);

        const closingDay = parseClosingDay(company.closingDay);
        const payDay = parsePayDay(company.payDay);

        batch.set(
          docRef,
          {
            officialName: company.officialName,
            shortName: company.shortName,
            nameKana: company.nameKana,
            closingDay: closingDay,
            closingDayRaw: company.closingDay,
            payDay: payDay,
            payDayRaw: company.payDay,
            standardWorkingHours: company.standardWorkingHours,
            clientNumber: company.clientNumber,
            isPayrollClient: true,
            lastSyncedAt: new Date().toISOString(),
          },
          { merge: true }
        );

        synced++;
        syncedDocIds.add(docId);
        syncedCompanies.push(company.shortName || company.officialName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
      }
    }

    await batch.commit();

    // 受託先でなくなった会社のドキュメントを削除
    const existingSnapshot = await adminDb.collection("companySettings").get();
    const deleteBatch = adminDb.batch();
    for (const doc of existingSnapshot.docs) {
      if (!syncedDocIds.has(doc.id)) {
        deleteBatch.delete(doc.ref);
        deleted++;
      }
    }
    if (deleted > 0) {
      await deleteBatch.commit();
    }

    return NextResponse.json({
      success: true,
      totalRecords: records.length,
      synced,
      skipped,
      deleted,
      errors,
      syncedCompanies,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "会社同期に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
