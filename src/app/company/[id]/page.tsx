"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc, query, where, orderBy } from "firebase/firestore";

// ========================================
// Types
// ========================================
type MonthlyData = {
  docId: string;
  baseSalary: number;
  commutingAllowance: number;
  otherAllowances: number;
  deductions: number;
  overtimeHours: number;
  overtimePay: number;
  totalPayment: number;
  memo: string;
  confirmed: boolean;
  events: string[];
  allowance1: number;
  allowance1Name: string;
  allowance2: number;
  allowance2Name: string;
  allowance3: number;
  allowance3Name: string;
  allowance4: number;
  allowance4Name: string;
  allowance5: number;
  allowance5Name: string;
  allowance6: number;
  allowance6Name: string;
  deemedOvertimePay: number;
  commutingType: string; // "月額" or "日額"
  employeeMemo: string;
  residentTax: number;
  socialInsuranceGrade: string;
  unitPrice: number;
};

type EmployeeRow = {
  employeeNumber: string;
  name: string;
  branchName: string;
  employmentType: string;
  hireDate: string;
  status: string;
  months: Record<string, MonthlyData>;
};

type SlackMessage = {
  docId: string;
  text: string;
  timestamp: string;
  processed: boolean;
  createdAt: Date;
};

type SortKey = "employeeNumber" | "name" | "hireDate";

type CompanyMeta = {
  name: string;
  closingDay: number | null;
  payDay: number | null;
  standardWorkingHours: number;
};

// ========================================
// Helpers
// ========================================
function shortType(t: string): string {
  if (!t) return "";
  if (t.includes("正社員") || t === "正") return "正";
  if (t.includes("パート")) return "パ";
  if (t.includes("アルバイト")) return "ア";
  if (t.includes("契約")) return "契";
  if (t.includes("役員")) return "役";
  if (t.includes("嘱託")) return "嘱";
  return t.slice(0, 1);
}

function shortBranch(name: string, companyName?: string): string {
  if (!name) return "";
  // 会社ページ上では会社名を除去して所属（支店・オフィス名）だけ表示
  if (companyName) {
    const stripped = name.replace(companyName, "").replace(/^[\s　/／]+/, "").trim();
    if (stripped) return stripped.length > 12 ? stripped.slice(0, 12) + "…" : stripped;
  }
  return name.length > 12 ? name.slice(0, 12) + "…" : name;
}

function fmt(n: number): string {
  return n.toLocaleString("ja-JP");
}

function formatHireDate(d: string): string {
  if (!d) return "";
  const parts = d.split("-");
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return d;
}

function formatMonthLabel(m: string): string {
  const [, mo] = m.split("-");
  return `${parseInt(mo)}月`;
}

