import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
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
    const allowanceNamesStr = formData.get("allowanceNames") as string | null;

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

    // Parse company's allowance names from settings
    // Format: { allowance1Name: "職務手当", allowance2Name: "役職手当", ... }
    let settingsAllowanceNames: Record<string, string> = {};
    if (allowanceNamesStr) {
      try {
        settingsAllowanceNames = JSON.parse(allowanceNamesStr);
      } catch {
        // ignore parse errors
      }
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
      const nameKey = `allowance${i}Name`;
      // Priority: companySettings > monthlyPayroll > fallback
      const settingsName = settingsAllowanceNames[nameKey];
      const appName = appAllowanceNames[key];
      const label = settingsName || appName || "";
      const hasMappingSetting = savedMapping[key] && savedMapping[key].trim();
      if (label || hasMappingSetting) {
        CHECK_FIELDS.push({ key, label: label || `手当${i}` });
      }
    }

    // 3. Column Mapping — savedMappingからヘッダー行を検索。AIは使わない
    // Flatten all header rows into a single searchable list
    const headerCells: string[] = [];
    for (const row of headerRows) {
      for (let c = 0; c < (row?.length || 0); c++) {
        const existing = headerCells[c] || "";
        const cell = row[c] != null ? String(row[c]).trim() : "";
        // Concatenate multi-row headers (e.g. row0="通勤" row1="手当" → "通勤手当")
        headerCells[c] = existing ? (existing + cell) : cell;
      }
    }

    // Find column index by matching savedMapping value against header cells
    function findCol(excelName: string | undefined): number | null {
      if (!excelName || !excelName.trim()) return null;
      const target = excelName.trim();
      for (let c = 0; c < headerCells.length; c++) {
        const h = headerCells[c];
        if (!h) continue;
        // Exact match or contains
        if (h === target || h.includes(target) || target.includes(h)) return c;
      }
      return null;
    }

    // Build mapping from savedMapping + defaults
    const allMappingKeys: Record<string, string> = {
      employeeNumber: "社員番号",
      name: "氏名",
      ...Object.fromEntries(CHECK_FIELDS.map(f => [f.key, f.label])),
    };

    const mapping: Record<string, number | null> = {};
    for (const [key, defaultLabel] of Object.entries(allMappingKeys)) {
      // savedMapping takes priority, then try default label
      const col = findCol(savedMapping[key]) ?? findCol(defaultLabel);
      mapping[key] = col;
    }

    // Also try common aliases for name/employeeNumber if not found
    if (mapping.name == null) {
      for (const alias of ["氏名", "従業員名", "社員名", "名前"]) {
        const c = findCol(alias);
        if (c != null) { mapping.name = c; break; }
      }
    }
    if (mapping.employeeNumber == null) {
      for (const alias of ["社員番号", "従業員番号", "社員No", "No."]) {
        const c = findCol(alias);
        if (c != null) { mapping.employeeNumber = c; break; }
      }
    }

    const nameCol = mapping.name;
    if (nameCol == null) {
      return NextResponse.json(
        { error: "氏名列が特定できませんでした。マッピング設定で「氏名」のExcel列名を指定してください。" },
        { status: 400 }
      );
    }

    // Detect header row count: find first row where nameCol has a non-header-like value
    let headerRowCount = 1;
    for (let r = 0; r < Math.min(5, allRows.length); r++) {
      const cell = allRows[r]?.[nameCol];
      if (cell == null) continue;
      const s = String(cell).trim();
      // Skip rows that look like headers (contain "氏名", "名前", etc. or are empty)
      if (!s || s === "氏名" || s === "従業員名" || s === "社員名" || s === "名前" || s.includes("氏名")) {
        headerRowCount = r + 1;
      } else {
        break;
      }
    }
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
