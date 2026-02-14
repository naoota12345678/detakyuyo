"use client";

import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { db } from "@/lib/firebase";
import {
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  query,
  orderBy,
  where,
} from "firebase/firestore";

type SyncResult = {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
};

type CompanySetting = {
  id: string;
  officialName: string;
  shortName: string;
  closingDay: number | null;
  payDay: number | null;
  standardWorkingHours: number;
  clientNumber: string;
  lastSyncedAt: string;
  slackChannelId: string;
};

export default function SettingsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [syncing, setSyncing] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [companies, setCompanies] = useState<CompanySetting[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // 会社名マッピング関連
  const [aliasMap, setAliasMap] = useState<Record<string, string>>({});
  const [companyNames, setCompanyNames] = useState<{ name: string; count: number }[]>([]);
  const [aliasEdits, setAliasEdits] = useState<Record<string, string>>({});
  const [savingAliases, setSavingAliases] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  const loadCompanies = useCallback(async () => {
    try {
      const q = query(collection(db, "companySettings"), orderBy("shortName"));
      const snapshot = await getDocs(q);
      const items: CompanySetting[] = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as CompanySetting[];
      setCompanies(items);
    } catch {
      // コレクションが空の場合はエラーにならないが、念のため
      setCompanies([]);
    }
  }, []);

  const loadAliases = useCallback(async () => {
    try {
      // 既存のエイリアスマッピングを取得
      const aliasDoc = await getDoc(doc(db, "appSettings", "companyAliases"));
      const mappings: Record<string, string> = aliasDoc.exists()
        ? aliasDoc.data().mappings || {}
        : {};
      setAliasMap(mappings);

      // 当月の monthlyPayroll から companyShortName のユニーク値と件数を取得
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const q = query(
        collection(db, "monthlyPayroll"),
        where("month", "==", month)
      );
      const snapshot = await getDocs(q);
      const counts = new Map<string, number>();
      snapshot.docs.forEach((d) => {
        const name = d.data().companyShortName || d.data().companyName || "";
        if (!name) return;
        counts.set(name, (counts.get(name) || 0) + 1);
      });

      const sorted = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      setCompanyNames(sorted);

      // 編集用のステートを初期化
      const edits: Record<string, string> = {};
      sorted.forEach(({ name }) => {
        edits[name] = mappings[name] || "";
      });
      setAliasEdits(edits);
    } catch (e) {
      console.error("Failed to load aliases:", e);
    }
  }, []);

  const handleSaveAliases = async () => {
    setSavingAliases(true);
    try {
      const newMappings: Record<string, string> = {};
      for (const [originalName, displayName] of Object.entries(aliasEdits)) {
        const trimmed = displayName.trim();
        // 空でなく、元の名前と異なる場合のみマッピングに含める
        if (trimmed && trimmed !== originalName) {
          newMappings[originalName] = trimmed;
        }
      }
      await setDoc(doc(db, "appSettings", "companyAliases"), {
        mappings: newMappings,
      });
      setAliasMap(newMappings);
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSavingAliases(false);
    }
  };

  useEffect(() => {
    if (user) {
      loadCompanies();
      loadAliases();
    }
  }, [user, loadCompanies, loadAliases]);

  const handleSync = async (endpoint: string, label: string) => {
    setSyncing(label);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      setResult(data);
      if (endpoint.includes("sync-companies")) {
        await loadCompanies();
      }
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "通信エラー" });
    } finally {
      setSyncing(null);
    }
  };

  const [slackEditing, setSlackEditing] = useState<string | null>(null);
  const [slackValue, setSlackValue] = useState("");

  const handleSaveSlackChannel = async (companyId: string) => {
    try {
      await updateDoc(doc(db, "companySettings", companyId), {
        slackChannelId: slackValue.trim(),
      });
      setSlackEditing(null);
      await loadCompanies();
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    }
  };

  const handleSaveWorkingHours = async (companyId: string) => {
    const hours = parseFloat(editValue);
    if (isNaN(hours) || hours <= 0) return;
    try {
      await updateDoc(doc(db, "companySettings", companyId), {
        standardWorkingHours: hours,
      });
      setEditingId(null);
      await loadCompanies();
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
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

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/")}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              ← ダッシュボード
            </button>
            <h1 className="text-lg font-semibold text-zinc-900">設定・同期管理</h1>
          </div>
          <span className="text-sm text-zinc-500">{user.email}</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl p-6 space-y-8">
        {/* 同期操作 */}
        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-semibold text-zinc-900 mb-4">kintone 同期</h2>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => handleSync("/api/kintone/sync-companies", "会社マスタ同期")}
              disabled={syncing !== null}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncing === "会社マスタ同期" ? "同期中..." : "会社マスタ同期"}
            </button>
            <button
              onClick={() => handleSync("/api/kintone/sync-employees", "従業員同期")}
              disabled={syncing !== null}
              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncing === "従業員同期" ? "同期中..." : "従業員同期"}
            </button>
            <button
              onClick={() => handleSync("/api/monthly/generate", "月次レコード生成")}
              disabled={syncing !== null}
              className="rounded bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncing === "月次レコード生成" ? "生成中..." : "月次レコード生成"}
            </button>
          </div>
        </section>

        {/* 同期結果 */}
        {result && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <h2 className="text-base font-semibold text-zinc-900 mb-3">同期結果</h2>
            {result.error ? (
              <div className="rounded bg-red-50 border border-red-200 p-4 text-sm text-red-800">
                {result.error}
              </div>
            ) : (
              <pre className="rounded bg-zinc-50 border border-zinc-200 p-4 text-sm text-zinc-700 overflow-auto max-h-96 whitespace-pre-wrap">
                {JSON.stringify(result, null, 2)}
              </pre>
            )}
          </section>
        )}

        {/* 会社設定一覧 */}
        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-semibold text-zinc-900 mb-4">
            会社設定一覧
            {companies.length > 0 && (
              <span className="ml-2 text-sm font-normal text-zinc-500">
                ({companies.length}社)
              </span>
            )}
          </h2>

          {companies.length === 0 ? (
            <p className="text-sm text-zinc-500">
              データがありません。「会社マスタ同期」を実行してください。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left">
                    <th className="pb-2 pr-4 font-medium text-zinc-600">No.</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">企業名</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">締日</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">支払日</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">所定労働時間</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">SlackチャンネルID</th>
                    <th className="pb-2 font-medium text-zinc-600">最終同期</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((company) => (
                    <tr key={company.id} className="border-b border-zinc-100">
                      <td className="py-2 pr-4 text-zinc-500">{company.clientNumber}</td>
                      <td className="py-2 pr-4 text-zinc-900">
                        {company.shortName || company.officialName}
                      </td>
                      <td className="py-2 pr-4 text-zinc-700">
                        {company.closingDay ? `${company.closingDay}日` : "-"}
                      </td>
                      <td className="py-2 pr-4 text-zinc-700">
                        {company.payDay ? `${company.payDay}日` : "-"}
                      </td>
                      <td className="py-2 pr-4">
                        {editingId === company.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveWorkingHours(company.id)}
                              className="text-blue-600 hover:text-blue-800 text-xs"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-zinc-400 hover:text-zinc-600 text-xs"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingId(company.id);
                              setEditValue(String(company.standardWorkingHours || ""));
                            }}
                            className="text-zinc-700 hover:text-blue-600"
                          >
                            {company.standardWorkingHours
                              ? `${company.standardWorkingHours}h`
                              : "-"}
                          </button>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {slackEditing === company.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={slackValue}
                              onChange={(e) => setSlackValue(e.target.value)}
                              placeholder="C08PY6YH16U"
                              className="w-32 rounded border border-zinc-300 px-2 py-1 text-xs font-mono"
                              autoFocus
                            />
                            <button
                              onClick={() => handleSaveSlackChannel(company.id)}
                              className="text-blue-600 hover:text-blue-800 text-xs"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setSlackEditing(null)}
                              className="text-zinc-400 hover:text-zinc-600 text-xs"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setSlackEditing(company.id);
                              setSlackValue(company.slackChannelId || "");
                            }}
                            className={`text-xs font-mono ${company.slackChannelId ? "text-green-700 hover:text-green-900" : "text-zinc-400 hover:text-blue-600"}`}
                          >
                            {company.slackChannelId || "未設定"}
                          </button>
                        )}
                      </td>
                      <td className="py-2 text-zinc-400 text-xs">
                        {company.lastSyncedAt
                          ? new Date(company.lastSyncedAt).toLocaleString("ja-JP")
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 会社名マッピング */}
        <section className="rounded-lg border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-zinc-900">
              会社名マッピング
              {companyNames.length > 0 && (
                <span className="ml-2 text-sm font-normal text-zinc-500">
                  ({companyNames.length}社)
                </span>
              )}
            </h2>
            <button
              onClick={handleSaveAliases}
              disabled={savingAliases}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingAliases ? "保存中..." : "マッピングを保存"}
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            同じ「表示名」を設定すると、ダッシュボードで1つの会社カードに合算されます。
          </p>

          {companyNames.length === 0 ? (
            <p className="text-sm text-zinc-500">
              当月のデータがありません。従業員同期を実行してください。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left">
                    <th className="pb-2 pr-4 font-medium text-zinc-600">元の名前</th>
                    <th className="pb-2 pr-4 font-medium text-zinc-600">表示名</th>
                    <th className="pb-2 font-medium text-zinc-600 text-right">従業員数</th>
                  </tr>
                </thead>
                <tbody>
                  {companyNames.map(({ name, count }) => (
                    <tr key={name} className="border-b border-zinc-100">
                      <td className="py-2 pr-4 text-zinc-900 whitespace-nowrap">
                        {name}
                        {aliasMap[name] && (
                          <span className="ml-2 text-xs text-blue-600">→ {aliasMap[name]}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="text"
                          value={aliasEdits[name] ?? ""}
                          onChange={(e) =>
                            setAliasEdits((prev) => ({ ...prev, [name]: e.target.value }))
                          }
                          placeholder={name}
                          className="w-full rounded border border-zinc-300 px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="py-2 text-right text-zinc-500">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
