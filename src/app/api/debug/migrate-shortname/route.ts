import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { fetchAllRecords, getFieldValue } from "@/lib/kintone";

// kintone-mapping.ts と同じロジック
const ENTITY_TYPES = [
  "特定非営利活動法人",
  "医療法人社団",
  "医療法人",
  "社会福祉法人",
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
];

function stripEntityType(name: string): string {
  if (!name) return "";
  const trimmed = name.trim();
  for (const entity of ENTITY_TYPES) {
    const idx = trimmed.indexOf(entity);
    if (idx === -1) continue;
    if (idx === 0) {
      return trimmed.slice(entity.length).replace(/^[\s　]+/, "").trim();
    } else {
      return trimmed.slice(0, idx).replace(/[\s　]+$/, "").trim();
    }
  }
  return trimmed;
}

export async function POST() {
  try {
    const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
    const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;
    if (!appId || !token) {
      return NextResponse.json({ error: "kintone設定なし" }, { status: 500 });
    }

    // kintone から在籍者を取得
    const records = await fetchAllRecords(
      appId,
      token,
      undefined,
      '在籍状況 in ("在籍")'
    );

    // kintoneRecordId → companyShortName のマップ
    const shortNameMap = new Map<string, string>();
    for (const record of records) {
      const recordId = getFieldValue(record, "レコード番号");
      const rawShortName = getFieldValue(record, "文字列__1行__77");
      const companyName = getFieldValue(record, "文字列__1行_");
      const shortName = stripEntityType(rawShortName || companyName);
      if (recordId && shortName) {
        shortNameMap.set(recordId, shortName);
      }
    }

    // Firestore の monthlyPayroll を更新
    const snapshot = await adminDb
      .collection("monthlyPayroll")
      .where("month", "==", "2026-02")
      .get();

    const BATCH_LIMIT = 400;
    let batch = adminDb.batch();
    let batchCount = 0;
    let updatedCount = 0;
    let fallbackCount = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const kintoneId = data.kintoneRecordId;
      let shortName = shortNameMap.get(kintoneId);

      if (!shortName && data.companyName) {
        shortName = stripEntityType(data.companyName);
        fallbackCount++;
      }

      if (shortName) {
        batch.update(doc.ref, { companyShortName: shortName });
        updatedCount++;
        batchCount++;
      }

      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        batch = adminDb.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    // グルーピング結果を確認
    const groupResult = new Map<string, number>();
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const kintoneId = data.kintoneRecordId;
      const sn = shortNameMap.get(kintoneId) || stripEntityType(data.companyName || "");
      groupResult.set(sn, (groupResult.get(sn) || 0) + 1);
    }

    return NextResponse.json({
      success: true,
      updated: updatedCount,
      fallback: fallbackCount,
      groupedCompanies: Object.fromEntries(
        [...groupResult].sort((a, b) => a[0].localeCompare(b[0]))
      ),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
