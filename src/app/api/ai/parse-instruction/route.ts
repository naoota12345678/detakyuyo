import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const FIELD_MAP: Record<string, string> = {
  baseSalary: "基本給",
  commutingAllowance: "通勤手当（月額）",
  commutingUnitPrice: "交通費単価（日額の単価）",
  allowance1: "手当1",
  allowance2: "手当2",
  allowance3: "手当3",
  allowance4: "手当4",
  allowance5: "手当5",
  allowance6: "手当6",
  extraAllowance1: "計算外手当1（単価計算に含めない手当）",
  extraAllowance2: "計算外手当2（単価計算に含めない手当）",
  extraAllowance3: "計算外手当3（単価計算に含めない手当）",
  extraDeduction1: "控除項目1（家賃等）",
  extraDeduction2: "控除項目2",
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
    const { instruction, employees, months, companyName, month } = await request.json();

    if (!instruction) {
      return NextResponse.json({ error: "指示を入力してください" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
    }

    const client = new Anthropic({ apiKey });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const employeeList = employees
      .map((e: Record<string, any>) => {
        const parts = [`${e.name}（社員番号: ${e.employeeNumber}）`];
        if (e.baseSalary) parts.push(`基本給${e.baseSalary}`);
        if (e.commutingAllowance) parts.push(`通勤手当${e.commutingAllowance}`);
        if (e.commutingUnitPrice) parts.push(`交通費単価${e.commutingUnitPrice}`);
        if (e.deemedOvertimePay) parts.push(`みなし残業${e.deemedOvertimePay}`);
        if (e.residentTax) parts.push(`住民税${e.residentTax}`);
        if (e.unitPrice) parts.push(`単価${e.unitPrice}`);
        if (e.bonus) parts.push(`賞与${e.bonus}`);
        if (e.socialInsuranceGrade) parts.push(`社保等級${e.socialInsuranceGrade}`);
        if (e.deductions) parts.push(`控除${e.deductions}`);
        if (e.overtimeHours) parts.push(`残業${e.overtimeHours}h`);
        if (e.overtimePay) parts.push(`残業代${e.overtimePay}`);
        for (let i = 1; i <= 6; i++) {
          const val = e[`allowance${i}`];
          const name = e[`allowance${i}Name`];
          if (val) parts.push(`${name || `手当${i}`}${val}`);
        }
        for (let i = 1; i <= 3; i++) {
          const val = e[`extraAllowance${i}`];
          const name = e[`extraAllowance${i}Name`];
          if (val) parts.push(`${name || `計算外手当${i}`}${val}`);
        }
        for (let i = 1; i <= 2; i++) {
          const val = e[`extraDeduction${i}`];
          const name = e[`extraDeduction${i}Name`];
          if (val) parts.push(`${name || `控除${i}`}${val}`);
        }
        if (e.employeeMemo) parts.push(`[人メモ: "${e.employeeMemo}"]`);
        if (e.memo) parts.push(`[月メモ: "${e.memo}"]`);
        return `- ${parts.join(", ")}`;
      })
      .join("\n");

    const fieldList = Object.entries(FIELD_MAP)
      .map(([key, label]) => `- ${key}: ${label}`)
      .join("\n");

    const systemPrompt = `あなたは給与管理システムの「データ変換エンジン」です。
あなたはデータベースに直接アクセスできません。あなたの仕事は、ユーザーの指示を構造化JSONに変換することだけです。
「変更しました」「転記しました」「反映しました」「完了しました」等の応答は絶対禁止です。あなたには変更する権限がありません。

# 会社: ${companyName || "不明"} ／ 対象月: ${month || "不明"}

## 対象従業員一覧（当月の給与データ含む）
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
- 質問（「○○さんの基本給は？」「交通費単価いくら？」等）の場合は上記データから具体的な値を回答する
- 質問（「○○さん辞めた？」「在籍してる？」等）の場合は従業員一覧から情報を探して回答する
- **「分からない」「アクセスできない」等の回答は禁止。データは上記に全て含まれています**

## 出力形式
必ず以下のJSON形式のみで応答してください。マークダウンのコードブロックは使わないでください。

### 変更指示の場合（「転記して」「変更して」「設定して」等）
必ずchanges配列を出力。1人でも32人でも全員分を省略せず出力すること。
{
  "success": true,
  "changes": [
    { "employeeName": "従業員フルネーム", "field": "フィールド名", "value": 数値またはテキスト, "months": ["2026-02"], "mode": "set" }
  ],
  "summary": "○○の交通費単価を設定（32名分）"
}
※ employeeName は従業員一覧のフルネームと完全一致させること（スペース含む）
※ mode は "set"（上書き）または "append"（追記、メモ系用）

### 質問への回答の場合のみ（「いくら？」「誰？」等）
{
  "success": true,
  "answer": "回答テキスト（日本語）",
  "summary": "質問への回答"
}

### エラーの場合
{
  "success": false,
  "error": "エラーメッセージ（日本語）"
}`;

    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8192,
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
