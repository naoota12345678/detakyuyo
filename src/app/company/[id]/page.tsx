"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { db } from "@/lib/firebase";
import { collection, getDocs, doc, getDoc, query, where, orderBy, updateDoc } from "firebase/firestore";

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
  commutingUnitPrice: number;
  commutingType: string; // "月額" or "日額"
  department: string;
  employeeMemo: string;
  conversionDate: string;
  residentTax: number;
  socialInsuranceGrade: string;
  unitPrice: number;
  bonus: number;
  extraAllowance1: number;
  extraAllowance1Name: string;
  extraAllowance2: number;
  extraAllowance2Name: string;
  extraAllowance3: number;
  extraAllowance3Name: string;
  extraDeduction1: number;
  extraDeduction1Name: string;
  extraDeduction2: number;
  extraDeduction2Name: string;
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
  return Math.round((data.baseSalary + totalAllowances(data)) / swh * 100) / 100;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [completing, setCompleting] = useState(false);
  const [bonusMonth, setBonusMonth] = useState<string | null>(null);
  const [slackMessages, setSlackMessages] = useState<SlackMessage[]>([]);
  const [slackOpen, setSlackOpen] = useState(true);
  const [slackShowProcessed, setSlackShowProcessed] = useState(false);
  // AI指示
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiFiles, setAiFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [aiChatMessages, setAiChatMessages] = useState<{
    role: "user" | "assistant";
    content: string;
    changes?: { employeeName: string; field: string; value: number | string; months: string[]; mode?: "set" | "append" }[];
    _debug?: { fileContentsSent?: string[] };
    applying?: boolean;
  }[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // データチェック
  const [dcOpen, setDcOpen] = useState(false);
  const [dcFile, setDcFile] = useState<File | null>(null);
  const [dcMonth, setDcMonth] = useState("");
  const [dcLoading, setDcLoading] = useState(false);
  const [dcResult, setDcResult] = useState<{
    month: string;
    mapping: Record<string, number | string | null>;
    results: {
      name: string;
      employeeNumber: string;
      checks: {
        field: string;
        fieldLabel: string;
        excelValue: number | string | null;
        appValue: number | string | null;
        prevMonthValue: number | string | null;
        status: "ok" | "mismatch" | "changed" | "warning" | "no_data";
        message: string;
      }[];
    }[];
    missing: string[];
    newInExcel: string[];
  } | null>(null);
  const [dcError, setDcError] = useState("");
  // Excelマッピング設定
  const [companySettingsDocId, setCompanySettingsDocId] = useState<string | null>(null);
  const [excelMapping, setExcelMapping] = useState<Record<string, string>>({});
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingSaving, setMappingSaving] = useState(false);
  // 会社レベル手当名
  const [allowanceNames, setAllowanceNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  // チャットの自動スクロール
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [aiChatMessages, aiLoading]);

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
      let foundDocId: string | null = null;
      let foundExcelMapping: Record<string, string> = {};
      // 完全一致 or shortNameがcompanyNameで始まるエントリも対象にする
      companiesSnapshot.docs.forEach((d) => {
        const data = d.data();
        const sn = data.shortName || "";
        const on = data.officialName || "";
        const isMatch = matchingNames.has(sn) || matchingNames.has(on)
          || sn.startsWith(companyName) || on.startsWith(companyName);
        if (isMatch) {
          foundDocId = d.id;
          if (data.closingDay != null) closingDay = data.closingDay;
          if (data.payDay != null) payDay = data.payDay;
          if (data.standardWorkingHours && data.standardWorkingHours !== 160) {
            standardWorkingHours = data.standardWorkingHours;
          }
          if (data.excelMapping) {
            foundExcelMapping = data.excelMapping;
          }
          if (data.allowanceNames) {
            setAllowanceNames(data.allowanceNames);
          }
        }
      });
      setCompany({ name: companyName, closingDay, payDay, standardWorkingHours });
      setCompanySettingsDocId(foundDocId);
      setExcelMapping(foundExcelMapping);

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
          commutingUnitPrice: data.commutingUnitPrice || 0,
          commutingType: data.commutingType || "月額",
          department: data.department || "",
          employeeMemo: data.employeeMemo || "",
          conversionDate: data.conversionDate || "",
          residentTax: data.residentTax || 0,
          socialInsuranceGrade: data.socialInsuranceGrade || "",
          unitPrice: data.unitPrice || 0,
          bonus: data.bonus || 0,
          extraAllowance1: data.extraAllowance1 || 0,
          extraAllowance1Name: data.extraAllowance1Name || "計算外手当1",
          extraAllowance2: data.extraAllowance2 || 0,
          extraAllowance2Name: data.extraAllowance2Name || "計算外手当2",
          extraAllowance3: data.extraAllowance3 || 0,
          extraAllowance3Name: data.extraAllowance3Name || "計算外手当3",
          extraDeduction1: data.extraDeduction1 || 0,
          extraDeduction1Name: data.extraDeduction1Name || "控除1",
          extraDeduction2: data.extraDeduction2 || 0,
          extraDeduction2Name: data.extraDeduction2Name || "控除2",
        };
      });

      const sortedMonths = Array.from(monthSet).sort();
      setMonths(sortedMonths);
      if (sortedMonths.length > 0 && !dcMonth) {
        setDcMonth(sortedMonths[sortedMonths.length - 1]);
      }
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
  const saveField = async (docId: string, field: string, value: number | boolean | string | string[]) => {
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

  // conversionDate は全月に反映
  const saveConversionDate = async (emp: EmployeeRow, value: string) => {
    try {
      const docIds = Object.values(emp.months).map((m) => m.docId);
      await Promise.all(
        docIds.map((docId) =>
          fetch("/api/payroll/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docId, field: "conversionDate", value }),
          })
        )
      );
      setEmployees((prev) =>
        prev.map((e) => {
          if (e.employeeNumber !== emp.employeeNumber && e.name !== emp.name) return e;
          const newMonths = { ...e.months };
          for (const m of Object.keys(newMonths)) {
            newMonths[m] = { ...newMonths[m], conversionDate: value };
          }
          return { ...e, months: newMonths };
        })
      );
      if (detailEmployee && detailEmployee.name === emp.name) {
        setDetailEmployee((prev) => {
          if (!prev) return prev;
          const newMonths = { ...prev.months };
          for (const m of Object.keys(newMonths)) {
            newMonths[m] = { ...newMonths[m], conversionDate: value };
          }
          return { ...prev, months: newMonths };
        });
      }
    } catch (e) {
      console.error("Save conversionDate failed:", e);
    }
  };

  // フィールドを保存（fromMonth指定時はその月以降のみ、省略時は全月）
  const saveEmployeeField = async (emp: EmployeeRow, field: string, value: string, fromMonth?: string) => {
    try {
      const targetEntries = Object.entries(emp.months).filter(
        ([m]) => !fromMonth || m >= fromMonth
      );
      await Promise.all(
        targetEntries.map(([, data]) =>
          fetch("/api/payroll/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ docId: data.docId, field, value }),
          })
        )
      );
      const updateMonths = (monthsObj: Record<string, MonthlyData>) => {
        const newMonths = { ...monthsObj };
        for (const m of Object.keys(newMonths)) {
          if (!fromMonth || m >= fromMonth) {
            newMonths[m] = { ...newMonths[m], [field]: value };
          }
        }
        return newMonths;
      };
      setEmployees((prev) =>
        prev.map((e) => {
          if (e.employeeNumber !== emp.employeeNumber && e.name !== emp.name) return e;
          return { ...e, months: updateMonths(e.months) };
        })
      );
      if (detailEmployee && detailEmployee.name === emp.name) {
        setDetailEmployee((prev) => {
          if (!prev) return prev;
          return { ...prev, months: updateMonths(prev.months) };
        });
      }
    } catch (e) {
      console.error(`Save ${field} failed:`, e);
    }
  };

  // 手当名を会社レベルで保存
  const saveAllowanceName = async (nameField: string, value: string) => {
    const updated = { ...allowanceNames, [nameField]: value };
    setAllowanceNames(updated);
    if (!companySettingsDocId) return;
    try {
      await updateDoc(doc(db, "companySettings", companySettingsDocId), {
        allowanceNames: updated,
      });
    } catch (e) {
      console.error("Save allowanceName failed:", e);
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

  // 従業員データを構築（parse-instruction用）
  const buildEmployeePayload = () => {
    const activeEmps = employees.filter((e) => e.status !== "退社");
    const latestMonth = months.length > 0 ? months[months.length - 1] : "";
    return activeEmps.map((e) => {
      const data = latestMonth ? e.months[latestMonth] : undefined;
      return {
        name: e.name,
        employeeNumber: e.employeeNumber,
        status: e.status,
        employmentType: e.employmentType,
        branchName: e.branchName,
        ...(data ? {
          baseSalary: data.baseSalary || 0,
          commutingAllowance: data.commutingAllowance || 0,
          commutingUnitPrice: data.commutingUnitPrice || 0,
          deemedOvertimePay: data.deemedOvertimePay || 0,
          residentTax: data.residentTax || 0,
          unitPrice: data.unitPrice || 0,
          bonus: data.bonus || 0,
          socialInsuranceGrade: data.socialInsuranceGrade || "",
          allowance1: data.allowance1 || 0, allowance1Name: data.allowance1Name || "",
          allowance2: data.allowance2 || 0, allowance2Name: data.allowance2Name || "",
          allowance3: data.allowance3 || 0, allowance3Name: data.allowance3Name || "",
          allowance4: data.allowance4 || 0, allowance4Name: data.allowance4Name || "",
          allowance5: data.allowance5 || 0, allowance5Name: data.allowance5Name || "",
          allowance6: data.allowance6 || 0, allowance6Name: data.allowance6Name || "",
          extraAllowance1: data.extraAllowance1 || 0, extraAllowance1Name: data.extraAllowance1Name || "",
          extraAllowance2: data.extraAllowance2 || 0, extraAllowance2Name: data.extraAllowance2Name || "",
          extraAllowance3: data.extraAllowance3 || 0, extraAllowance3Name: data.extraAllowance3Name || "",
          extraDeduction1: data.extraDeduction1 || 0, extraDeduction1Name: data.extraDeduction1Name || "",
          extraDeduction2: data.extraDeduction2 || 0, extraDeduction2Name: data.extraDeduction2Name || "",
          deductions: data.deductions || 0,
          overtimeHours: data.overtimeHours || 0,
          overtimePay: data.overtimePay || 0,
          memo: data.memo || "",
          employeeMemo: data.employeeMemo || "",
        } : {}),
      };
    });
  };

  // AI指示を送信
  const handleAiInstruction = async () => {
    if (!aiInstruction.trim() || aiLoading) return;

    // ファイル添付あり or チャット継続中 → チャットモード（analyze-files）
    if (aiFiles.length > 0 || aiChatMessages.length > 0) {
      return handleAiChat();
    }

    // ファイルなしの初回 → parse-instruction（結果はチャットUIに表示）
    const userMsg = aiInstruction.trim();
    setAiInstruction("");
    setAiChatMessages([{ role: "user", content: userMsg }]);
    setAiLoading(true);

    try {
      const latestMonth = months.length > 0 ? months[months.length - 1] : "";
      const res = await fetch("/api/ai/parse-instruction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: userMsg,
          employees: buildEmployeePayload(),
          months,
          companyName: company?.name || "",
          month: latestMonth,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setAiChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.error || "エラーが発生しました" },
        ]);
      } else if (result.answer) {
        // 質問応答
        setAiChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.answer },
        ]);
      } else if (result.success && result.changes) {
        // 変更提案 → employeeNameが各changeに含まれていない場合はresult.employeeNameを埋め込み
        const changes = result.changes.map((c: { employeeName?: string; field: string; value: number | string; months: string[]; mode?: "set" | "append" }) => ({
          ...c,
          employeeName: c.employeeName || result.employeeName,
        }));
        setAiChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.summary || "変更提案", changes },
        ]);
      } else if (result.error) {
        setAiChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.error },
        ]);
      }
    } catch (e) {
      console.error("AI instruction failed:", e);
      setAiChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "AI処理に失敗しました" },
      ]);
    } finally {
      setAiLoading(false);
    }
  };

  // AIチャット（ファイル分析 + 会話継続）
  const handleAiChat = async () => {
    if (!aiInstruction.trim() || aiLoading) return;
    const userMsg = aiInstruction.trim();
    setAiInstruction("");

    // ユーザーメッセージを即座に追加
    setAiChatMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setAiLoading(true);

    try {
      const latestMonth = months.length > 0 ? months[months.length - 1] : "";
      const formData = new FormData();
      formData.append("instruction", userMsg);
      formData.append("companyName", company?.name || "");
      formData.append("month", latestMonth);

      // チャット履歴を送信（今までの全メッセージ）
      if (aiChatMessages.length > 0) {
        const history = aiChatMessages.map((m) => ({ role: m.role, content: m.content }));
        formData.append("chatHistory", JSON.stringify(history));
      }

      // ファイルを送信
      for (const f of aiFiles) {
        formData.append("files", f);
      }

      const res = await fetch("/api/ai/analyze-files", {
        method: "POST",
        body: formData,
      });
      const result = await res.json();
      if (!res.ok) {
        setAiChatMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.error || "エラーが発生しました" },
        ]);
      } else {
        setAiChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: result.analysis,
            changes: result.changes,
            _debug: result._debug,
          },
        ]);
      }
    } catch (e) {
      console.error("AI chat failed:", e);
      setAiChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "AI処理に失敗しました" },
      ]);
    } finally {
      setAiLoading(false);
    }
  };

  // AIチャットの変更提案を反映（同値スキップ + appendモード対応）
  const handleAiChatApply = async (msgIndex: number) => {
    const msg = aiChatMessages[msgIndex];
    if (!msg?.changes || msg.changes.length === 0) return;
    setAiChatMessages((prev) => prev.map((m, i) => i === msgIndex ? { ...m, applying: true } : m));
    try {
      for (const change of msg.changes) {
        const targetEmp = employees.find((e) => e.name === change.employeeName);
        if (!targetEmp) continue;
        const isAppend = change.mode === "append";

        if (change.field === "employeeMemo") {
          const lm = [...months].reverse().find((m) => targetEmp.months[m]);
          const currentMemo = lm ? targetEmp.months[lm].employeeMemo || "" : "";
          const newValue = isAppend && currentMemo
            ? currentMemo + "\n" + String(change.value)
            : String(change.value);
          await saveEmployeeMemo(targetEmp, newValue);
        } else if (change.months.length === 0) {
          for (const m of Object.keys(targetEmp.months)) {
            const data = targetEmp.months[m];
            if (!data) continue;
            const currentVal = (data as unknown as Record<string, number | string>)[change.field];
            if (!isAppend) {
              if (typeof change.value === "number" && change.value === currentVal) continue;
              if (typeof change.value !== "number" && String(change.value) === String(currentVal ?? "")) continue;
            }
            const finalValue = isAppend && change.field === "memo"
              ? (data.memo ? data.memo + "\n" + String(change.value) : String(change.value))
              : change.value;
            await saveField(data.docId, change.field, finalValue);
          }
        } else {
          for (const month of change.months) {
            const data = targetEmp.months[month];
            if (!data) continue;
            const currentVal = (data as unknown as Record<string, number | string>)[change.field];
            if (!isAppend) {
              if (typeof change.value === "number" && change.value === currentVal) continue;
              if (typeof change.value !== "number" && String(change.value) === String(currentVal ?? "")) continue;
            }
            const finalValue = isAppend && change.field === "memo"
              ? (data.memo ? data.memo + "\n" + String(change.value) : String(change.value))
              : change.value;
            await saveField(data.docId, change.field, finalValue);
          }
        }
      }
      setAiChatMessages((prev) => prev.map((m, i) => i === msgIndex ? { ...m, changes: undefined, applying: false } : m));
    } catch (e) {
      console.error("AI chat apply failed:", e);
      alert("反映に失敗しました");
      setAiChatMessages((prev) => prev.map((m, i) => i === msgIndex ? { ...m, applying: false } : m));
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

  // データチェック実行
  const handleDataCheck = async () => {
    if (!dcFile || !dcMonth || !company) return;
    setDcLoading(true);
    setDcError("");
    setDcResult(null);
    try {
      const formData = new FormData();
      formData.append("file", dcFile);
      formData.append("companyName", company.name);
      formData.append("month", dcMonth);
      if (Object.keys(excelMapping).length > 0) {
        formData.append("excelMapping", JSON.stringify(excelMapping));
      }
      if (Object.keys(allowanceNames).length > 0) {
        formData.append("allowanceNames", JSON.stringify(allowanceNames));
      }
      const res = await fetch("/api/data-check/analyze", {
        method: "POST",
        body: formData,
      });
      const result = await res.json();
      if (!res.ok) {
        setDcError(result.error || "チェックに失敗しました");
      } else {
        setDcResult(result);
      }
    } catch (e) {
      console.error("Data check failed:", e);
      setDcError("データチェックに失敗しました");
    } finally {
      setDcLoading(false);
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
  const searchFilter = (e: EmployeeRow) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return e.name.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q);
  };
  const activeEmployees = employees.filter((e) => e.status !== "退社").filter(searchFilter).sort(sortFn);
  const retiredEmployees = employees.filter((e) => e.status === "退社").filter(searchFilter).sort(sortFn);
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
            {slackMessages.length > 0 && (() => {
              const unprocessed = slackMessages.filter((m) => !m.processed);
              const processed = slackMessages.filter((m) => m.processed);
              return (
                <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
                  <button
                    onClick={() => setSlackOpen(!slackOpen)}
                    className="flex items-center justify-between w-full text-left"
                  >
                    <h3 className="text-sm font-medium text-blue-800">
                      Slack連絡事項
                      {unprocessed.length > 0 && (
                        <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5">
                          {unprocessed.length}
                        </span>
                      )}
                    </h3>
                    <span className="text-blue-400 text-xs">{slackOpen ? "▲ 閉じる" : "▼ 開く"}</span>
                  </button>
                  {slackOpen && (
                    <div className="mt-2">
                      {/* 未処理 */}
                      {unprocessed.length > 0 && (
                        <div className="max-h-48 overflow-y-auto space-y-1.5">
                          {unprocessed.map((msg) => (
                            <div
                              key={msg.docId}
                              className="flex items-start gap-2 rounded px-2.5 py-1.5 text-xs bg-white text-zinc-800 border border-blue-100"
                            >
                              <button
                                onClick={() => toggleSlackProcessed(msg.docId, msg.processed)}
                                className="mt-0.5 shrink-0 h-4 w-4 rounded border border-zinc-300 hover:border-blue-400 flex items-center justify-center"
                                title="処理済みにする"
                              />
                              <span className="flex-1 whitespace-pre-wrap">{msg.text}</span>
                              <span className="shrink-0 text-[10px] text-zinc-400">
                                {msg.createdAt.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                                {" "}
                                {msg.createdAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {unprocessed.length === 0 && (
                        <p className="text-xs text-blue-400 py-1">未処理のメッセージはありません</p>
                      )}
                      {/* 処理済み */}
                      {processed.length > 0 && (
                        <div className="mt-2">
                          <button
                            onClick={() => setSlackShowProcessed(!slackShowProcessed)}
                            className="text-[10px] text-blue-400 hover:text-blue-600 mb-1"
                          >
                            処理済み（{processed.length}件）{slackShowProcessed ? " ▲" : " ▼"}
                          </button>
                          {slackShowProcessed && (
                            <div className="max-h-32 overflow-y-auto space-y-1">
                              {processed.map((msg) => (
                                <div
                                  key={msg.docId}
                                  className="flex items-start gap-2 rounded px-2.5 py-1 text-xs bg-blue-100/50 text-blue-400"
                                >
                                  <button
                                    onClick={() => toggleSlackProcessed(msg.docId, msg.processed)}
                                    className="mt-0.5 shrink-0 h-4 w-4 rounded border bg-blue-500 border-blue-500 text-white flex items-center justify-center"
                                    title="未処理に戻す"
                                  >
                                    <span className="text-[10px]">✓</span>
                                  </button>
                                  <span className="flex-1 whitespace-pre-wrap line-through">{msg.text}</span>
                                  <span className="shrink-0 text-[10px] text-blue-300">
                                    {msg.createdAt.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

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
                  placeholder={aiChatMessages.length > 0 ? "返信..." : aiFiles.length > 0 ? "資料について指示...（例: この2つを比較して）" : "給与変更の指示を入力..."}
                  className="flex-1 rounded-md border border-purple-200 bg-white px-3 py-1.5 text-sm text-zinc-800 placeholder-zinc-400 focus:border-purple-400 focus:outline-none"
                  disabled={aiLoading}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg,.gif,.webp,.txt"
                  onChange={(e) => {
                    const selected = Array.from(e.target.files || []);
                    if (selected.length > 0) {
                      setAiFiles((prev) => [...prev, ...selected]);
                    }
                    e.target.value = "";
                  }}
                  className="hidden"
                  disabled={aiLoading}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`shrink-0 rounded-md border px-3 py-1.5 text-sm inline-flex items-center gap-1 ${aiFiles.length > 0 ? "border-purple-500 bg-purple-100 text-purple-800 font-medium" : "border-purple-200 bg-white text-purple-600 hover:bg-purple-50"}`}
                  disabled={aiLoading}
                >
                  &#128206; {aiFiles.length > 0 ? `${aiFiles.length}件添付中` : "資料を添付"}
                </button>
                <button
                  onClick={handleAiInstruction}
                  disabled={aiLoading || !aiInstruction.trim()}
                  className="shrink-0 rounded-md bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {aiLoading ? "分析中..." : aiChatMessages.length > 0 ? "送信" : "実行"}
                </button>
              </div>
              {/* 添付ファイル一覧 */}
              {aiFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {aiFiles.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded bg-purple-100 px-2 py-0.5 text-[11px] text-purple-700">
                      {f.name}
                      <button
                        onClick={() => setAiFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="text-purple-400 hover:text-purple-700 font-bold"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    onClick={() => setAiFiles([])}
                    className="text-[11px] text-purple-400 hover:text-purple-600"
                  >
                    全削除
                  </button>
                </div>
              )}

              {/* AIチャット */}
              {aiChatMessages.length > 0 && (
                <div className="mt-3 rounded-md border border-purple-200 bg-white p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-purple-700">AIチャット</span>
                    <button
                      onClick={() => { setAiChatMessages([]); setAiFiles([]); }}
                      className="text-xs text-zinc-400 hover:text-zinc-600"
                    >
                      閉じる
                    </button>
                  </div>
                  <div className="max-h-[500px] overflow-y-auto space-y-3 pr-1">
                    {aiChatMessages.map((msg, idx) => (
                      <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[85%] rounded-lg px-3 py-2 ${msg.role === "user" ? "bg-purple-100 text-purple-900" : "bg-zinc-100 text-zinc-800"}`}>
                          <div className="text-sm whitespace-pre-wrap leading-relaxed">
                            {msg.content}
                          </div>
                          {/* デバッグ: AIに送信されたファイル内容 */}
                          {msg._debug?.fileContentsSent && msg._debug.fileContentsSent.length > 0 && (
                            <details className="mt-2 text-xs text-zinc-400">
                              <summary className="cursor-pointer hover:text-zinc-600">AIに送信されたファイル内容を確認</summary>
                              <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-50 p-2 text-zinc-500 whitespace-pre-wrap">
                                {msg._debug.fileContentsSent.join("\n\n")}
                              </pre>
                            </details>
                          )}
                          {/* 変更提案 */}
                          {(() => {
                            if (!msg.changes || msg.changes.length === 0) return null;
                            const filteredChanges = msg.changes.filter((change) => {
                              const targetEmp = employees.find((e) => e.name === change.employeeName);
                              if (!targetEmp || change.months.length === 0) return true;
                              const data = targetEmp.months[change.months[0]];
                              if (!data) return true;
                              const currentVal = (data as unknown as Record<string, number | string>)[change.field];
                              if (typeof change.value === "number" && typeof currentVal === "number") {
                                return change.value !== currentVal;
                              }
                              return String(change.value) !== String(currentVal ?? "");
                            });
                            if (filteredChanges.length === 0) return null;
                            const baseFieldNames: Record<string, string> = {
                              baseSalary: "基本給", commutingAllowance: "通勤手当",
                              deemedOvertimePay: "みなし残業手当", deductions: "控除",
                              residentTax: "住民税", unitPrice: "単価", commutingUnitPrice: "交通費単価",
                              socialInsuranceGrade: "社保等級", overtimeHours: "残業時間", overtimePay: "残業代",
                              bonus: "賞与", memo: "月メモ", employeeMemo: "人メモ",
                            };
                            const getAllowanceName = (field: string, emp: EmployeeRow | undefined) => {
                              if (!field.startsWith("allowance") || field.endsWith("Name")) return baseFieldNames[field] || field;
                              const num = field.replace("allowance", "");
                              const nameField = `allowance${num}Name` as keyof MonthlyData;
                              if (emp) {
                                const latestMonth = [...months].reverse().find((m) => emp.months[m]);
                                if (latestMonth) {
                                  const name = emp.months[latestMonth][nameField];
                                  if (name && typeof name === "string") return name;
                                }
                              }
                              return `手当${num}`;
                            };
                            return (
                              <div className="mt-2 rounded-md border border-green-200 bg-green-50 p-2">
                                <p className="text-xs font-medium text-green-800 mb-1">
                                  変更提案（{filteredChanges.length}件）
                                  {filteredChanges.length < msg.changes.length && (
                                    <span className="text-[10px] text-zinc-500 font-normal ml-1">
                                      ※同値{msg.changes.length - filteredChanges.length}件を除外
                                    </span>
                                  )}
                                </p>
                                <div className="space-y-0.5">
                                  {filteredChanges.map((change, i) => {
                                    const targetEmp = employees.find((e) => e.name === change.employeeName);
                                    const fieldLabel = getAllowanceName(change.field, targetEmp);
                                    let currentVal: string | number | null = null;
                                    if (change.months.length > 0) {
                                      const data = targetEmp?.months[change.months[0]];
                                      if (data) {
                                        currentVal = (data as unknown as Record<string, number | string>)[change.field] ?? null;
                                      }
                                    }
                                    return (
                                      <div key={i} className="text-[11px] text-green-700 flex items-start gap-1.5">
                                        <span className="font-medium shrink-0">{change.employeeName}</span>
                                        <span className="shrink-0">{fieldLabel}:</span>
                                        {currentVal != null && (
                                          <>
                                            <span className="text-zinc-500">
                                              {typeof currentVal === "number" ? currentVal.toLocaleString() : currentVal}
                                            </span>
                                            <span className="text-zinc-400">&rarr;</span>
                                          </>
                                        )}
                                        <span className="font-bold">
                                          {typeof change.value === "number" ? change.value.toLocaleString() : change.value}
                                        </span>
                                        {change.months.length > 0 && (
                                          <span className="text-[10px] text-zinc-500 shrink-0">
                                            ({change.months.length === 1 ? change.months[0] : `${change.months[0]}〜${change.months[change.months.length - 1]}`})
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="flex gap-2 mt-2">
                                  <button
                                    onClick={() => handleAiChatApply(idx)}
                                    disabled={msg.applying}
                                    className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                                  >
                                    {msg.applying ? "反映中..." : "反映する"}
                                  </button>
                                  <button
                                    onClick={() => setAiChatMessages((prev) => prev.map((m, i) => i === idx ? { ...m, changes: undefined } : m))}
                                    className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
                                  >
                                    破棄
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                    {aiLoading && (
                      <div className="flex justify-start">
                        <div className="bg-zinc-100 rounded-lg px-3 py-2 text-sm text-zinc-500">
                          考え中...
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </div>
              )}
            </div>

            {/* データチェック */}
            <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50/50">
              <button
                onClick={() => setDcOpen(!dcOpen)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-teal-800 hover:bg-teal-100/50 rounded-lg"
              >
                <span>データチェック</span>
                <span className="text-xs text-teal-500">{dcOpen ? "▲" : "▼"}</span>
              </button>
              {dcOpen && (
                <div className="px-4 pb-4">
                  <div className="flex items-end gap-3 mb-3">
                    <div className="flex-1">
                      <label className="block text-[11px] text-teal-600 mb-1">Excelファイル</label>
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={(e) => setDcFile(e.target.files?.[0] || null)}
                        className="w-full text-xs file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-teal-600 file:text-white file:cursor-pointer"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-teal-600 mb-1">対象月</label>
                      <select
                        value={dcMonth}
                        onChange={(e) => setDcMonth(e.target.value)}
                        className="rounded border border-teal-200 bg-white px-2 py-1.5 text-xs text-zinc-800"
                      >
                        <option value="">選択...</option>
                        {[...months].reverse().map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={handleDataCheck}
                      disabled={dcLoading || !dcFile || !dcMonth}
                      className="shrink-0 rounded-md bg-teal-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                    >
                      {dcLoading ? "チェック中..." : "チェック実行"}
                    </button>
                  </div>

                  {/* マッピング設定 */}
                  <div className="mb-3">
                    <button
                      onClick={() => setMappingOpen(!mappingOpen)}
                      className="text-xs text-teal-600 hover:text-teal-800 flex items-center gap-1"
                    >
                      <span>マッピング設定</span>
                      <span className="text-[10px]">{mappingOpen ? "▲" : "▼"}</span>
                      {Object.values(excelMapping).some((v) => v) && (
                        <span className="text-[10px] text-teal-500 ml-1">(設定済)</span>
                      )}
                    </button>
                    {mappingOpen && (
                      <div className="mt-2 rounded-md border border-teal-200 bg-white p-3">
                        <p className="text-[11px] text-zinc-500 mb-2">Excel列名を入力してAIマッピングの精度を向上させます</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                          {([
                            ["employeeNumber", "社員番号"],
                            ["department", "所属"],
                            ["baseSalary", "基本給"],
                            ["commutingAllowance", "通勤手当"],
                            ["commutingUnitPrice", "交通費単価"],
                            ["deemedOvertimePay", "みなし残業"],
                            ["residentTax", "住民税"],
                            ["unitPrice", "単価"],
                            ["socialInsuranceGrade", "社保等級"],
                            ["allowance1", allowanceNames["allowance1Name"] || "手当1"],
                            ["allowance2", allowanceNames["allowance2Name"] || "手当2"],
                            ["allowance3", allowanceNames["allowance3Name"] || "手当3"],
                            ["allowance4", allowanceNames["allowance4Name"] || "手当4"],
                            ["allowance5", allowanceNames["allowance5Name"] || "手当5"],
                            ["allowance6", allowanceNames["allowance6Name"] || "手当6"],
                            ["extraAllowance1", allowanceNames["extraAllowance1Name"] || "計算外手当1"],
                            ["extraAllowance2", allowanceNames["extraAllowance2Name"] || "計算外手当2"],
                            ["extraAllowance3", allowanceNames["extraAllowance3Name"] || "計算外手当3"],
                            ["extraDeduction1", allowanceNames["extraDeduction1Name"] || "控除1"],
                            ["extraDeduction2", allowanceNames["extraDeduction2Name"] || "控除2"],
                            ["bonus", "賞与"],
                          ] as const).map(([key, label]) => (
                            <div key={key} className="flex items-center gap-2">
                              <label className="text-[11px] text-zinc-600 w-16 shrink-0 text-right">{label}</label>
                              <input
                                type="text"
                                value={excelMapping[key] || ""}
                                onChange={(e) => setExcelMapping((prev) => ({ ...prev, [key]: e.target.value }))}
                                placeholder={label}
                                className="flex-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-800 placeholder-zinc-300 focus:border-teal-400 focus:outline-none"
                              />
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            onClick={async () => {
                              if (!companySettingsDocId) return;
                              setMappingSaving(true);
                              try {
                                await updateDoc(doc(db, "companySettings", companySettingsDocId), {
                                  excelMapping,
                                });
                              } catch (e) {
                                console.error("Save mapping failed:", e);
                                alert("保存に失敗しました");
                              } finally {
                                setMappingSaving(false);
                              }
                            }}
                            disabled={mappingSaving || !companySettingsDocId}
                            className="rounded-md bg-teal-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                          >
                            {mappingSaving ? "保存中..." : "保存"}
                          </button>
                          {!companySettingsDocId && (
                            <span className="text-[10px] text-red-500">会社設定が見つかりません</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {dcError && (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 mb-3">
                      <p className="text-sm text-red-700">{dcError}</p>
                    </div>
                  )}

                  {dcResult && (
                    <div>
                      {/* Summary */}
                      <div className="flex items-center gap-4 mb-3 text-xs text-teal-700">
                        <span>{dcResult.results.length}名チェック</span>
                        <span className="text-red-600">
                          不一致: {dcResult.results.reduce((c, r) => c + r.checks.filter((ck) => ck.status === "mismatch").length, 0)}件
                        </span>
                        <span className="text-amber-600">
                          変動: {dcResult.results.reduce((c, r) => c + r.checks.filter((ck) => ck.status === "changed").length, 0)}件
                        </span>
                        {dcResult.missing.length > 0 && (
                          <span className="text-orange-600">Excelに無い: {dcResult.missing.length}名</span>
                        )}
                        {dcResult.newInExcel.length > 0 && (
                          <span className="text-blue-600">アプリに無い: {dcResult.newInExcel.length}名</span>
                        )}
                        <button
                          onClick={async () => {
                            const rows: Record<string, string | number>[] = [];
                            for (const r of dcResult.results) {
                              for (const ck of r.checks) {
                                if (ck.status === "ok") continue;
                                rows.push({
                                  "社員番号": r.employeeNumber,
                                  "氏名": r.name,
                                  "項目": ck.fieldLabel,
                                  "ステータス": ck.status === "mismatch" ? "不一致" : ck.status === "changed" ? "変動" : ck.status === "warning" ? "警告" : ck.status,
                                  "Excel値": ck.excelValue ?? "",
                                  "アプリ値": ck.appValue ?? "",
                                  "前月値": ck.prevMonthValue ?? "",
                                  "メッセージ": ck.message,
                                });
                              }
                            }
                            for (const name of dcResult.missing) {
                              rows.push({ "社員番号": "", "氏名": name, "項目": "", "ステータス": "Excelに無い", "Excel値": "", "アプリ値": "", "前月値": "", "メッセージ": "アプリにのみ存在" });
                            }
                            for (const name of dcResult.newInExcel) {
                              rows.push({ "社員番号": "", "氏名": name, "項目": "", "ステータス": "アプリに無い", "Excel値": "", "アプリ値": "", "前月値": "", "メッセージ": "Excelにのみ存在" });
                            }
                            if (rows.length === 0) { alert("差分データがありません"); return; }
                            const XLSX_EXPORT = await import("xlsx");
                            const ws = XLSX_EXPORT.utils.json_to_sheet(rows);
                            // Auto column width
                            const colWidths = Object.keys(rows[0]).map((key) => {
                              const maxLen = Math.max(key.length, ...rows.map((r) => String(r[key] ?? "").length));
                              return { wch: Math.min(maxLen + 2, 30) };
                            });
                            ws["!cols"] = colWidths;
                            const wb = XLSX_EXPORT.utils.book_new();
                            XLSX_EXPORT.utils.book_append_sheet(wb, ws, "差分チェック");
                            XLSX_EXPORT.writeFile(wb, `データチェック_${company?.name || ""}_${dcResult.month}.xlsx`);
                          }}
                          className="ml-auto shrink-0 rounded border border-teal-300 bg-white px-2 py-0.5 text-[11px] text-teal-700 hover:bg-teal-50"
                        >
                          Excelに出力
                        </button>
                      </div>

                      {/* 所属一括反映ボタン */}
                      {dcResult.results.some((r) => r.checks.find((ck) => ck.field === "department" && ck.excelValue)) && (
                        <div className="mb-3">
                          <button
                            onClick={async () => {
                              if (!confirm("Excelの所属データをアプリに一括反映しますか？（現在の対象月以降に反映）")) return;
                              let count = 0;
                              for (const r of dcResult.results) {
                                const deptCheck = r.checks.find((ck) => ck.field === "department");
                                if (!deptCheck?.excelValue) continue;
                                const deptVal = String(deptCheck.excelValue).trim();
                                // 社員番号 or 名前でマッチ
                                const emp = employees.find((e) =>
                                  (r.employeeNumber && e.employeeNumber === r.employeeNumber) ||
                                  e.name.replace(/[\s　]+/g, "") === r.name.replace(/[\s　]+/g, "")
                                );
                                if (!emp) continue;
                                // dcMonth以降の月に反映
                                const targetMonths = Object.entries(emp.months).filter(([m]) => m >= dcMonth);
                                await Promise.all(
                                  targetMonths.map(([, data]) =>
                                    fetch("/api/payroll/update", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ docId: data.docId, field: "department", value: deptVal }),
                                    })
                                  )
                                );
                                count++;
                              }
                              alert(`${count}名の所属を反映しました`);
                              loadData();
                            }}
                            className="rounded-md border border-teal-300 bg-white px-3 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-50"
                          >
                            Excelの所属をアプリに一括反映（{dcMonth}~）
                          </button>
                        </div>
                      )}

                      {/* Results table */}
                      <div className="overflow-x-auto rounded border border-zinc-200 bg-white">
                        <table className="text-xs border-collapse w-full">
                          <thead>
                            <tr className="bg-zinc-50 border-b border-zinc-200">
                              <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2 text-left font-medium text-zinc-600 border-r border-zinc-200 min-w-[100px]">
                                氏名
                              </th>
                              {(() => {
                                // Collect all unique fields across results
                                const fieldSet = new Map<string, string>();
                                for (const r of dcResult.results) {
                                  for (const ck of r.checks) {
                                    if (!fieldSet.has(ck.field)) fieldSet.set(ck.field, ck.fieldLabel);
                                  }
                                }
                                return Array.from(fieldSet.entries()).map(([field, label]) => (
                                  <th key={field} className="px-2 py-2 text-center font-medium text-zinc-600 border-r border-zinc-100 min-w-[90px] whitespace-nowrap">
                                    {label}
                                  </th>
                                ));
                              })()}
                            </tr>
                          </thead>
                          <tbody>
                            {dcResult.results.map((r) => {
                              const fieldSet = new Map<string, string>();
                              for (const res of dcResult.results) {
                                for (const ck of res.checks) {
                                  if (!fieldSet.has(ck.field)) fieldSet.set(ck.field, ck.fieldLabel);
                                }
                              }
                              const allFields = Array.from(fieldSet.keys());
                              const checkMap = new Map(r.checks.map((ck) => [ck.field, ck]));
                              const hasIssue = r.checks.some((ck) => ck.status === "mismatch" || ck.status === "changed");

                              return (
                                <tr key={r.name} className={`border-b border-zinc-100 ${hasIssue ? "" : "opacity-60"}`}>
                                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-zinc-200 whitespace-nowrap">
                                    <div className="font-medium text-zinc-800">{r.name}</div>
                                    {r.employeeNumber && (
                                      <div className="text-[10px] text-zinc-400">{r.employeeNumber}</div>
                                    )}
                                  </td>
                                  {allFields.map((field) => {
                                    const ck = checkMap.get(field);
                                    if (!ck) {
                                      return (
                                        <td key={field} className="px-2 py-2 text-center text-zinc-300 border-r border-zinc-100">
                                          -
                                        </td>
                                      );
                                    }
                                    const bgColor =
                                      ck.status === "ok" ? "bg-green-50" :
                                      ck.status === "mismatch" ? "bg-red-50" :
                                      ck.status === "changed" ? "bg-amber-50" :
                                      ck.status === "no_data" ? "bg-zinc-50" : "";
                                    const textColor =
                                      ck.status === "ok" ? "text-green-700" :
                                      ck.status === "mismatch" ? "text-red-700" :
                                      ck.status === "changed" ? "text-amber-700" :
                                      "text-zinc-400";

                                    return (
                                      <td
                                        key={field}
                                        className={`px-2 py-1.5 border-r border-zinc-100 ${bgColor}`}
                                        title={ck.message}
                                      >
                                        <div className={`text-center ${textColor}`}>
                                          {ck.status === "ok" && (
                                            <span className="text-[10px]">
                                              {typeof ck.excelValue === "number" ? ck.excelValue.toLocaleString() : ck.excelValue}
                                            </span>
                                          )}
                                          {ck.status === "mismatch" && (
                                            <div>
                                              <div className="font-bold text-[11px]">
                                                E: {typeof ck.excelValue === "number" ? ck.excelValue.toLocaleString() : ck.excelValue}
                                              </div>
                                              <div className="text-[10px] text-red-500">
                                                A: {typeof ck.appValue === "number" ? ck.appValue.toLocaleString() : ck.appValue}
                                              </div>
                                            </div>
                                          )}
                                          {ck.status === "changed" && (
                                            <div>
                                              <div className="text-[11px]">
                                                {typeof ck.excelValue === "number" ? ck.excelValue.toLocaleString() : ck.excelValue}
                                              </div>
                                              <div className="text-[10px] text-amber-500">
                                                前月: {typeof ck.prevMonthValue === "number" ? ck.prevMonthValue.toLocaleString() : ck.prevMonthValue}
                                              </div>
                                            </div>
                                          )}
                                          {ck.status === "no_data" && (
                                            <span className="text-[10px]">-</span>
                                          )}
                                        </div>
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* People diff */}
                      {(dcResult.missing.length > 0 || dcResult.newInExcel.length > 0) && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          {dcResult.missing.length > 0 && (
                            <div className="rounded-md border border-orange-200 bg-orange-50 p-3">
                              <p className="text-xs font-medium text-orange-800 mb-1">
                                Excelに無い（アプリのみ）: {dcResult.missing.length}名
                              </p>
                              <div className="text-[11px] text-orange-700 space-y-0.5">
                                {dcResult.missing.map((n) => (
                                  <div key={n}>{n}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          {dcResult.newInExcel.length > 0 && (
                            <div className="rounded-md border border-blue-200 bg-blue-50 p-3">
                              <p className="text-xs font-medium text-blue-800 mb-1">
                                アプリに無い（Excelのみ）: {dcResult.newInExcel.length}名
                              </p>
                              <div className="text-[11px] text-blue-700 space-y-0.5">
                                {dcResult.newInExcel.map((n) => (
                                  <div key={n}>{n}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ソート・検索 + 完了ボタン */}
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
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
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="名前・番号で検索"
                    className="w-36 rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 placeholder-zinc-400 focus:border-blue-400 focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 text-xs"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {bonusMonth ? (
                  <div className="flex items-center gap-1.5 rounded-md border border-green-300 bg-green-50 px-2 py-1">
                    <span className="text-xs text-green-700 font-medium">賞与入力中: {bonusMonth}</span>
                    <button
                      onClick={() => setBonusMonth(null)}
                      className="text-xs text-green-600 hover:text-green-800 font-bold"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md border border-green-300 bg-white pl-3 pr-1 py-1">
                    <span className="text-xs font-medium text-green-700 whitespace-nowrap">賞与追加</span>
                    <input
                      type="month"
                      onChange={(e) => { if (e.target.value) setBonusMonth(e.target.value); }}
                      className="text-xs text-green-700 cursor-pointer bg-transparent focus:outline-none"
                      title="賞与を入力する月を選択"
                    />
                  </div>
                )}
                <button
                  onClick={handleComplete}
                  disabled={completing}
                  className="px-3 py-1.5 text-xs rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 font-medium"
                >
                  {completing ? "生成中..." : `${formatMonthLabel(months[months.length - 1])} 完了 → 翌月生成`}
                </button>
              </div>
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
                      onSaveConversionDate={saveConversionDate}
                      onSaveEmployeeField={saveEmployeeField}
                      onClickName={() => setDetailEmployee(emp)}
                      bonusMonth={bonusMonth}
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
                          onSaveConversionDate={saveConversionDate}
                          onSaveEmployeeField={saveEmployeeField}
                          onClickName={() => setDetailEmployee(emp)}
                          bonusMonth={bonusMonth}
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
          onSaveConversionDate={saveConversionDate}
          onClose={() => setDetailEmployee(null)}
          allowanceNames={allowanceNames}
          onSaveAllowanceName={saveAllowanceName}
          onSaveEmployeeField={saveEmployeeField}
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
  onSaveConversionDate,
  onSaveEmployeeField,
  onClickName,
  bonusMonth,
  retired,
}: {
  emp: EmployeeRow;
  months: string[];
  swh: number;
  companyName: string;
  onSave: (docId: string, field: string, value: number | boolean | string | string[]) => void;
  onSaveEmployeeMemo: (emp: EmployeeRow, value: string) => void;
  onSaveConversionDate: (emp: EmployeeRow, value: string) => void;
  onSaveEmployeeField: (emp: EmployeeRow, field: string, value: string) => void;
  onClickName: () => void;
  bonusMonth: string | null;
  retired?: boolean;
}) {
  // employeeMemo は最新月の値を表示
  const latestMonth = [...months].reverse().find((m) => emp.months[m]);
  const currentEmployeeMemo = latestMonth ? emp.months[latestMonth].employeeMemo : "";
  const currentConversionDate = latestMonth ? emp.months[latestMonth].conversionDate : "";

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
        <ConversionDateCell
          initial={currentConversionDate}
          onSave={(v) => onSaveConversionDate(emp, v)}
        />
        <EmploymentTypeCell
          initial={emp.employmentType}
          onSave={(v) => onSaveEmployeeField(emp, "employmentType", v)}
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
                  className={`shrink-0 text-xs rounded px-0.5 ${data.commutingType === "日額" ? "bg-orange-100 text-orange-600" : "text-zinc-400"}`}
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
              {(data.bonus > 0 || bonusMonth === m) && (
                <div className="flex justify-between gap-1">
                  <span className="text-green-600 shrink-0 font-medium">賞</span>
                  {bonusMonth === m ? (
                    <NumCell docId={data.docId} field="bonus" value={data.bonus} onSave={onSave} />
                  ) : (
                    <span className="text-right text-green-700 tabular-nums px-1 font-medium">{fmt(data.bonus)}</span>
                  )}
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
              <div className="flex justify-between gap-1">
                <span className="text-zinc-400 shrink-0" title="交通費単価">交</span>
                <NumCell docId={data.docId} field="commutingUnitPrice" value={data.commutingUnitPrice} onSave={onSave} />
              </div>
              <MemoCell docId={data.docId} initial={data.memo} onSave={(id, v) => onSave(id, "memo", v)} />
            </div>
            {hasEvents && (
              <div className="mt-1 text-[10px] text-amber-600 leading-tight flex items-start gap-0.5">
                <div className="flex-1">
                  {data.events.map((e, i) => <div key={i}>{e}</div>)}
                </div>
                <button
                  onClick={() => onSave(data.docId, "events", [])}
                  className="shrink-0 text-amber-400 hover:text-amber-600 leading-none"
                  title="イベントをクリア"
                >×</button>
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
// Conversion Date Cell (転換予定日, 全月共通)
// ========================================
function ConversionDateCell({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);

  const handleChange = (v: string) => {
    setValue(v);
    onSave(v);
  };

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[10px] text-violet-500 shrink-0">転換</span>
      <input
        type="date"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        className="flex-1 rounded border border-violet-200 bg-violet-50/50 px-1.5 py-0.5 text-[10px] text-violet-800 focus:border-violet-400 focus:outline-none"
      />
    </div>
  );
}

// ========================================
// Employment Type Selector (雇用形態セレクト)
// ========================================
const EMPLOYMENT_TYPES = ["正社員", "パート", "アルバイト", "契約社員", "役員", "嘱託"];

function EmploymentTypeCell({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);

  const handleChange = (v: string) => {
    setValue(v);
    onSave(v);
  };

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[10px] text-emerald-500 shrink-0">形態</span>
      <select
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        className="flex-1 rounded border border-emerald-200 bg-emerald-50/50 px-1.5 py-0.5 text-[10px] text-emerald-800 focus:border-emerald-400 focus:outline-none"
      >
        {EMPLOYMENT_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
        {value && !EMPLOYMENT_TYPES.includes(value) && (
          <option value={value}>{value}</option>
        )}
      </select>
    </div>
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
// Inline Edit Field (クリックで編集可能なテキスト)
// ========================================
function InlineEditField({
  value,
  placeholder,
  onSave,
}: {
  value: string;
  placeholder: string;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [editing]);

  const save = () => {
    const trimmed = editVal.trim();
    if (trimmed !== value) onSave(trimmed);
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
        placeholder={placeholder}
        className="rounded border border-blue-300 px-1.5 py-0.5 text-xs text-zinc-800 focus:outline-none"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditing(true); setEditVal(value); }}
      className="text-xs text-zinc-500 hover:text-blue-600 hover:underline"
      title={`${placeholder}を編集`}
    >
      {value || <span className="text-zinc-300">{placeholder}</span>}
    </button>
  );
}

// ========================================
// History Field (部門・雇用形態: 履歴付き編集)
// ========================================
function HistoryField({
  emp,
  months,
  field,
  placeholder,
  onSave,
}: {
  emp: EmployeeRow;
  months: string[];
  field: string;
  placeholder: string;
  onSave: (emp: EmployeeRow, field: string, value: string, fromMonth?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newVal, setNewVal] = useState("");
  const [fromMonth, setFromMonth] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [adding]);

  // 月ごとの値から履歴を構築（値が変わったポイントを検出）
  const sortedMonths = [...months].filter((m) => emp.months[m]).sort();
  const history: { value: string; from: string }[] = [];
  for (const m of sortedMonths) {
    const val = (emp.months[m] as unknown as Record<string, string>)[field] || "";
    if (history.length === 0 || history[history.length - 1].value !== val) {
      history.push({ value: val, from: m });
    }
  }

  const save = () => {
    const trimmed = newVal.trim();
    if (!trimmed || !fromMonth) return;
    onSave(emp, field, trimmed, fromMonth);
    setAdding(false);
    setNewVal("");
    setFromMonth("");
  };

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {history.map((h, i) => (
        <span key={i} className="text-xs text-zinc-500">
          {i > 0 && <span className="text-zinc-300 mr-1">→</span>}
          {h.value || <span className="text-zinc-300">{placeholder}</span>}
          {i > 0 && (
            <span className="text-[10px] text-zinc-400 ml-0.5">
              ({parseInt(h.from.split("-")[1])}月~)
            </span>
          )}
        </span>
      ))}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-zinc-300 text-xs">→</span>
          <input
            ref={inputRef}
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setAdding(false); setNewVal(""); }
            }}
            placeholder={placeholder}
            className="rounded border border-blue-300 px-1.5 py-0.5 text-xs text-zinc-800 w-28 focus:outline-none"
          />
          <select
            value={fromMonth}
            onChange={(e) => setFromMonth(e.target.value)}
            className="rounded border border-blue-300 px-1 py-0.5 text-[10px] text-zinc-600"
          >
            <option value="">いつから</option>
            {sortedMonths.map((m) => (
              <option key={m} value={m}>{parseInt(m.split("-")[1])}月</option>
            ))}
          </select>
          <button
            onClick={save}
            disabled={!newVal.trim() || !fromMonth}
            className="text-[10px] text-blue-600 hover:text-blue-800 font-medium disabled:opacity-30"
          >
            OK
          </button>
          <button
            onClick={() => { setAdding(false); setNewVal(""); }}
            className="text-[10px] text-zinc-400 hover:text-zinc-600"
          >
            ×
          </button>
        </span>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-[10px] text-blue-500 hover:text-blue-700 ml-0.5"
          title={`${placeholder}の変更を追加`}
        >
          +変更
        </button>
      )}
    </span>
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
  onSaveConversionDate,
  onClose,
  allowanceNames,
  onSaveAllowanceName,
  onSaveEmployeeField,
}: {
  emp: EmployeeRow;
  months: string[];
  swh: number;
  onSave: (docId: string, field: string, value: number | boolean | string) => void;
  onSaveEmployeeMemo: (emp: EmployeeRow, value: string) => void;
  onSaveConversionDate: (emp: EmployeeRow, value: string) => void;
  onClose: () => void;
  allowanceNames: Record<string, string>;
  onSaveAllowanceName: (nameField: string, value: string) => void;
  onSaveEmployeeField: (emp: EmployeeRow, field: string, value: string, fromMonth?: string) => void;
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
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <InlineEditField value={emp.employeeNumber} placeholder="社員番号" onSave={(v) => onSaveEmployeeField(emp, "employeeNumber", v)} />
                <span className="text-zinc-300">/</span>
                <HistoryField emp={emp} months={months} field="branchName" placeholder="部門" onSave={onSaveEmployeeField} />
                <span className="text-zinc-300">/</span>
                <HistoryField emp={emp} months={months} field="department" placeholder="所属" onSave={onSaveEmployeeField} />
                <span className="text-zinc-300">/</span>
                <HistoryField emp={emp} months={months} field="employmentType" placeholder="雇用形態" onSave={onSaveEmployeeField} />
                {emp.hireDate && <span className="text-xs text-zinc-400">/ 入社{emp.hireDate}</span>}
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
            <ConversionDateCell
              initial={(() => {
                const lm = [...months].reverse().find((m) => emp.months[m]);
                return lm ? emp.months[lm].conversionDate : "";
              })()}
              onSave={(v) => onSaveConversionDate(emp, v)}
            />
            <EmploymentTypeCell
              initial={emp.employmentType}
              onSave={(v) => onSaveEmployeeField(emp, "employmentType", v)}
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
              {/* 手当1-6 */}
              {([
                ["allowance1", "allowance1Name", "手当1"],
                ["allowance2", "allowance2Name", "手当2"],
                ["allowance3", "allowance3Name", "手当3"],
                ["allowance4", "allowance4Name", "手当4"],
                ["allowance5", "allowance5Name", "手当5"],
                ["allowance6", "allowance6Name", "手当6"],
              ] as const).map(([valueField, nameField, defaultName]) => (
                <DetailRowWithName
                  key={valueField}
                  defaultName={defaultName}
                  currentName={allowanceNames[nameField] || ""}
                  months={yearMonths}
                  emp={emp}
                  nameField={nameField}
                  valueField={valueField}
                  onSave={onSave}
                  onSaveLabel={onSaveAllowanceName}
                />
              ))}
              {/* 計算外手当 */}
              {([
                ["extraAllowance1", "extraAllowance1Name", "計算外手当1"],
                ["extraAllowance2", "extraAllowance2Name", "計算外手当2"],
                ["extraAllowance3", "extraAllowance3Name", "計算外手当3"],
              ] as const).map(([valueField, nameField, defaultName]) => (
                <DetailRowWithName
                  key={valueField}
                  defaultName={defaultName}
                  currentName={allowanceNames[nameField] || ""}
                  months={yearMonths}
                  emp={emp}
                  nameField={nameField}
                  valueField={valueField}
                  onSave={onSave}
                  onSaveLabel={onSaveAllowanceName}
                />
              ))}
              {/* 控除項目 */}
              {([
                ["extraDeduction1", "extraDeduction1Name", "控除1"],
                ["extraDeduction2", "extraDeduction2Name", "控除2"],
              ] as const).map(([valueField, nameField, defaultName]) => (
                <DetailRowWithName
                  key={valueField}
                  defaultName={defaultName}
                  currentName={allowanceNames[nameField] || ""}
                  months={yearMonths}
                  emp={emp}
                  nameField={nameField}
                  valueField={valueField}
                  onSave={onSave}
                  onSaveLabel={onSaveAllowanceName}
                />
              ))}
              {/* みなし残業手当 */}
              <DetailRow label="みなし残業" months={yearMonths} emp={emp} field="deemedOvertimePay" onSave={onSave} />
              {/* 住民税 */}
              <DetailRow label="住民税" months={yearMonths} emp={emp} field="residentTax" onSave={onSave} />
              {/* 賞与 */}
              <DetailRow label="賞与" months={yearMonths} emp={emp} field="bonus" onSave={onSave} />
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
              {/* 交通費単価 */}
              <DetailRow label="交通費単価" months={yearMonths} emp={emp} field="commutingUnitPrice" onSave={onSave} />
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

// 手当行（名前変更可能 + 金額入力）— 名前は会社レベルで管理
function DetailRowWithName({
  defaultName,
  currentName: companyName,
  months,
  emp,
  nameField,
  valueField,
  onSave,
  onSaveLabel,
}: {
  defaultName: string;
  currentName: string;
  months: string[];
  emp: EmployeeRow;
  nameField: string;
  valueField: string;
  onSave: (docId: string, field: string, value: number | string) => void;
  onSaveLabel: (nameField: string, value: string) => void;
}) {
  const currentName = companyName || defaultName;

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
    onSaveLabel(nameField, trimmed);
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
