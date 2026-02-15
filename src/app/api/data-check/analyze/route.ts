import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

// Comparison target fields
const STRING_FIELDS = new Set(["socialInsuranceGrade", "department"]);

// 手当以外の固定チェックフィールド
const BASE_CHECK_FIELDS = [
  { key: "department", label: "所属" },
  { key: "baseSalary", label: "基本給" },
  { key: "commutingAllowance", label: "通勤手当" },
  { key: "commutingUnitPrice", label: "交通費単価" },
  { key: "deemedOvertimePay", label: "みなし残業手当" },
  { key: "residentTax", label: "住民税" },
  { key: "unitPrice", label: "単価" },
  { key: "socialInsuranceGrade", label: "社保等級" },
  { key: "bonus", label: "賞与" },
] as const;

type CheckStatus = "ok" | "mismatch" | "changed" | "warning" | "no_data";

type CheckItem = {
  field: string;
  fieldLabel: string;
  excelValue: number | string | null;
  appValue: number | string | null;
  prevMonthValue: number | string | null;
  status: CheckStatus;
  message: string;
};

type EmployeeResult = {
  name: string;
  employeeNumber: string;
  checks: CheckItem[];
};

function normalizeName(name: string): string {
  return name.replace(/[\s　\u3000]+/g, "").trim();
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString("ja-JP");
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const companyName = formData.get("companyName") as string;
    const month = formData.get("month") as string;
    const excelMappingStr = formData.get("excelMapping") as string | null;

    if (!file || !companyName || !month) {
      return NextResponse.json(
        { error: "file, companyName, month は必須です" },
        { status: 400 }
      );
    }

    // Parse saved Excel mapping hints
    let savedMapping: Record<string, string> = {};
    if (excelMappingStr) {
      try {
        savedMapping = JSON.parse(excelMappingStr);
      } catch {
        // ignore parse errors
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY が設定されていません" },
        { status: 500 }
      );
    }

    // 1. Parse Excel
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Get all data as array of arrays
    const allRows: (string | number | null)[][] = XLSX.utils.sheet_to_json(
      sheet,
      { header: 1, defval: null }
    );

    if (allRows.length < 2) {
      return NextResponse.json(
        { error: "Excelデータが不足しています（2行以上必要）" },
        { status: 400 }
      );
    }

    // Extract header rows (first 3 rows for AI analysis)
    const headerRows = allRows.slice(0, Math.min(3, allRows.length));
    // Also send a sample data row for context
    const sampleRow = allRows.length > 3 ? allRows[3] : allRows[allRows.length - 1];

    // 2. Fetch Firestore data FIRST (to get app's allowance names)
    const [yearStr, monthStr] = month.split("-");
    const prevDate = new Date(parseInt(yearStr), parseInt(monthStr) - 2, 1);
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;

    const aliasDoc = await adminDb.collection("appSettings").doc("companyAliases").get();
    const aliasMappings: Record<string, string> = aliasDoc.exists
      ? aliasDoc.data()?.mappings || {}
      : {};
    const matchingNames = new Set<string>();
    matchingNames.add(companyName);
    for (const [orig, display] of Object.entries(aliasMappings)) {
      if (display === companyName) matchingNames.add(orig);
    }

    let standardWorkingHours = 160;
    const companySettingsSnap = await adminDb.collection("companySettings").get();
    for (const csDoc of companySettingsSnap.docs) {
      const cs = csDoc.data();
      const sn = cs.shortName || "";
      const on = cs.officialName || "";
      if (matchingNames.has(sn) || matchingNames.has(on) || sn.startsWith(companyName) || on.startsWith(companyName)) {
        if (cs.standardWorkingHours && cs.standardWorkingHours !== 160) {
          standardWorkingHours = cs.standardWorkingHours;
        }
      }
    }

    const snapshot = await adminDb.collection("monthlyPayroll").get();

    type AppEmployee = {
      name: string;
      employeeNumber: string;
      status: string;
      current: Record<string, number | string> | null;
      prev: Record<string, number | string> | null;
    };

    const appEmployeeMap = new Map<string, AppEmployee>();

    // Collect app's allowance names from current month data
    const appAllowanceNames: Record<string, string> = {}; // e.g. { allowance1: "職務手当", allowance2: "役職手当" }

    for (const doc of snapshot.docs) {
      const d = doc.data();
      const rawName = d.companyShortName || d.companyName || "";
      const displayName = aliasMappings[rawName] || rawName;
      if (!matchingNames.has(rawName) && displayName !== companyName) continue;
      if (!d.name || !d.month) continue;
      if (d.month !== month && d.month !== prevMonth) continue;

      // Collect allowance names from current month records
      if (d.month === month) {
        for (let i = 1; i <= 6; i++) {
          const nameKey = `allowance${i}Name`;
          const valKey = `allowance${i}`;
          if (d[nameKey] && typeof d[nameKey] === "string" && d[nameKey].trim()) {
            appAllowanceNames[valKey] = d[nameKey].trim();
          }
        }
      }

      const key = d.kintoneRecordId || d.employeeNumber || d.name;
      if (!appEmployeeMap.has(key)) {
        appEmployeeMap.set(key, {
          name: d.name,
          employeeNumber: d.employeeNumber || "",
          status: d.status || "",
          current: null,
          prev: null,
        });
      }

      const emp = appEmployeeMap.get(key)!;
      if (d.status) emp.status = d.status;

      const allFields: string[] = [...BASE_CHECK_FIELDS.map(f => f.key)];
      for (let i = 1; i <= 6; i++) allFields.push(`allowance${i}`);

      const record: Record<string, number | string> = {};
      for (const fk of allFields) {
        record[fk] = d[fk] ?? (STRING_FIELDS.has(fk) ? "" : 0);
      }
      // 単価が0（自動計算）の場合、(基本給+手当合計)/所定労働時間で算出
      if (!record.unitPrice || record.unitPrice === 0) {
        const base = Number(record.baseSalary) || 0;
        let allowanceSum = 0;
        for (let i = 1; i <= 6; i++) allowanceSum += Number(d[`allowance${i}`]) || 0;
        if (standardWorkingHours > 0) {
          record.unitPrice = Math.round((base + allowanceSum) / standardWorkingHours * 100) / 100;
        }
      }

      if (d.month === month) {
        emp.current = record;
      } else if (d.month === prevMonth) {
        emp.prev = record;
      }
    }

    // Build dynamic CHECK_FIELDS: base fields + allowances that are configured in app OR in savedMapping
    const CHECK_FIELDS: { key: string; label: string }[] = [...BASE_CHECK_FIELDS];
    for (let i = 1; i <= 6; i++) {
      const key = `allowance${i}`;
      const appName = appAllowanceNames[key];
      const hasMappingSetting = savedMapping[key] && savedMapping[key].trim();
      if (appName || hasMappingSetting) {
        CHECK_FIELDS.push({ key, label: appName || `手当${i}` });
      }
    }

    // 3. AI Column Mapping (now with app's actual allowance names)
    const client = new Anthropic({ apiKey });

    const fieldDescriptions = CHECK_FIELDS.map(
      (f) => `- ${f.key}: ${f.label}`
    ).join("\n");

    const mappingHints = Object.entries(savedMapping)
      .filter(([, v]) => v && v.trim())
      .map(([key, excelName]) => `- ${key} の列ヘッダーは「${excelName}」です`)
      .join("\n");

    // Build allowance output format dynamically
    const allowanceOutputLines: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const key = `allowance${i}`;
      if (appAllowanceNames[key]) {
        allowanceOutputLines.push(`  "${key}": 列番号 or null`);
      }
    }

    const mappingPrompt = `以下はExcelの給与明細データのヘッダー行とサンプルデータ行です。
各列がどの給与フィールドに対応するかマッピングしてください。

## ヘッダー行
${headerRows.map((row, i) => `Row ${i}: ${JSON.stringify(row)}`).join("\n")}

## サンプルデータ行
${JSON.stringify(sampleRow)}

## マッピング対象フィールド
- employeeNumber: 社員番号（従業員番号、社員No、No.等）
- name: 氏名（従業員名、社員名）
${fieldDescriptions}
${mappingHints ? `\n## この会社の既知のマッピング（最優先で使用してください）\n${mappingHints}\n` : ""}
## ルール
- 各フィールドに対して、最も適切な列番号（0始まり）を返してください
- 該当する列がない場合はnullを返してください
- employeeNumberフィールドがあれば必ず返してください（社員番号の列）
- nameフィールドは必須です（氏名が入っている列）
- 所属: 「部門」「部署」「所属」「支店」等
- 基本給: 「基本給」「基本賃金」等のヘッダーの列
- 通勤手当: 「通勤手当(非)」「交通費月額」「通勤手当」等
- 交通費単価: 「交通費日額」「交通費単価」「通勤日額」等。パート・アルバイトの1日あたりの交通費
- みなし残業手当: 「みなし残業手当」「固定残業代」等
- 住民税: 「住民税」
- 単価: 「時給単価」「KY12_7」等
- 社保等級: 「健康保険_標準額」「標準報酬月額」等の列。数値が入る
- 賞与: 「賞与」「ボーナス」「支給額」等
${Object.keys(appAllowanceNames).length > 0 ? `- 手当: アプリに登録されている手当名でExcelの列を探してください。手当名と完全一致しなくても、類似のヘッダーがあればマッピングしてください` : ""}
- ヘッダーが2行にまたがる場合（Row 0とRow 1の結合）も考慮してください
- データ行の先頭に社員番号がある場合はemployeeNumberとしてマッピングしてください

