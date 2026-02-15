import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function buildEmployeeContext(docs: FirebaseFirestore.QueryDocumentSnapshot[], month: string): { payroll: string; roster: string } {
  // 当月の給与データ
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
      commutingUnitPrice: d.commutingUnitPrice || 0,
      socialInsuranceGrade: d.socialInsuranceGrade || "",
    });
  }
  const payroll = byName.size === 0 ? "（当月のアプリデータなし）" : Array.from(byName.entries()).map(
    ([name, d]) => {
      const r = d as Record<string, unknown>;
      return `${name}(${r.employeeNumber}): 基本給${r.baseSalary}, 通勤${r.commutingAllowance}, 交通費単価${r.commutingUnitPrice}, みなし${r.deemedOvertimePay}, 住民税${r.residentTax}, 賞与${r.bonus}, 単価${r.unitPrice}`;
    }
  ).join("\n");

  // 全従業員の在籍情報（最新月のデータから取得）
  const empInfo = new Map<string, { status: string; hireDate: string; leaveDate: string; employmentType: string; branchName: string; employeeNumber: string }>();
  for (const doc of docs) {
    const d = doc.data();
    const name = d.name as string;
    if (!empInfo.has(name) || (d.month > (empInfo.get(name) as { status: string }).status)) {
      empInfo.set(name, {
        status: d.status || "在籍",
        hireDate: d.hireDate || "",
        leaveDate: d.leaveDate || "",
        employmentType: d.employmentType || "",
        branchName: d.branchName || "",
        employeeNumber: d.employeeNumber || "",
      });
    }
  }
  const rosterLines: string[] = [];
  for (const [name, info] of empInfo) {
    const parts = [`${name}(${info.employeeNumber}): ${info.status}`];
    if (info.employmentType) parts.push(info.employmentType);
    if (info.branchName) parts.push(info.branchName);
    if (info.hireDate) parts.push(`入社${info.hireDate}`);
    if (info.leaveDate) parts.push(`退社日${info.leaveDate}`);
    rosterLines.push(parts.join(", "));
  }
  const roster = rosterLines.length === 0 ? "（従業員データなし）" : rosterLines.join("\n");

  return { payroll, roster };
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
    let employeeContext = { payroll: "", roster: "" };
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
          const ref = sheet["!ref"];
          if (!ref) continue;

          // Parse with raw values for numbers, formatted for display
          const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
            raw: true,    // Get raw numeric values (not formatted strings)
            defval: null,
          });

          if (jsonRows.length > 0 && Object.keys(jsonRows[0]).length > 1) {
            // Convert each row to explicit key:value record
            const headers = Object.keys(jsonRows[0]);
            const records: string[] = [];
            for (const row of jsonRows) {
              const pairs: string[] = [];
              for (const h of headers) {
                const v = row[h];
                if (v === null || v === undefined || v === "") continue;
                pairs.push(`${h}: ${v}`);
              }
              if (pairs.length > 0) {
                records.push(`{${pairs.join(", ")}}`);
              }
            }
            texts.push(`【シート: ${sheetName}】（${jsonRows.length}件のデータ、列: ${headers.join(", ")}）\n${records.join("\n")}`);
          } else {
            // Fallback for complex layouts: cell-by-cell
            const range = XLSX.utils.decode_range(ref);
            const rows: string[] = [];
            for (let r = range.s.r; r <= range.e.r; r++) {
              const cells: string[] = [];
              let hasValue = false;
              for (let c = range.s.c; c <= range.e.c; c++) {
                const addr = XLSX.utils.encode_cell({ r, c });
                const cell = sheet[addr];
                if (cell) {
                  const col = XLSX.utils.encode_col(c);
                  const val = cell.v !== undefined ? String(cell.v) : "";
                  if (val) {
                    cells.push(`${col}${r + 1}=${val}`);
                    hasValue = true;
                  }
                }
              }
              if (hasValue) {
                rows.push(cells.join(", "));
              }
            }
            texts.push(`【シート: ${sheetName}】\n${rows.join("\n")}`);
          }
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

# 最重要ルール
**ユーザーメッセージに「【ファイル: ...】」で始まるデータがあります。これがアップロードされた資料の中身です。**
**あなたの仕事は、このファイルデータを読み取り、具体的な数値・データを報告することです。**

- 「調べて」「確認して」「教えて」→ ファイルの中身から該当データを探し、従業員ごとに具体的な値を一覧で報告
- 「反映して」「転記して」→ ファイルのデータをchangesブロックで出力
- ファイルの列名がユーザーの質問と完全一致しなくても、関連する列のデータを報告すること
- **「できません」「確認することができません」「直接アクセスできません」「手動で」等の回答は絶対禁止**
- ファイルのデータはあなたの目の前にあります。読めないと言わず、読んで具体的な値を返してください

# 会社: ${companyName || "不明"} ／ 対象月: ${month || "不明"}

# ファイルの読み取り方
- ファイルは {列名: 値, 列名: 値} のレコード形式でメッセージに含まれています
- 各レコードが1人の従業員データです
- 列名の例: 氏名、社員番号、単価、交通費、通勤、基本給 等（ファイルによって異なる）
- ユーザーが「交通費単価」と言っても、ファイル上の列名は「交通費」「通勤単価」等の場合があります。柔軟にマッチしてください

# アプリ内の既存データ（比較・突合用）
## 従業員名簿
${employeeContext.roster}
## 当月給与データ
${employeeContext.payroll}

# ルール
- 数値の正確性が最重要: 資料の数値をそのまま転記。推測・概算・計算は禁止
- 値が読み取れない場合は「不明」と回答（推測値を返さない）
- 複数資料がある場合は比較・突合し、不一致があれば指摘
- 回答は日本語で簡潔に
- 全従業員分・全フィールドを漏れなく返すこと。一部省略は禁止
- 従業員の在籍・退社について聞かれたら従業員名簿を参照

# データ反映（changesブロック）
反映指示があった場合のみ、回答の最後に出力。説明文は不要。
\`\`\`changes
[
  { "employeeName": "フルネーム", "field": "フィールド名", "value": 数値またはテキスト, "months": ["${month || "YYYY-MM"}"] }
]
\`\`\`
利用可能フィールド: baseSalary(基本給), commutingAllowance(通勤手当月額), commutingUnitPrice(交通費単価/日額), allowance1〜6(手当), deemedOvertimePay(みなし残業), deductions(控除), residentTax(住民税), unitPrice(単価/時給), socialInsuranceGrade(社保等級), overtimeHours(残業時間), overtimePay(残業代), bonus(賞与), memo(月メモ)
金額は数値で出力（「25万」→250000）。employeeNameはアプリ内の名前と一致させる。`;

    const client = new Anthropic({ apiKey });

    // Build messages: multi-turn if following up on previous analysis
    const messages: Anthropic.Messages.MessageParam[] = previousAnalysis
      ? [
          // フォローアップ時もファイル内容を最初のメッセージに含める
          { role: "user", content: contentBlocks.length > 0
            ? [...contentBlocks, { type: "text" as const, text: "添付資料を分析してください。" }]
            : "添付資料を分析してください。" },
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

    // デバッグ: AIに送信されたファイル内容を返す
    const fileContentsSent = contentBlocks
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === "text")
      .map(b => b.text)
      .filter(t => t.startsWith("【ファイル:"));

    return NextResponse.json({ success: true, analysis: analysisText, changes, _debug: { fileContentsSent } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "分析に失敗しました";
    console.error("Analyze files error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