function getTwelveMonths(months: string[]): string[] {
  let startY: number, startM: number;
  if (months.length === 0) {
    const now = new Date();
    startY = now.getFullYear();
    startM = now.getMonth() + 1;
  } else {
    [startY, startM] = months[0].split("-").map(Number);
  }
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(startY, startM - 1 + i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

function totalAllowances(data: MonthlyData): number {
  return data.allowance1 + data.allowance2 + data.allowance3 + data.allowance4 + data.allowance5 + data.allowance6;
}

function calcUnitPrice(data: MonthlyData, swh: number): number {
  if (data.unitPrice) return data.unitPrice;
  if (swh <= 0) return 0;
  return Math.round((data.baseSalary + totalAllowances(data)) / swh);
}

// ========================================
// Main Component
// ========================================
function CompanyPageContent() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [company, setCompany] = useState<CompanyMeta | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [detailEmployee, setDetailEmployee] = useState<EmployeeRow | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("employeeNumber");
  const [completing, setCompleting] = useState(false);
  const [slackMessages, setSlackMessages] = useState<SlackMessage[]>([]);
  // AI指示
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{
    success: boolean;
    employeeName?: string;
    changes?: { field: string; value: number | string; months: string[]; mode?: "set" | "append" }[];
    summary?: string;
    error?: string;
  } | null>(null);
  const [aiApplying, setAiApplying] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    try {
      const companyName = decodeURIComponent(id);

      const aliasDoc = await getDoc(doc(db, "appSettings", "companyAliases"));
      const aliasMappings: Record<string, string> = aliasDoc.exists()
        ? aliasDoc.data().mappings || {}
        : {};
      const matchingNames = new Set<string>();
      matchingNames.add(companyName);
      for (const [orig, display] of Object.entries(aliasMappings)) {
        if (display === companyName) matchingNames.add(orig);
      }

      const companiesSnapshot = await getDocs(collection(db, "companySettings"));
      let closingDay: number | null = null;
      let payDay: number | null = null;
      let standardWorkingHours = 160;
      // 完全一致 or shortNameがcompanyNameで始まるエントリも対象にする
      companiesSnapshot.docs.forEach((d) => {
        const data = d.data();
        const sn = data.shortName || "";
        const on = data.officialName || "";
        const isMatch = matchingNames.has(sn) || matchingNames.has(on)
          || sn.startsWith(companyName) || on.startsWith(companyName);
        if (isMatch) {
          if (data.closingDay != null) closingDay = data.closingDay;
          if (data.payDay != null) payDay = data.payDay;
          if (data.standardWorkingHours && data.standardWorkingHours !== 160) {
            standardWorkingHours = data.standardWorkingHours;
          }
        }
      });
      setCompany({ name: companyName, closingDay, payDay, standardWorkingHours });

      const snapshot = await getDocs(collection(db, "monthlyPayroll"));
      const empMap = new Map<string, EmployeeRow>();
      const monthSet = new Set<string>();

      snapshot.docs.forEach((d) => {
        const data = d.data();
        const rawName = data.companyShortName || data.companyName || "";
        const displayName = aliasMappings[rawName] || rawName;
        if (!matchingNames.has(rawName) && displayName !== companyName) return;

        const key = data.kintoneRecordId || data.employeeNumber || data.name;
        const month = data.month;
        if (!month) return;
        monthSet.add(month);

        if (!empMap.has(key)) {
          empMap.set(key, {
            employeeNumber: data.employeeNumber || "",
            name: data.name || "",
            branchName: data.branchName || "",
            employmentType: data.employmentType || "",
            hireDate: data.hireDate || "",
            status: data.status || "",
            months: {},
          });
        }
        const emp = empMap.get(key)!;
        if (!emp.name && data.name) emp.name = data.name;
        if (!emp.hireDate && data.hireDate) emp.hireDate = data.hireDate;
        if (data.status) emp.status = data.status;

        emp.months[month] = {
          docId: d.id,
          baseSalary: data.baseSalary || 0,
          commutingAllowance: data.commutingAllowance || 0,
          otherAllowances: data.otherAllowances || 0,
          deductions: data.deductions || 0,
          overtimeHours: data.overtimeHours || 0,
          overtimePay: data.overtimePay || 0,
          totalPayment: data.totalPayment || 0,
          memo: data.memo || "",
          confirmed: data.confirmed || false,
          events: data.events || [],
          allowance1: data.allowance1 || 0,
          allowance1Name: data.allowance1Name || "手当1",
          allowance2: data.allowance2 || 0,
          allowance2Name: data.allowance2Name || "手当2",
          allowance3: data.allowance3 || 0,
          allowance3Name: data.allowance3Name || "手当3",
          allowance4: data.allowance4 || 0,
          allowance4Name: data.allowance4Name || "手当4",
          allowance5: data.allowance5 || 0,
          allowance5Name: data.allowance5Name || "手当5",
          allowance6: data.allowance6 || 0,
          allowance6Name: data.allowance6Name || "手当6",
          deemedOvertimePay: data.deemedOvertimePay || 0,
          commutingType: data.commutingType || "月額",
          employeeMemo: data.employeeMemo || "",
          residentTax: data.residentTax || 0,
          socialInsuranceGrade: data.socialInsuranceGrade || "",
          unitPrice: data.unitPrice || 0,
        };
      });

      setMonths(Array.from(monthSet).sort());
      setEmployees(
        Array.from(empMap.values()).sort((a, b) =>
          a.employeeNumber.localeCompare(b.employeeNumber)
        )
      );

      // Slackメッセージ読み込み
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const slackQuery = query(
        collection(db, "slackMessages"),
        where("companyName", "==", companyName),
        where("month", "==", currentMonth),
        orderBy("createdAt", "desc")
      );
      const slackSnap = await getDocs(slackQuery);
      setSlackMessages(
        slackSnap.docs.map((d) => ({
          docId: d.id,
          text: d.data().text || "",
          timestamp: d.data().timestamp || "",
          processed: d.data().processed || false,
          createdAt: d.data().createdAt?.toDate() || new Date(),
        }))
      );
    } catch (e) {
      console.error("Failed to load:", e);
    } finally {
      setLoadingData(false);
    }
  }, [id]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  // 汎用フィールド保存
  const saveField = async (docId: string, field: string, value: number | boolean | string) => {
    try {
      await fetch("/api/payroll/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, field, value }),
      });
      // ローカル更新
      setEmployees((prev) =>
        prev.map((emp) => {
          let changed = false;
          const newMonths = { ...emp.months };
          for (const m of Object.keys(newMonths)) {
            if (newMonths[m].docId === docId) {
              newMonths[m] = { ...newMonths[m], [field]: value };
              changed = true;
            }
          }
          return changed ? { ...emp, months: newMonths } : emp;
        })
      );
      // detailEmployee も更新
      if (detailEmployee) {
        setDetailEmployee((prev) => {
          if (!prev) return prev;
          const newMonths = { ...prev.months };
          for (const m of Object.keys(newMonths)) {
            if (newMonths[m].docId === docId) {
              newMonths[m] = { ...newMonths[m], [field]: value };
            }
          }
          return { ...prev, months: newMonths };
        });
      }
    } catch (e) {
      console.error("Save failed:", e);
    }
  };

  // employeeMemo は全月に反映
  const saveEmployeeMemo = async (emp: EmployeeRow, value: string) => {
    try {
      const docIds = Object.values(emp.months).map((m) => m.docId);
      await Promise.all(
        docIds.map((docId) =>
          fetch("/api/payroll/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docId, field: "employeeMemo", value }),
          })
        )
      );
      // ローカル更新
      setEmployees((prev) =>
        prev.map((e) => {
          if (e.employeeNumber !== emp.employeeNumber && e.name !== emp.name) return e;
          const newMonths = { ...e.months };
          for (const m of Object.keys(newMonths)) {
            newMonths[m] = { ...newMonths[m], employeeMemo: value };
          }
          return { ...e, months: newMonths };
        })
      );
      if (detailEmployee && detailEmployee.name === emp.name) {
        setDetailEmployee((prev) => {
          if (!prev) return prev;
          const newMonths = { ...prev.months };
          for (const m of Object.keys(newMonths)) {
            newMonths[m] = { ...newMonths[m], employeeMemo: value };
          }
          return { ...prev, months: newMonths };
        });
      }
    } catch (e) {
      console.error("Save employeeMemo failed:", e);
    }
  };

  // Slackメッセージ処理済みトグル
  const toggleSlackProcessed = async (msgDocId: string, current: boolean) => {
    try {
      await fetch("/api/slack/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId: msgDocId, field: "processed", value: !current }),
      });
      setSlackMessages((prev) =>
        prev.map((m) => m.docId === msgDocId ? { ...m, processed: !current } : m)
      );
    } catch (e) {
      console.error("Toggle slack processed failed:", e);
    }
  };

  // AI指示を送信
  const handleAiInstruction = async () => {
    if (!aiInstruction.trim() || aiLoading) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      const activeEmps = employees.filter((e) => e.status !== "退社");
      const empList = activeEmps.map((e) => ({ name: e.name, employeeNumber: e.employeeNumber }));
      // 現在の人メモを収集
      const employeeMemos: Record<string, string> = {};
      for (const emp of activeEmps) {
        const latestMonth = [...months].reverse().find((m) => emp.months[m]);
        if (latestMonth) {
          employeeMemos[emp.name] = emp.months[latestMonth].employeeMemo || "";
        }
      }
      const res = await fetch("/api/ai/parse-instruction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: aiInstruction,
          employees: empList,
          months,
          employeeMemos,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setAiResult({ success: false, error: result.error || "エラーが発生しました" });
      } else {
        setAiResult(result);
      }
    } catch (e) {
      console.error("AI instruction failed:", e);
      setAiResult({ success: false, error: "AI処理に失敗しました" });
    } finally {
      setAiLoading(false);
    }
  };

  // AI提案を反映
  const handleAiApply = async () => {
    if (!aiResult?.success || !aiResult.changes || !aiResult.employeeName) return;
    setAiApplying(true);
    try {
      const targetEmp = employees.find((e) => e.name === aiResult.employeeName);
      if (!targetEmp) {
        alert("対象従業員が見つかりません");
        return;
      }
      for (const change of aiResult.changes) {
        const isAppend = change.mode === "append";

        if (change.field === "employeeMemo") {
          // 人メモは全月共通で保存
          const latestMonth = [...months].reverse().find((m) => targetEmp.months[m]);
          const currentMemo = latestMonth ? targetEmp.months[latestMonth].employeeMemo || "" : "";
          const newValue = isAppend && currentMemo
            ? currentMemo + "\n" + String(change.value)
            : String(change.value);
          await saveEmployeeMemo(targetEmp, newValue);
        } else if (change.months.length === 0) {
          // 月指定なし → 全月に適用
          for (const m of Object.keys(targetEmp.months)) {
            const data = targetEmp.months[m];
            if (data) {
              const finalValue = isAppend && change.field === "memo"
                ? (data.memo ? data.memo + "\n" + String(change.value) : String(change.value))
                : change.value;
              await saveField(data.docId, change.field, finalValue);
            }
          }
        } else {
          for (const month of change.months) {
            const data = targetEmp.months[month];
            if (data) {
              const finalValue = isAppend && change.field === "memo"
                ? (data.memo ? data.memo + "\n" + String(change.value) : String(change.value))
                : change.value;
              await saveField(data.docId, change.field, finalValue);
            }
          }
        }
      }
      setAiResult(null);
      setAiInstruction("");
    } catch (e) {
      console.error("AI apply failed:", e);
      alert("反映に失敗しました");
    } finally {
      setAiApplying(false);
    }
  };

  // 完了→翌月生成
  const handleComplete = async () => {
    if (!company || months.length === 0) return;
    const latestMonth = months[months.length - 1];
    if (!confirm(`${company.name} の ${latestMonth} を完了して翌月レコードを生成しますか？\nメモはクリアされます。`)) return;

    setCompleting(true);
    try {
      const res = await fetch("/api/monthly/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: company.name, currentMonth: latestMonth }),
      });
      const result = await res.json();
      if (result.success) {
        const msg = [`${result.nextMonth} を生成しました（${result.created}名）`];
        if (result.skipped > 0) msg.push(`既存スキップ: ${result.skipped}名`);
        if (result.alerts?.length > 0) msg.push(`\nアラート:\n${result.alerts.join("\n")}`);
        alert(msg.join("\n"));
        loadData();
      } else {
        alert(result.message || result.error || "生成に失敗しました");
      }
    } catch (e) {
      console.error("Complete failed:", e);
      alert("生成に失敗しました");
    } finally {
      setCompleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-500">読み込み中...</p>
      </div>
    );
  }
  if (!user) return null;

  const swh = company?.standardWorkingHours || 160;

  const sortFn = (a: EmployeeRow, b: EmployeeRow) => {
    if (sortKey === "name") return a.name.localeCompare(b.name, "ja");
    if (sortKey === "hireDate") return (a.hireDate || "9999").localeCompare(b.hireDate || "9999");
    return a.employeeNumber.localeCompare(b.employeeNumber);
  };
  const activeEmployees = employees.filter((e) => e.status !== "退社").sort(sortFn);
  const retiredEmployees = employees.filter((e) => e.status === "退社").sort(sortFn);
  const activeCount = activeEmployees.length;

  // 附番重複チェック（同一会社内）
  const duplicateNumbers = (() => {
    const numMap = new Map<string, string[]>();
    for (const emp of employees) {
      if (!emp.employeeNumber) continue;
      const names = numMap.get(emp.employeeNumber) || [];
      names.push(emp.name);
      numMap.set(emp.employeeNumber, names);
    }
    const dupes: { number: string; names: string[] }[] = [];
    for (const [num, names] of numMap) {
      if (names.length > 1) dupes.push({ number: num, names });
    }
    return dupes;
  })();

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push("/")} className="text-sm text-blue-600 hover:text-blue-800">
              ← 会社一覧
            </button>
            {company && (
              <div>
                <h1 className="text-lg font-semibold text-zinc-900">{company.name}</h1>
                <div className="flex items-center gap-3 text-xs text-zinc-500">
                  <span>締日: {company.closingDay ? `${company.closingDay}日` : "-"}</span>
                  <span>支払日: {company.payDay ? `${company.payDay}日` : "-"}</span>
                  <span>所定: {swh}h</span>
                  <span>{activeCount}名{retiredEmployees.length > 0 && ` (退職${retiredEmployees.length}名)`}</span>
                </div>
              </div>
            )}
          </div>
          <span className="text-sm text-zinc-500">{user.email}</span>
        </div>
      </header>

      <main className="p-4">
        {loadingData ? (
          <p className="text-zinc-500">読み込み中...</p>
        ) : employees.length === 0 ? (
          <p className="text-zinc-500">データがありません。</p>
        ) : (
          <>
            {/* Slack連絡事項 */}
            {slackMessages.length > 0 && (
              <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-blue-800">
                    Slack連絡事項（{slackMessages.filter((m) => !m.processed).length}件未処理）
                  </h3>
                </div>
                <div className="space-y-1.5">
                  {slackMessages.map((msg) => (
                    <div
                      key={msg.docId}
                      className={`flex items-start gap-2 rounded px-2.5 py-1.5 text-xs ${msg.processed ? "bg-blue-100/50 text-blue-400 line-through" : "bg-white text-zinc-800 border border-blue-100"}`}
                    >
                      <button
                        onClick={() => toggleSlackProcessed(msg.docId, msg.processed)}
                        className={`mt-0.5 shrink-0 h-4 w-4 rounded border ${msg.processed ? "bg-blue-500 border-blue-500 text-white" : "border-zinc-300 hover:border-blue-400"} flex items-center justify-center`}
                        title={msg.processed ? "未処理に戻す" : "処理済みにする"}
                      >
                        {msg.processed && <span className="text-[10px]">✓</span>}
                      </button>
                      <span className="flex-1 whitespace-pre-wrap">{msg.text}</span>
                      <span className="shrink-0 text-[10px] text-zinc-400">
                        {msg.createdAt.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                        {" "}
                        {msg.createdAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 附番重複アラート */}
            {duplicateNumbers.length > 0 && (
              <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-4 py-2.5">
                <p className="text-sm font-medium text-red-800">社員番号の重複があります</p>
                {duplicateNumbers.map((d) => (
                  <p key={d.number} className="text-xs text-red-700 mt-0.5">
                    No.{d.number}: {d.names.join("、")}
                  </p>
                ))}
              </div>
            )}

            {/* AI指示 */}
            <div className="mb-3 rounded-lg border border-purple-200 bg-purple-50/50 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-medium text-purple-800">AIに指示</span>
                <span className="text-[10px] text-purple-400">例: 「山田さんの基本給を4月から25万にして」</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAiInstruction(); }}
                  placeholder="給与変更の指示を入力..."
                  className="flex-1 rounded-md border border-purple-200 bg-white px-3 py-1.5 text-sm text-zinc-800 placeholder-zinc-400 focus:border-purple-400 focus:outline-none"
                  disabled={aiLoading}
                />
                <button
                  onClick={handleAiInstruction}
                  disabled={aiLoading || !aiInstruction.trim()}
                  className="shrink-0 rounded-md bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {aiLoading ? "解析中..." : "実行"}
                </button>
              </div>

              {/* AI結果表示 */}
              {aiResult && (
                <div className="mt-3">
                  {aiResult.success ? (
                    <div className="rounded-md border border-green-200 bg-green-50 p-3">
                      <p className="text-sm font-medium text-green-800 mb-2">{aiResult.summary}</p>
                      <div className="space-y-1">
                        {aiResult.changes?.map((change, i) => {
                          const fieldNames: Record<string, string> = {
                            baseSalary: "基本給", commutingAllowance: "通勤手当",
                            allowance1: "手当1", allowance2: "手当2", allowance3: "手当3",
                            allowance4: "手当4", allowance5: "手当5", allowance6: "手当6",
                            deemedOvertimePay: "みなし残業手当", deductions: "控除",
                            residentTax: "住民税", unitPrice: "単価",
                            socialInsuranceGrade: "社保等級", overtimeHours: "残業時間", overtimePay: "残業代",
                            employeeMemo: "人メモ", memo: "月メモ",
                          };
                          const isAppend = change.mode === "append";
                          const isMemo = change.field === "employeeMemo" || change.field === "memo";
                          const targetEmp = employees.find((e) => e.name === aiResult.employeeName);

                          // 現在値取得
                          let currentVal: string | number | null = null;
                          if (change.field === "employeeMemo") {
                            const lm = [...months].reverse().find((m) => targetEmp?.months[m]);
                            currentVal = lm ? targetEmp?.months[lm]?.employeeMemo || "" : "";
                          } else if (change.months.length > 0) {
                            const vals = change.months.map((m) => {
                              const data = targetEmp?.months[m];
                              if (!data) return null;
                              return (data as unknown as Record<string, number | string>)[change.field];
                            });
                            currentVal = vals.find((v) => v != null) ?? null;
                          }

                          return (
                            <div key={i} className="text-xs text-green-700 flex items-start gap-2">
                              <span className="font-medium shrink-0">
                                {fieldNames[change.field] || change.field}
                                {isAppend ? "（追記）" : ""}:
                              </span>
                              {isMemo ? (
                                <span className="whitespace-pre-wrap">
                                  {currentVal ? `"${currentVal}" に追記 → ` : ""}
                                  &quot;{String(change.value)}&quot;
                                </span>
                              ) : (
                                <>
                                  {currentVal != null && (
                                    <span className="text-zinc-500">
                                      {typeof currentVal === "number" ? currentVal.toLocaleString() : currentVal}
                                    </span>
                                  )}
                                  {currentVal != null && <span className="text-zinc-400">&rarr;</span>}
                                  <span className="font-bold">
                                    {typeof change.value === "number" ? change.value.toLocaleString() : change.value}
                                  </span>
                                </>
                              )}
                              {change.months.length > 0 && (
                                <span className="text-[10px] text-zinc-500 shrink-0">
                                  ({change.months.length === 1 ? change.months[0] : `${change.months[0]}〜${change.months[change.months.length - 1]}`})
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={handleAiApply}
                          disabled={aiApplying}
                          className="rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {aiApplying ? "反映中..." : "反映する"}
                        </button>
                        <button
                          onClick={() => setAiResult(null)}
                          className="rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3">
                      <p className="text-sm text-red-700">{aiResult.error}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ソートボタン + 完了ボタン */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex gap-1">
                {([["employeeNumber", "社員番号"], ["name", "名前"], ["hireDate", "入社日"]] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSortKey(key)}
                    className={`px-2.5 py-1 text-xs rounded border ${sortKey === key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-zinc-600 border-zinc-300 hover:bg-zinc-50"}`}
                  >
                    {label}順
                  </button>
                ))}
              </div>
              <button
                onClick={handleComplete}
                disabled={completing}
                className="px-3 py-1.5 text-xs rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 font-medium"
              >
                {completing ? "生成中..." : `${formatMonthLabel(months[months.length - 1])} 完了 → 翌月生成`}
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="text-xs border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200">
                    <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2 text-left font-medium text-zinc-600 border-r border-zinc-200 min-w-[120px]">
                      社員
                    </th>
                    {months.map((m) => (
                      <th key={m} className="px-2 py-2 text-center font-medium text-zinc-600 border-r border-zinc-100 min-w-[170px]">
                        {formatMonthLabel(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeEmployees.map((emp) => (
                    <TableRow
                      key={emp.employeeNumber || emp.name}
                      emp={emp}
                      months={months}
                      swh={swh}
                      companyName={company?.name || ""}
                      onSave={saveField}
                      onSaveEmployeeMemo={saveEmployeeMemo}
                      onClickName={() => setDetailEmployee(emp)}
                    />
                  ))}
                  {retiredEmployees.length > 0 && (
                    <>
                      <tr className="bg-zinc-100">
                        <td colSpan={months.length + 1} className="px-3 py-1.5 text-xs font-medium text-zinc-500">
                          退職者（{retiredEmployees.length}名）
                        </td>
                      </tr>
                      {retiredEmployees.map((emp) => (
                        <TableRow
                          key={emp.employeeNumber || emp.name}
                          emp={emp}
                          months={months}
                          swh={swh}
                          companyName={company?.name || ""}
                          onSave={saveField}
                          onSaveEmployeeMemo={saveEmployeeMemo}
                          onClickName={() => setDetailEmployee(emp)}
                          retired
                        />
                      ))}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      {/* 詳細モーダル */}
      {detailEmployee && (
        <DetailModal
          emp={detailEmployee}
          months={months}
          swh={swh}
          onSave={saveField}
          onSaveEmployeeMemo={saveEmployeeMemo}
          onClose={() => setDetailEmployee(null)}
        />
      )}
    </div>
  );
}

// ========================================
// Editable Numeric Cell
// ========================================
function NumCell({
  docId,
  field,
  value,
  onSave,
}: {
  docId: string;
  field: string;
  value: number;
  onSave: (docId: string, field: string, value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const save = () => {
    const num = parseFloat(editVal) || 0;
    if (num !== value) onSave(docId, field, num);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        type="number"
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full rounded border border-blue-300 px-1 py-0 text-right text-xs tabular-nums"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditing(true); setEditVal(String(value)); }}
      className="w-full text-right text-blue-700 hover:bg-blue-50 rounded px-1 tabular-nums"
    >
      {fmt(value)}
    </button>
  );
}

// ========================================
// Unit Price Cell (手入力 or 自動計算)
// ========================================
function UnitPriceCell({
  docId,
  manualValue,
  calcValue,
  onSave,
}: {
  docId: string;
  manualValue: number;
  calcValue: number;
  onSave: (docId: string, field: string, value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const displayValue = manualValue || calcValue;
  const isManual = manualValue > 0;

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const save = () => {
    const num = parseFloat(editVal) || 0;
    if (num !== manualValue) onSave(docId, "unitPrice", num);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        type="number"
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={String(calcValue)}
        className="w-full rounded border border-blue-300 px-1 py-0 text-right text-xs tabular-nums"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditing(true); setEditVal(manualValue ? String(manualValue) : ""); }}
      className={`w-full text-right rounded px-1 tabular-nums font-medium ${isManual ? "text-blue-700 hover:bg-blue-100" : "text-blue-500 hover:bg-blue-50"}`}
      title={isManual ? `手入力: ${fmt(manualValue)}（0にすると自動計算 ${fmt(calcValue)} に戻る）` : `自動計算: ${fmt(calcValue)}`}
    >
      {fmt(displayValue)}
    </button>
  );
}

// ========================================
// Table Row
// ========================================
function TableRow({
  emp,
  months,
  swh,
  companyName,
  onSave,
  onSaveEmployeeMemo,
  onClickName,
  retired,
}: {
  emp: EmployeeRow;
  months: string[];
  swh: number;
  companyName: string;
  onSave: (docId: string, field: string, value: number | boolean | string) => void;
  onSaveEmployeeMemo: (emp: EmployeeRow, value: string) => void;
  onClickName: () => void;
  retired?: boolean;
}) {
  // employeeMemo は最新月の値を表示
  const latestMonth = [...months].reverse().find((m) => emp.months[m]);
  const currentEmployeeMemo = latestMonth ? emp.months[latestMonth].employeeMemo : "";

  return (
    <tr className={`border-b border-zinc-100 ${retired ? "opacity-50" : "hover:bg-zinc-50/50"}`}>
      <td className={`sticky left-0 z-10 px-3 py-2 border-r border-zinc-200 align-top ${retired ? "bg-zinc-50" : "bg-white"}`}>
        <button onClick={onClickName} className="font-medium text-blue-700 hover:underline text-left">
          {emp.name}
        </button>
        <div className="text-[10px] text-zinc-400 mt-0.5 leading-tight">
          {emp.employeeNumber && <span>{emp.employeeNumber} </span>}
          {shortBranch(emp.branchName, companyName)}/{shortType(emp.employmentType)}
        </div>
        {emp.hireDate && (
          <div className="text-[10px] text-zinc-400 leading-tight">入{formatHireDate(emp.hireDate)}</div>
        )}
        <EmployeeMemoCell
          initial={currentEmployeeMemo}
          onSave={(v) => onSaveEmployeeMemo(emp, v)}
        />
      </td>

      {months.map((m) => {
        const data = emp.months[m];
        if (!data) {
          return <td key={m} className="px-2 py-2 border-r border-zinc-100 align-top text-zinc-300">-</td>;
        }
        const up = calcUnitPrice(data, swh);
        const hasEvents = data.events.length > 0;

        return (
          <td key={m} className={`px-2 py-1.5 border-r border-zinc-100 align-top ${hasEvents ? "bg-amber-50" : ""}`}>
            <div className="space-y-0.5">
              <div className="flex justify-between gap-1">
                <span className="text-zinc-400 shrink-0">基</span>
                <NumCell docId={data.docId} field="baseSalary" value={data.baseSalary} onSave={onSave} />
              </div>
              <div className="flex justify-between gap-1">
                <button
                  onClick={() => onSave(data.docId, "commutingType", data.commutingType === "日額" ? "月額" : "日額")}
                  className={`shrink-0 text-[10px] rounded px-0.5 ${data.commutingType === "日額" ? "bg-orange-100 text-orange-600" : "text-zinc-400"}`}
                  title={`通勤: ${data.commutingType || "月額"}（クリックで切替）`}
                >
                  通{data.commutingType === "日額" ? "日" : ""}
                </button>
                <NumCell docId={data.docId} field="commutingAllowance" value={data.commutingAllowance} onSave={onSave} />
              </div>
              <div className="flex justify-between gap-1">
                <span className="text-zinc-400 shrink-0">手</span>
                <span className="text-right text-zinc-700 tabular-nums px-1">{fmt(totalAllowances(data))}</span>
              </div>
              {data.deemedOvertimePay > 0 && (
                <div className="flex justify-between gap-1">
                  <span className="text-zinc-400 shrink-0">み</span>
                  <span className="text-right text-zinc-700 tabular-nums px-1">{fmt(data.deemedOvertimePay)}</span>
                </div>
              )}
              <div className="flex justify-between gap-1">
                <span className="text-zinc-400 shrink-0">控</span>
                <NumCell docId={data.docId} field="deductions" value={data.deductions} onSave={onSave} />
              </div>
              <div className="flex justify-between gap-1">
                <span className={`shrink-0 text-blue-500 ${data.unitPrice ? "font-bold" : ""}`} title={data.unitPrice ? "手入力値" : "自動計算"}>単</span>
                <UnitPriceCell docId={data.docId} manualValue={data.unitPrice} calcValue={calcUnitPrice(data, swh)} onSave={onSave} />
              </div>
              <MemoCell docId={data.docId} initial={data.memo} onSave={(id, v) => onSave(id, "memo", v)} />
            </div>
            {hasEvents && (
              <div className="mt-1 text-[10px] text-amber-600 leading-tight">
                {data.events.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

// ========================================
// Memo Cell
// ========================================
function MemoCell({
  docId,
  initial,
  onSave,
}: {
  docId: string;
  initial: string;
  onSave: (docId: string, value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (v: string) => {
    setValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSave(docId, v), 800);
  };

  return (
    <textarea
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (value !== initial) onSave(docId, value);
      }}
      placeholder="メモ"
      rows={1}
      className="w-full mt-1 rounded border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-600 placeholder-zinc-300 resize-none focus:border-blue-300 focus:outline-none"
    />
  );
}

// ========================================
// Employee Memo Cell (人メモ, 全月共通)
// ========================================
function EmployeeMemoCell({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (v: string) => {
    setValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSave(v), 1200);
  };

  return (
    <textarea
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (value !== initial) onSave(value);
      }}
      placeholder="人メモ"
      rows={1}
      className="w-full mt-1 rounded border border-amber-200 bg-amber-50/50 px-1.5 py-0.5 text-[10px] text-amber-800 placeholder-amber-300 resize-none focus:border-amber-400 focus:outline-none"
    />
  );
}

// ========================================
// Detail Memo Cell (月メモ, モーダル用・大きめ)
// ========================================
function DetailMemoCell({
  docId,
  initial,
  onSave,
}: {
  docId: string;
  initial: string;
  onSave: (docId: string, value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (v: string) => {
    setValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSave(docId, v), 800);
  };

  return (
    <textarea
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (value !== initial) onSave(docId, value);
      }}
      placeholder="月メモ"
      rows={3}
      className="w-full rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-700 placeholder-zinc-300 resize-vertical focus:border-blue-300 focus:outline-none"
    />
  );
}

// ========================================
// Detail Modal (全月横並び台帳)
// ========================================
function DetailModal({
  emp,
  months,
  swh,
  onSave,
  onSaveEmployeeMemo,
  onClose,
}: {
  emp: EmployeeRow;
  months: string[];
  swh: number;
  onSave: (docId: string, field: string, value: number | boolean | string) => void;
  onSaveEmployeeMemo: (emp: EmployeeRow, value: string) => void;
  onClose: () => void;
}) {
  const yearMonths = getTwelveMonths(months);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-8 pb-8" onClick={onClose}>
      <div
        className="mx-4 max-h-full w-full max-w-6xl overflow-auto rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">{emp.name}</h2>
              <div className="text-xs text-zinc-500 mt-0.5">
                {emp.employeeNumber} / {emp.branchName} / {emp.employmentType}
                {emp.hireDate && ` / 入社${emp.hireDate}`}
              </div>
            </div>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-xl leading-none">×</button>
          </div>
          <div className="mt-2">
            <EmployeeMemoCell
              initial={(() => {
                const lm = [...months].reverse().find((m) => emp.months[m]);
                return lm ? emp.months[lm].employeeMemo : "";
              })()}
              onSave={(v) => onSaveEmployeeMemo(emp, v)}
            />
          </div>
        </div>

        {/* 台帳テーブル */}
        <div className="overflow-x-auto p-4">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2 text-left font-medium text-zinc-600 border-r border-zinc-200 min-w-[120px]">
                  項目
                </th>
                {yearMonths.map((m) => (
                  <th key={m} className={`px-3 py-2 text-center font-medium border-r border-zinc-100 min-w-[100px] ${emp.months[m] ? "text-zinc-600" : "text-zinc-300"}`}>
                    {formatMonthLabel(m)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* 基本給 */}
              <DetailRow label="基本給" months={yearMonths} emp={emp} field="baseSalary" onSave={onSave} />
              {/* 通勤手当 */}
              <tr className="border-b border-zinc-100">
                <td className="sticky left-0 z-10 bg-white px-3 py-2 text-zinc-500 border-r border-zinc-200 whitespace-nowrap">
                  通勤手当
                </td>
                {yearMonths.map((m) => {
                  const data = emp.months[m];
                  if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
                  return (
                    <td key={m} className="px-1 py-1 border-r border-zinc-100">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onSave(data.docId, "commutingType", data.commutingType === "日額" ? "月額" : "日額")}
                          className={`shrink-0 text-[10px] rounded px-1 py-0.5 border ${data.commutingType === "日額" ? "bg-orange-100 text-orange-600 border-orange-200" : "bg-zinc-50 text-zinc-400 border-zinc-200"}`}
                        >
                          {data.commutingType === "日額" ? "日" : "月"}
                        </button>
                        <NumCell docId={data.docId} field="commutingAllowance" value={data.commutingAllowance} onSave={onSave} />
                      </div>
                    </td>
                  );
                })}
              </tr>
              {/* 手当1 */}
              <DetailRowWithName
                defaultName="手当1"
                months={yearMonths}
                emp={emp}
                nameField="allowance1Name"
                valueField="allowance1"
                onSave={onSave}
              />
              {/* 手当2 */}
              <DetailRowWithName
                defaultName="手当2"
                months={yearMonths}
                emp={emp}
                nameField="allowance2Name"
                valueField="allowance2"
                onSave={onSave}
              />
              {/* 手当3 */}
              <DetailRowWithName
                defaultName="手当3"
                months={yearMonths}
                emp={emp}
                nameField="allowance3Name"
                valueField="allowance3"
                onSave={onSave}
              />
              {/* 手当4 */}
              <DetailRowWithName
                defaultName="手当4"
                months={yearMonths}
                emp={emp}
                nameField="allowance4Name"
                valueField="allowance4"
                onSave={onSave}
              />
              {/* 手当5 */}
              <DetailRowWithName
                defaultName="手当5"
                months={yearMonths}
                emp={emp}
                nameField="allowance5Name"
                valueField="allowance5"
                onSave={onSave}
              />
              {/* 手当6 */}
              <DetailRowWithName
                defaultName="手当6"
                months={yearMonths}
                emp={emp}
                nameField="allowance6Name"
                valueField="allowance6"
                onSave={onSave}
              />
              {/* みなし残業手当 */}
              <DetailRow label="みなし残業" months={yearMonths} emp={emp} field="deemedOvertimePay" onSave={onSave} />
              {/* 住民税 */}
              <DetailRow label="住民税" months={yearMonths} emp={emp} field="residentTax" onSave={onSave} />
              {/* 社保等級 */}
              <DetailRowText label="社保等級" months={yearMonths} emp={emp} field="socialInsuranceGrade" onSave={onSave} />
              {/* 単価 (編集可能、0なら自動計算) */}
              <tr className="border-b border-zinc-100 bg-blue-50/50">
                <td className="sticky left-0 z-10 bg-blue-50 px-3 py-2 font-medium text-blue-700 border-r border-zinc-200">
                  単価
                </td>
                {yearMonths.map((m) => {
                  const data = emp.months[m];
                  if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
                  return (
                    <td key={m} className="px-1 py-1 border-r border-zinc-100 bg-blue-50/50">
                      <UnitPriceCell docId={data.docId} manualValue={data.unitPrice} calcValue={calcUnitPrice(data, swh)} onSave={onSave} />
                    </td>
                  );
                })}
              </tr>
              {/* 確認 */}
              <tr className="border-b border-zinc-100">
                <td className="sticky left-0 z-10 bg-white px-3 py-2 text-zinc-500 border-r border-zinc-200">確認</td>
                {yearMonths.map((m) => {
                  const data = emp.months[m];
                  if (!data) return <td key={m} className="px-3 py-2 text-center border-r border-zinc-100">-</td>;
                  return (
                    <td key={m} className="px-3 py-2 text-center border-r border-zinc-100">
                      <input
                        type="checkbox"
                        checked={data.confirmed}
                        onChange={() => onSave(data.docId, "confirmed", !data.confirmed)}
                        className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-600"
                      />
                    </td>
                  );
                })}
              </tr>
              {/* メモ（大きめ） */}
              <tr>
                <td className="sticky left-0 z-10 bg-white px-3 py-2 text-zinc-500 border-r border-zinc-200 align-top">月メモ</td>
                {yearMonths.map((m) => {
                  const data = emp.months[m];
                  if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
                  return (
                    <td key={m} className="px-1 py-1 border-r border-zinc-100 align-top">
                      <DetailMemoCell docId={data.docId} initial={data.memo} onSave={(id, v) => onSave(id, "memo", v)} />
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// 数値行（基本給・通勤・住民税など）
function DetailRow({
  label,
  months,
  emp,
  field,
  onSave,
}: {
  label: string;
  months: string[];
  emp: EmployeeRow;
  field: string;
  onSave: (docId: string, field: string, value: number) => void;
}) {
  return (
    <tr className="border-b border-zinc-100">
      <td className="sticky left-0 z-10 bg-white px-3 py-2 text-zinc-500 border-r border-zinc-200 whitespace-nowrap">
        {label}
      </td>
      {months.map((m) => {
        const data = emp.months[m];
        if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
        return (
          <td key={m} className="px-1 py-1 border-r border-zinc-100">
            <NumCell
              docId={data.docId}
              field={field}
              value={(data as unknown as Record<string, number>)[field] || 0}
              onSave={onSave}
            />
          </td>
        );
      })}
    </tr>
  );
}

// テキスト行（社保等級）
function DetailRowText({
  label,
  months,
  emp,
  field,
  onSave,
}: {
  label: string;
  months: string[];
  emp: EmployeeRow;
  field: string;
  onSave: (docId: string, field: string, value: string) => void;
}) {
  return (
    <tr className="border-b border-zinc-100">
      <td className="sticky left-0 z-10 bg-white px-3 py-2 text-zinc-500 border-r border-zinc-200 whitespace-nowrap">
        {label}
      </td>
      {months.map((m) => {
        const data = emp.months[m];
        if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
        return (
          <td key={m} className="px-1 py-1 border-r border-zinc-100">
            <TextCell
              docId={data.docId}
              field={field}
              value={(data as unknown as Record<string, string>)[field] || ""}
              onSave={onSave}
            />
          </td>
        );
      })}
    </tr>
  );
}

// 手当行（名前変更可能 + 金額入力）
function DetailRowWithName({
  defaultName,
  months,
  emp,
  nameField,
  valueField,
  onSave,
}: {
  defaultName: string;
  months: string[];
  emp: EmployeeRow;
  nameField: string;
  valueField: string;
  onSave: (docId: string, field: string, value: number | string) => void;
}) {
  // 最新月の手当名を取得
  const latestMonth = [...months].reverse().find((m) => emp.months[m]);
  const currentName = latestMonth
    ? (emp.months[latestMonth] as unknown as Record<string, string>)[nameField] || defaultName
    : defaultName;

  const [labelEditing, setLabelEditing] = useState(false);
  const [labelVal, setLabelVal] = useState(currentName);
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (labelEditing && labelRef.current) {
      labelRef.current.focus();
      labelRef.current.select();
    }
  }, [labelEditing]);

  const saveLabel = () => {
    const trimmed = labelVal.trim() || defaultName;
    // 全月の手当名を更新
    for (const m of months) {
      const data = emp.months[m];
      if (data) onSave(data.docId, nameField, trimmed);
    }
    setLabelEditing(false);
  };

  return (
    <tr className="border-b border-zinc-100">
      <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-zinc-200">
        {labelEditing ? (
          <input
            ref={labelRef}
            value={labelVal}
            onChange={(e) => setLabelVal(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveLabel();
              if (e.key === "Escape") setLabelEditing(false);
            }}
            className="w-full rounded border border-blue-300 px-1 py-0 text-xs"
          />
        ) : (
          <button
            onClick={() => { setLabelEditing(true); setLabelVal(currentName); }}
            className="text-zinc-500 hover:text-blue-600 text-left"
            title="名前を変更"
          >
            {currentName}
          </button>
        )}
      </td>
      {months.map((m) => {
        const data = emp.months[m];
        if (!data) return <td key={m} className="px-3 py-2 text-center text-zinc-300 border-r border-zinc-100">-</td>;
        return (
          <td key={m} className="px-1 py-1 border-r border-zinc-100">
            <NumCell
              docId={data.docId}
              field={valueField}
              value={(data as unknown as Record<string, number>)[valueField] || 0}
              onSave={onSave}
            />
          </td>
        );
      })}
    </tr>
  );
}

// テキスト入力セル
function TextCell({
  docId,
  field,
  value,
  onSave,
}: {
  docId: string;
  field: string;
  value: string;
  onSave: (docId: string, field: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const save = () => {
    if (editVal !== value) onSave(docId, field, editVal);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full rounded border border-blue-300 px-1 py-0 text-xs"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditing(true); setEditVal(value); }}
      className="w-full text-right text-zinc-700 hover:bg-blue-50 rounded px-1"
    >
      {value || "-"}
    </button>
  );
}

// ========================================
// Page Wrapper
// ========================================
export default function CompanyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-zinc-500">読み込み中...</p>
        </div>
      }
    >
      <CompanyPageContent />
    </Suspense>
  );
}
