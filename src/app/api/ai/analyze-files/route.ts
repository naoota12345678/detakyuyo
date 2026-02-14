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
          const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
          texts.push(`【シート: ${sheetName}】\n${csv}`);
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

    // Add instruction
    contentBlocks.push({
      type: "text",
      text: instruction,
    });

    const systemPrompt = `あなたは給与管理アシスタントです。
ユーザーがアップロードした資料を分析し、指示に従って回答してください。

## 現在の会社: ${companyName || "不明"}
## 対象月: ${month || "不明"}

## アプリ内の当月データ
${employeeContext}

## ルール
- 資料の内容を正確に読み取ってください
- 複数資料がある場合は比較・突合してください
- 金額の不一致や差分があれば明確に指摘してください
- 回答は日本語で簡潔に、表形式を活用してください`;

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: contentBlocks }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    return NextResponse.json({ success: true, analysis: text });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "分析に失敗しました";
    console.error("Analyze files error:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
