import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function buildEmployeeContext(docs: FirebaseFirestore.QueryDocumentSnapshot[], month: string): string {
  const byName = new Map<string, Record<string, unknown>>();
  for (const doc of docs) {
    const d = doc.data();
    if (d.month !== month) continue;
    byName.set(d.name, {
      employeeNumber: d.employeeNumber,
      baseSalary: d.baseSalary || 0,
      commutingAllowance: d.commutingAllowance || 0,
      allowance1: d.allowance1 || 0,
      allowance1Name: d.allowance1Name || "",
      allowance2: d.allowance2 || 0,
      allowance2Name: d.allowance2Name || "",
      allowance3: d.allowance3 || 0,
      allowance3Name: d.allowance3Name || "",
      deemedOvertimePay: d.deemedOvertimePay || 0,
      residentTax: d.residentTax || 0,
      bonus: d.bonus || 0,
      unitPrice: d.unitPrice || 0,
      socialInsuranceGrade: d.socialInsuranceGrade || "",
    });
  }
  if (byName.size === 0) return "（当月のアプリデータなし）";
  const lines = Array.from(byName.entries()).map(
    ([name, d]) => `${name}(${(d as Record<string, unknown>).employeeNumber}): 基本給${(d as Record<string, unknown>).baseSalary}, 通勤${(d as Record<string, unknown>).commutingAllowance}, みなし${(d as Record<string, unknown>).deemedOvertimePay}, 住民税${(d as Record<string, unknown>).residentTax}, 賞与${(d as Record<string, unknown>).bonus}, 単価${(d as Record<string, unknown>).unitPrice}`
  );
  return lines.join("\n");
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const instruction = formData.get("instruction") as string;
    const companyName = formData.get("companyName") as string;
    const month = formData.get("month") as string;
    const files = formData.getAll("files") as File[];
    const previousAnalysis = formData.get("previousAnalysis") as string | null;

    if (!instruction) {
      return NextResponse.json({ error: "指示を入力してください" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
    }

    // Fetch app data for context
    let employeeContext = "";
    if (companyName && month) {
      const aliasDoc = await adminDb.collection("appSettings").doc("companyAliases").get();
      const aliasMappings: Record<string, string> = aliasDoc.exists
        ? aliasDoc.data()?.mappings || {}
        : {};
      const matchingNames = new Set<string>();
      matchingNames.add(companyName);
      for (const [orig, display] of Object.entries(aliasMappings)) {
        if (display === companyName) matchingNames.add(orig);
      }

      const snapshot = await adminDb.collection("monthlyPayroll").get();
      const companyDocs = snapshot.docs.filter((doc) => {
        const d = doc.data();
        const rawName = d.companyShortName || d.companyName || "";
        const displayName = aliasMappings[rawName] || rawName;
        return matchingNames.has(rawName) || displayName === companyName;
      });
      employeeContext = buildEmployeeContext(companyDocs, month);
    }

    // Process files into Claude content blocks
    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (file.type === "application/pdf") {
        contentBlocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: buffer.toString("base64"),
          },
        });
      } else if (IMAGE_TYPES.has(file.type)) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: file.type as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: buffer.toString("base64"),
          },
        });
      } else if (
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls")
      ) {
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
        const texts: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");

          // Build structured output with cell references for better AI reading
          const rows: string[] = [];
          // Header: column letters
          const colLetters: string[] = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            colLetters.push(XLSX.utils.encode_col(c));
          }
          rows.push(`行\t${colLetters.join("\t")}`);

          for (let r = range.s.r; r <= range.e.r; r++) {
            const cells: string[] = [];
            let hasValue = false;
            for (let c = range.s.c; c <= range.e.c; c++) {
              const addr = XLSX.utils.encode_cell({ r, c });
              const cell = sheet[addr];
              if (cell) {
                // Use formatted value (w) if available, otherwise use value (v)
                const val = cell.w !== undefined ? cell.w : (cell.v !== undefined ? String(cell.v) : "");
                cells.push(val);
                if (val) hasValue = true;
              } else {
                cells.push("");
              }
            }
            // Skip completely empty rows
            if (hasValue) {
              rows.push(`${r + 1}\t${cells.join("\t")}`);
            }
          }

          // Include merge info for AI context
          const merges = sheet["!merges"] || [];
          let mergeInfo = "";
          if (merges.length > 0) {
            const mergeDescs = merges.slice(0, 50).map((m: XLSX.Range) => {
              const s = XLSX.utils.encode_cell(m.s);
              const e = XLSX.utils.encode_cell(m.e);
              return `${s}:${e}`;
            });
            mergeInfo = `\n結合セル: ${mergeDescs.join(", ")}`;
          }

          texts.push(`【シート: ${sheetName}】（${range.e.r + 1}行×${range.e.c + 1}列）${mergeInfo}\n${rows.join("\n")}`);
        }
        contentBlocks.push({
          type: "text",
          text: `【ファイル: ${file.name}】\n${texts.join("\n\n")}`,
        });
      } else if (file.name.endsWith(".csv") || file.type.startsWith("text/")) {
        const text = new TextDecoder("utf-8").decode(buffer);
        contentBlocks.push({
          type: "text",
          text: `【ファイル: ${file.name}】\n${text}`,
        });
      } else {
        // Try as text
        try {
          const text = new TextDecoder("utf-8").decode(buffer);
          contentBlocks.push({
            type: "text",
            text: `【ファイル: ${file.name}】\n${text}`,
          });
        } catch {
          contentBlocks.push({
            type: "text",
            text: `【ファイル: ${file.name}】（読み取り不可のファイル形式）`,
          });
        }
      }
    }

    // Add instruction (only for initial request, not follow-ups)
    if (!previousAnalysis) {
      contentBlocks.push({
        type: "text",
        text: instruction,
      });
    }

    const systemPrompt = `あなたは給与管理アプリに組み込まれたAIアシスタントです。
ユーザーがアップロードした資料を分析し、指示に従って回答してください。

**重要: あなたはアプリの一部です。**
- ユーザーが「反映して」「転記して」「更新して」と言った場合、\`\`\`changes\`\`\` ブロックを出力してください
- changesブロックはシステムが自動処理します。ユーザーへの説明は不要です
- 「できません」「手動で」「ボタンをクリック」等の説明は絶対に書かないでください
- changesブロックの前後に「以下のJSONで〜」等の説明文も不要です。分析結果だけ書いてください

## 現在の会社: ${companyName || "不明"}
## 対象月: ${month || "不明"}

## アプリ内の当月データ
${employeeContext}

## ルール
- 資料の内容を正確に読み取ってください
- 複数資料がある場合は比較・突合してください
- 金額の不一致や差分があれば明確に指摘してください
- 回答は日本語で簡潔に、表形式を活用してください
- ユーザーが「反映して」「転記して」と指示したら、必ず \`\`\`changes\`\`\` ブロックを出力してください

## データ反映の方法
データを反映する場合は、回答の最後に以下の形式でJSONブロックを出力してください。
ブロックはシステムが自動処理するので、ブロックについての説明文は書かないでください。

\`\`\`changes
[
  { "employeeName": "従業員のフルネーム", "field": "フィールド名", "value": 数値またはテキスト, "months": ["${month || "YYYY-MM"}"] }
]
\`\`\`

### 利用可能フィールド
- baseSalary: 基本給
- commutingAllowance: 通勤手当
- allowance1〜allowance6: 手当1〜6
- deemedOvertimePay: みなし残業手当
- deductions: 控除
- residentTax: 住民税
- unitPrice: 単価
- socialInsuranceGrade: 社保等級
- overtimeHours: 残業時間
- overtimePay: 残業代
- bonus: 賞与
- memo: 月メモ

### 出力ルール
- 金額は数値で出力（「25万」→250000）
- monthsは対象月の配列（通常は["${month || "YYYY-MM"}"]）
- employeeNameはアプリ内データに一致するフルネームを使用
- 分析のみの場合でも、アプリデータとの差分があればchangesブロックを出力する
- 差分がない場合のみchangesブロックを省略する`;

    const client = new Anthropic({ apiKey });

    // Build messages: multi-turn if following up on previous analysis
    const messages: Anthropic.Messages.MessageParam[] = previousAnalysis
      ? [
          { role: "user", content: "添付資料を分析してください。" },
          { role: "assistant", content: previousAnalysis },
          { role: "user", content: instruction },
        ]
      : [{ role: "user", content: contentBlocks }];

    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 16384,
      system: systemPrompt,
      messages,
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    // Extract structured changes from ```changes ... ``` block
    let changes: { employeeName: string; field: string; value: number | string; months: string[] }[] | undefined;
    let analysisText = text;

    // Try multiple regex patterns (handles variations in formatting)
    const changesMatch = text.match(/```changes\s*\n?([\s\S]*?)\n?```/)
      || text.match(/```changes\s*\n?([\s\S]*)\n?```/);
    if (changesMatch) {
      try {
        changes = JSON.parse(changesMatch[1].trim());
        analysisText = text.replace(/```changes[\s\S]*?```/, "").trim();
      } catch {
        // JSON parse failed — try to find JSON array in the block
        const arrayMatch = changesMatch[1].match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            changes = JSON.parse(arrayMatch[0]);
            analysisText = text.replace(/```changes[\s\S]*?```/, "").trim();
          } catch { /* give up */ }
        }
      }
    } else {
      // Fallback: closing ``` might be missing (truncated output)
      const openMatch = text.match(/```changes\s*\n?([\s\S]*)/);
      if (openMatch) {
        const arrayMatch = openMatch[1].match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            changes = JSON.parse(arrayMatch[0]);
            analysisText = text.replace(/```changes[\s\S]*/, "").trim();
          } catch {
            // Try fixing truncated JSON: find last complete object and close the array
            const lastCompleteObj = arrayMatch[0].lastIndexOf("}");
            if (lastCompleteObj > 0) {
              const fixedJson = arrayMatch[0].substring(0, lastCompleteObj + 1) + "]";
              try {
                changes = JSON.parse(fixedJson);
                analysisText = text.replace(/```changes[\s\S]*/, "").trim();
              } catch { /* give up */ }
            }
          }
        }
      }
    }

    return NextResponse.json({ success: true, analysis: analysisText, changes });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "分析に失敗しました";
    console.error("Analyze files error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
