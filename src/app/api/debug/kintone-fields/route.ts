import { NextResponse } from "next/server";

export async function GET() {
  const subdomain = process.env.KINTONE_SUBDOMAIN;
  const appId = process.env.KINTONE_EMPLOYEE_APP_ID;
  const token = process.env.KINTONE_EMPLOYEE_API_TOKEN;

  // ノースワンの従業員を1件取得して全フィールドを確認
  const res = await fetch(
    `https://${subdomain}.cybozu.com/k/v1/records.json?app=${appId}&query=${encodeURIComponent('文字列__1行_ like "ノースワン"')}&totalCount=true`,
    { headers: { "X-Cybozu-API-Token": token! } }
  );
  const data = await res.json();

  if (!data.records || data.records.length === 0) {
    return NextResponse.json({ error: "レコードなし", raw: data });
  }

  // 企業関連フィールドだけ抽出
  const record = data.records[0];
  const relevant: Record<string, unknown> = {};
  for (const [code, field] of Object.entries(record)) {
    const f = field as { type: string; value: unknown };
    if (
      code.includes("文字列__1行_") ||
      code === "ルックアップ" ||
      code === "氏名"
    ) {
      relevant[code] = { value: f.value, type: f.type };
    }
  }

  return NextResponse.json({
    totalCount: data.totalCount,
    relevantFields: relevant,
    recordCount: data.records.length,
  });
}
