import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const FIELD_MAP: Record<string, string> = {
  baseSalary: "基本給",
  commutingAllowance: "通勤手当",
  allowance1: "手当1",
  allowance2: "手当2",
  allowance3: "手当3",
  allowance4: "手当4",
  allowance5: "手当5",
  allowance6: "手当6",
  deemedOvertimePay: "みなし残業手当",
  deductions: "控除",
  residentTax: "住民税",
  unitPrice: "単価",
  socialInsuranceGrade: "社保等級",
  overtimeHours: "残業時間",
  overtimePay: "残業代",
  bonus: "賞与（ボーナス）",
  employeeMemo: "人メモ（従業員メモ、名前の下に表示される個人メモ）",
  memo: "月メモ（月ごとのメモ）",
};

export async function POST(request: NextRequest) {
  try {
    const { instruction, employees, months, employeeMemos } = await request.json();

    if (!instruction) {
      return NextResponse.json({ error: "指示を入力してください" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    const employeeList = employees
      .map((e: { name: string; employeeNumber: string }) => {
        const memo = employeeMemos?.[e.name] || "";
        const memoStr = memo ? ` [現在の人メモ: "${memo}"]` : "";
        return `- ${e.name}（社員番号: ${e.employeeNumber}）${memoStr}`;
      })
      .join("\n");

    const fieldList = Object.entries(FIELD_MAP)
      .map(([key, label]) => `- ${key}: ${label}`)
      .join("\n");

    const systemPrompt = `あなたは給与管理システムのアシスタントです。
ユーザーの自然言語による給与変更指示を解析し、構造化データとして返してください。

## 対象従業員一覧
${employeeList}

## 利用可能月
${months.join(", ")}

## 変更可能フィールド
${fieldList}

## ルール
- 従業員名は部分一致で特定してOK（例: 「山田」→「山田太郎」）
- ただし複数候補がある場合はすべて候補として返す
- 「○月から」と指定された場合、その月以降の利用可能月すべてを対象にする
- 「○月」とだけ指定された場合、その月のみ対象
- 月の指定がない場合、employeeMemoは月に関係なく適用（monthsは空配列[]にする）
- 金額は数値に変換（「25万」→250000、「3万5千」→35000）
- socialInsuranceGrade はテキスト値
- employeeMemo（人メモ）: 「追加」「追記」「書いて」等の場合は mode を "append" にする。既存メモがある場合、改行して追記するテキストだけを value に入れる
- employeeMemo の mode が "set" の場合は既存メモを完全に置き換える
- memo（月メモ）も同様に "append" / "set" を使い分ける

## 出力形式
必ず以下のJSON形式のみで応答してください。マークダウンのコードブロックは使わないでください。
{
  "success": true,
  "employeeName": "特定した従業員のフルネーム",
  "changes": [
    { "field": "フィールド名", "value": 数値またはテキスト, "months": ["2026-01", ...], "mode": "set" }
  ],
  "summary": "変更内容の要約（日本語）"
}
※ mode は "set"（上書き、デフォルト）または "append"（追記、メモ系フィールド用）

従業員が特定できない場合やフィールドが不明な場合:
{
  "success": false,
  "error": "エラーメッセージ（日本語）"
}`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: instruction }],
      system: systemPrompt,
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    // JSONをパース
    let parsed;
    try {
      // コードブロックで囲まれている場合も対応
      const jsonStr = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { error: "AIの応答を解析できませんでした", raw: text },
        { status: 500 }
      );
    }

    return NextResponse.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI処理に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