## 出力形式（JSONのみ、コードブロック不使用）
{
  "employeeNumber": 列番号 or null,
  "name": 列番号,
  "department": 列番号 or null,
  "baseSalary": 列番号 or null,
  "commutingAllowance": 列番号 or null,
  "commutingUnitPrice": 列番号 or null,
  "deemedOvertimePay": 列番号 or null,
  "residentTax": 列番号 or null,
  "unitPrice": 列番号 or null,
  "socialInsuranceGrade": 列番号 or null,
  "bonus": 列番号 or null,
${allowanceOutputLines.length > 0 ? allowanceOutputLines.join(",\n") + "," : ""}
  "headerRowCount": ヘッダーの行数（データが始まる行番号）
}`;

    const aiResponse = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: mappingPrompt }],
    });

    const aiText =
      aiResponse.content[0].type === "text" ? aiResponse.content[0].text : "";
    let mapping: Record<string, number | string | null>;
    try {
      const jsonStr = aiText
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "")
        .trim();
      mapping = JSON.parse(jsonStr);
    } catch {
      return NextResponse.json(
        { error: "AI列マッピングの解析に失敗しました", raw: aiText },
        { status: 500 }
      );
    }

    const nameCol = mapping.name as number;
    if (nameCol == null) {
      return NextResponse.json(
        { error: "氏名列が特定できませんでした" },
        { status: 400 }
      );
    }

    const headerRowCount = (mapping.headerRowCount as number) || 2;
    const dataRows = allRows.slice(headerRowCount);

    // 4. Extract structured data from Excel
    type ExcelEmployee = {
      name: string;
      employeeNumber: string;
      data: Record<string, number | string | null>;
    };

    const empNumCol = mapping.employeeNumber as number | null;

    const excelEmployees: ExcelEmployee[] = [];
    for (const row of dataRows) {
      const rawName = row[nameCol];
      if (!rawName || typeof rawName !== "string" || !rawName.trim()) continue;
      const name = rawName.trim();

      let employeeNumber = "";
      if (empNumCol != null && row[empNumCol] != null) {
        const raw = row[empNumCol];
        employeeNumber = String(raw).trim();
      }

      const empData: Record<string, number | string | null> = {};
      for (const field of CHECK_FIELDS) {
        const col = mapping[field.key] as number | null;
        if (col != null && row[col] != null) {
          const val = row[col];
          if (STRING_FIELDS.has(field.key)) {
            empData[field.key] = String(val).trim();
          } else {
            empData[field.key] = typeof val === "number" ? val : parseFloat(String(val)) || 0;
          }
        } else {
          empData[field.key] = null;
        }
      }
      excelEmployees.push({ name, employeeNumber, data: empData });
    }

    // 5. Compare (社員番号優先、名前で補助マッチ)
    const results: EmployeeResult[] = [];
    const matchedAppKeys = new Set<string>();

    for (const excelEmp of excelEmployees) {
      // Find matching app employee: 社員番号 → 名前 の優先順
      let matchedApp: AppEmployee | null = null;
      let matchedKey: string | null = null;

      // 1. 社員番号でマッチ
      if (excelEmp.employeeNumber) {
        for (const [key, appEmp] of appEmployeeMap) {
          if (appEmp.employeeNumber && appEmp.employeeNumber === excelEmp.employeeNumber) {
            matchedApp = appEmp;
            matchedKey = key;
            break;
          }
        }
      }

      // 2. 名前でフォールバック
      if (!matchedApp) {
        const normalizedExcelName = normalizeName(excelEmp.name);
        for (const [key, appEmp] of appEmployeeMap) {
          if (normalizeName(appEmp.name) === normalizedExcelName) {
            matchedApp = appEmp;
            matchedKey = key;
            break;
          }
        }
      }

      if (matchedKey) matchedAppKeys.add(matchedKey);

      const checks: CheckItem[] = [];

      for (const field of CHECK_FIELDS) {
        const excelVal = excelEmp.data[field.key];
        const appVal = matchedApp?.current?.[field.key] ?? null;
        const prevVal = matchedApp?.prev?.[field.key] ?? null;

        const fieldLabel: string = field.label;

        if (excelVal == null && appVal == null) continue; // Both empty, skip
        if (excelVal == null) {
          // Excel has no data for this field
          if (appVal != null && appVal !== 0 && appVal !== "") {
            checks.push({
              field: field.key,
              fieldLabel,
              excelValue: null,
              appValue: appVal,
              prevMonthValue: prevVal,
              status: "no_data",
              message: "Excelにデータなし",
            });
          }
          continue;
        }

        let status: CheckStatus;
        let message: string;

        if (matchedApp == null || appVal == null) {
          // No app data
          status = "no_data";
          message = "アプリにデータなし";
        } else if (field.key === "department") {
          // 所属: 部分一致でOK
          const exStr = String(excelVal).trim();
          const appStr = String(appVal).trim();
          const match = exStr === appStr || appStr.includes(exStr) || exStr.includes(appStr);
          status = match ? "ok" : "mismatch";
          message = match
            ? "一致"
            : `不一致（Excel: ${exStr} / アプリ: ${appStr}）`;
        } else if (STRING_FIELDS.has(field.key)) {
          // String comparison (exact)
          status = String(excelVal) === String(appVal) ? "ok" : "mismatch";
          message =
            status === "ok"
              ? "一致"
              : `不一致（Excel: ${excelVal} / アプリ: ${appVal}）`;
        } else {
          const exNum = typeof excelVal === "number" ? excelVal : parseFloat(String(excelVal)) || 0;
          const appNum = typeof appVal === "number" ? appVal : parseFloat(String(appVal)) || 0;

          if (exNum === appNum) {
            // Check prev month change
            if (prevVal != null) {
              const prevNum = typeof prevVal === "number" ? prevVal : parseFloat(String(prevVal)) || 0;
              if (prevNum !== exNum && prevNum > 0) {
                status = "changed";
                const diff = exNum - prevNum;
                message = `前月変動（${fmtNum(prevNum)} → ${fmtNum(exNum)}、差: ${diff > 0 ? "+" : ""}${fmtNum(diff)}）`;
              } else {
                status = "ok";
                message = "一致";
              }
            } else {
              status = "ok";
              message = "一致";
            }
          } else {
            status = "mismatch";
            message = `不一致（Excel: ${fmtNum(exNum)} / アプリ: ${fmtNum(appNum)}）`;
          }
        }

        checks.push({
          field: field.key,
          fieldLabel,
          excelValue: excelVal,
          appValue: appVal,
          prevMonthValue: prevVal,
          status,
          message,
        });
      }

      results.push({
        name: excelEmp.name,
        employeeNumber: matchedApp?.employeeNumber || "",
        checks,
      });
    }

    // People diff
    const activeAppEntries = Array.from(appEmployeeMap.entries()).filter(
      ([, e]) => e.status !== "退社" && e.current != null
    );
    const missing = activeAppEntries
      .filter(([key]) => !matchedAppKeys.has(key))
      .map(([, e]) => e.name);

    const matchedExcelKeys = new Set<string>();
    for (const excelEmp of excelEmployees) {
      let found = false;
      if (excelEmp.employeeNumber) {
        for (const [, appEmp] of appEmployeeMap) {
          if (appEmp.employeeNumber === excelEmp.employeeNumber) { found = true; break; }
        }
      }
      if (!found) {
        const n = normalizeName(excelEmp.name);
        for (const [, appEmp] of appEmployeeMap) {
          if (normalizeName(appEmp.name) === n) { found = true; break; }
        }
      }
      if (!found) matchedExcelKeys.add(excelEmp.name);
    }
    const newInExcel = Array.from(matchedExcelKeys);

    // Build clean mapping for frontend display (remove internal fields)
    const cleanMapping: Record<string, number | string | null> = {};
    for (const field of CHECK_FIELDS) {
      cleanMapping[field.key] = mapping[field.key] as number | null;
    }
    cleanMapping["name"] = mapping["name"];

    return NextResponse.json({
      month,
      mapping: cleanMapping,
      results,
      missing,
      newInExcel,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "データチェックに失敗しました";
    console.error("Data check error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
