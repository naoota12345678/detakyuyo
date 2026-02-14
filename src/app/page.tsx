"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useCallback, Suspense } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";

type CompanyCard = {
  name: string;
  closingDay: number | null;
  payDay: number | null;
  employeeCount: number;
  confirmedCount: number;
};

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function HomeContent() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [month, setMonth] = useState(
    () => searchParams.get("month") || getCurrentMonth()
  );
  const [companies, setCompanies] = useState<CompanyCard[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenNames, setHiddenNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const loadData = useCallback(async () => {
    setLoadingData(true);
    setError(null);
    try {
      // 非表示リストを取得
      const hiddenDoc = await getDoc(doc(db, "appSettings", "hiddenCompanies"));
      const hidden = new Set<string>(
        hiddenDoc.exists() ? (hiddenDoc.data().names as string[]) || [] : []
      );
      setHiddenNames(hidden);

      // 会社名エイリアスを取得
      const aliasDoc = await getDoc(doc(db, "appSettings", "companyAliases"));
      const aliasMappings: Record<string, string> = aliasDoc.exists()
        ? aliasDoc.data().mappings || {}
        : {};

      // companySettings を shortName → メタデータ のマップにする
      const companiesSnapshot = await getDocs(
        collection(db, "companySettings")
      );
      const companyMeta = new Map<
        string,
        { closingDay: number | null; payDay: number | null }
      >();
      companiesSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const key = data.shortName || data.officialName;
        if (key) {
          companyMeta.set(key, {
            closingDay: data.closingDay ?? null,
            payDay: data.payDay ?? null,
          });
        }
      });

      // monthlyPayroll を branchName（ルックアップ）でグループ集計
      const payrollQuery = query(
        collection(db, "monthlyPayroll"),
        where("month", "==", month)
      );
      const payrollSnapshot = await getDocs(payrollQuery);

      const grouped = new Map<
        string,
        { total: number; confirmed: number }
      >();
      payrollSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const rawName = data.companyShortName || data.companyName || "";
        if (!rawName) return;
        // エイリアスがあれば置換してからグルーピング
        const key = aliasMappings[rawName] || rawName;
        if (!grouped.has(key)) {
          grouped.set(key, { total: 0, confirmed: 0 });
        }
        const c = grouped.get(key)!;
        c.total++;
        if (data.confirmed) c.confirmed++;
      });

      // エイリアス先名 → companySettings の逆引き用マップを構築
      // エイリアス先名でcompanyMetaにマッチするものを探す
      const aliasToMeta = new Map<
        string,
        { closingDay: number | null; payDay: number | null }
      >();
      for (const [originalName, displayName] of Object.entries(aliasMappings)) {
        const meta = companyMeta.get(originalName);
        if (meta && !aliasToMeta.has(displayName)) {
          aliasToMeta.set(displayName, meta);
        }
      }

      // companyName のユニーク値からカードを生成（非表示除外）
      const cards: CompanyCard[] = [];
      grouped.forEach((counts, name) => {
        if (hidden.has(name)) return;
        // まずエイリアス先名でcompanyMetaを直接引く、なければ逆引きマップから
        const meta = companyMeta.get(name) || aliasToMeta.get(name);
        cards.push({
          name,
          closingDay: meta?.closingDay ?? null,
          payDay: meta?.payDay ?? null,
          employeeCount: counts.total,
          confirmedCount: counts.confirmed,
        });
      });

      cards.sort(
        (a, b) =>
          b.employeeCount - a.employeeCount ||
          a.name.localeCompare(b.name)
      );

      setCompanies(cards);
    } catch (e) {
      console.error("Failed to load data:", e);
      setError(
        `データ取得エラー: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setLoadingData(false);
    }
  }, [month]);

  useEffect(() => {
    if (user) loadData();
  }, [user, loadData]);

  const changeMonth = (delta: number) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  };

  const handleHide = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (!confirm(`「${name}」を非表示にしますか？`)) return;
    try {
      const newHidden = new Set(hiddenNames);
      newHidden.add(name);
      await setDoc(doc(db, "appSettings", "hiddenCompanies"), {
        names: Array.from(newHidden),
      });
      setHiddenNames(newHidden);
      setCompanies((prev) => prev.filter((c) => c.name !== name));
    } catch (err) {
      alert(`非表示に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const formatMonth = (m: string) => {
    const [y, mo] = m.split("-");
    return `${y}年${parseInt(mo)}月`;
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-500">読み込み中...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-900">
            給与管理ダッシュボード
          </h1>
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/settings")}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              設定
            </button>
            <span className="text-sm text-zinc-500">{user.email}</span>
            <button
              onClick={logout}
              className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-50"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      <main className="p-6">
        {/* Month selector */}
        <div className="mb-6 flex items-center gap-3">
          <button
            onClick={() => changeMonth(-1)}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
          >
            &lt;
          </button>
          <span className="min-w-[120px] text-center text-base font-medium text-zinc-900">
            {formatMonth(month)}
          </span>
          <button
            onClick={() => changeMonth(1)}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
          >
            &gt;
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {loadingData ? (
          <p className="text-zinc-500">読み込み中...</p>
        ) : companies.length === 0 ? (
          <p className="text-zinc-500">
            データがありません。設定から同期を実行してください。
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {companies.map((company) => (
              <div
                key={company.name}
                onClick={() =>
                  router.push(
                    `/company/${encodeURIComponent(company.name)}?month=${month}`
                  )
                }
                className="relative cursor-pointer rounded-lg border border-zinc-200 bg-white p-4 text-left transition-all hover:border-zinc-300 hover:shadow-sm"
              >
                <button
                  onClick={(e) => handleHide(e, company.name)}
                  className="absolute top-2 right-2 rounded p-1 text-zinc-300 hover:bg-red-50 hover:text-red-500"
                  title="非表示"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <h2 className="truncate pr-6 font-medium text-zinc-900">
                  {company.name}
                </h2>
                <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
                  <span>
                    締日:{" "}
                    {company.closingDay ? `${company.closingDay}日` : "-"}
                  </span>
                  <span>
                    支払: {company.payDay ? `${company.payDay}日` : "-"}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm text-zinc-700">
                    {company.employeeCount}名
                  </span>
                  <span
                    className={`text-sm font-medium ${
                      company.confirmedCount === company.employeeCount
                        ? "text-green-600"
                        : "text-amber-600"
                    }`}
                  >
                    {company.confirmedCount}/{company.employeeCount}
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-zinc-100">
                  <div
                    className={`h-1.5 rounded-full ${
                      company.confirmedCount === company.employeeCount
                        ? "bg-green-500"
                        : "bg-amber-400"
                    }`}
                    style={{
                      width: `${(company.confirmedCount / company.employeeCount) * 100}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-zinc-500">読み込み中...</p>
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
