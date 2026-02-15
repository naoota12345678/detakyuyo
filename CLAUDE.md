# 給与管理ダッシュボード (payroll-app)

## プロジェクト概要
社労士事務所向けの給与管理Webアプリ。kintoneの従業員・クライアントデータをFirestoreに同期し、月次給与台帳の管理、Excelデータとの突合チェック、Slack通知連携を行う。

## 技術スタック
- **Framework:** Next.js 16.1.6 (App Router, Turbopack)
- **UI:** React 19, Tailwind CSS 4, TypeScript
- **DB:** Firebase Firestore (named database: `detakyuyo` ← `(default)`ではない)
- **Auth:** Firebase Authentication
- **外部API:** kintone REST API, Anthropic Claude API, Slack API
- **Deploy:** Vercel (設定中)

## 開発コマンド
```bash
cd C:\Users\naoot\Desktop\claude\notion\payroll-app
npm run dev      # 開発サーバー起動（ポートは3000/3002/3003のいずれか）
npm run build    # 本番ビルド
npx tsc --noEmit # 型チェック
```

## GitHub
- **Repo:** `naoota12345678/detakyuyo` (private)
- **Branch:** master

## Firestoreコレクション
- `monthlyPayroll` — 従業員×月の給与レコード（メインデータ）
- `companySettings` — 会社ごとの設定（締日、所定労働時間、手当名、Excelマッピング等）
- `slackMessages` — Slackから取り込んだ連絡事項

## kintone連携
- **従業員名簿 App ID=19:** `KINTONE_EMPLOYEE_APP_ID` / `KINTONE_EMPLOYEE_API_TOKEN`
- **クライアント App ID=10:** `KINTONE_CLIENT_APP_ID` / `KINTONE_CLIENT_API_TOKEN`
- **Subdomain:** `KINTONE_SUBDOMAIN`
- フィールドコード定義: `src/lib/kintone-mapping.ts`
- REST APIはGETで取得（POSTは新規作成用）

## 重要な設計パターン

### Firestore named database
```ts
// Admin SDK
getFirestore("detakyuyo")
// Client SDK
getFirestore(app, "detakyuyo")
```

### 従業員同期 (sync-employees)
- kintoneから `在籍状況="在籍" OR 退社日>=今日` で取得
- `branchName` が companySettings の shortName に一致する従業員のみ同期
- 退社日が過ぎた人は次回同期時に「退社」ステータスに変更

### フィールド保存パターン
- 単一フィールド: `POST /api/payroll/update` → `{ docId, field, value }`
- 全月一括: `employeeMemo`, `conversionDate`, `department` 等は全月に反映
- 履歴対応: `branchName`, `department`, `employmentType` は `fromMonth` パラメータで指定月以降のみ更新

### データチェック (data-check/analyze)
- Excelファイル → Claude AIで構造解析 → アプリデータと突合
- 社員番号で優先マッチ、名前でフォールバック
- 会社ごとのExcelマッピング設定で精度向上
- `STRING_FIELDS`（所属、社保等級）は文字列比較、その他は数値比較

## 主要ファイル
| ファイル | 役割 |
|---------|------|
| `src/lib/firebase-admin.ts` | Firebase Admin初期化 |
| `src/lib/firebase.ts` | Firebase Client初期化 |
| `src/lib/kintone.ts` | kintone APIクライアント |
| `src/lib/kintone-mapping.ts` | kintoneフィールドマッピング |
| `src/app/page.tsx` | ダッシュボード（会社一覧） |
| `src/app/company/[id]/page.tsx` | 会社詳細（メインUI、最大のファイル） |
| `src/app/settings/page.tsx` | 設定・同期管理 |
| `src/app/api/kintone/sync-employees/route.ts` | 従業員同期 |
| `src/app/api/kintone/sync-companies/route.ts` | 会社同期 |
| `src/app/api/monthly/generate/route.ts` | 月次レコード一括生成 |
| `src/app/api/monthly/complete/route.ts` | 会社単位の翌月生成 |
| `src/app/api/payroll/update/route.ts` | フィールド更新 |
| `src/app/api/data-check/analyze/route.ts` | Excelデータチェック |
| `src/app/api/import/bulk/route.ts` | CSV一括インポート |
| `src/app/api/ai/parse-instruction/route.ts` | テキスト指示AI（構造化変更） |
| `src/app/api/ai/analyze-files/route.ts` | ファイル分析AI（Excel/PDF解析） |
| `src/app/api/debug/force-sync/route.ts` | 手動従業員同期 |

## 環境変数（全20個、.env.local / Vercel）
Firebase Admin: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
Firebase Client: `NEXT_PUBLIC_FIREBASE_*` (API_KEY, AUTH_DOMAIN, PROJECT_ID, STORAGE_BUCKET, MESSAGING_SENDER_ID, APP_ID)
kintone: `KINTONE_SUBDOMAIN`, `KINTONE_EMPLOYEE_APP_ID`, `KINTONE_EMPLOYEE_API_TOKEN`, `KINTONE_CLIENT_APP_ID`, `KINTONE_CLIENT_API_TOKEN`
AI: `ANTHROPIC_API_KEY`
Slack: `SLACK_BOT_TOKEN`, `SLACK_HIRE_CHANNEL_ID`, `SLACK_LEAVE_CHANNEL_ID`, `SLACK_WEBHOOK_URL`

## AI機能

### テキスト指示AI (`/api/ai/parse-instruction`)
- 自然言語で給与変更指示 → 構造化JSON → 「反映する」ボタンで適用
- 従業員名の部分一致、月範囲指定、金額変換に対応
- 質問応答モード: 従業員の在籍・退社状況などを回答
- モデル: `claude-sonnet-4-5-20250929`

### ファイル分析AI (`/api/ai/analyze-files`)
- Excel/PDF/画像をアップロード → AI分析 → ````changes````ブロックで構造化変更提案
- フォローアップ会話対応（`previousAnalysis`で多ターン）
- Excel読み取り: `sheet_to_json`でレコード形式 `{列名: 値}` に変換（`raw: true`で数値精度確保）
- max_tokens: 16384（大量変更に対応）
- 截断JSON自動修復（正規表現フォールバック）
- 同一値変更の自動フィルタリング、手当名の実名表示
- 従業員名簿（在籍状況・入退社日）をコンテキストに含む
- モデル: `claude-sonnet-4-5-20250929`

### 更新可能フィールド（ALLOWED_FIELDS）
`baseSalary`, `commutingAllowance`, `commutingUnitPrice`, `allowance1`〜`allowance6`, `deemedOvertimePay`, `deductions`, `residentTax`, `unitPrice`, `socialInsuranceGrade`, `overtimeHours`, `overtimePay`, `bonus`, `memo`, `employeeMemo`

## 現在のステータス（2026-02-15）

### 直近の作業完了（2026-02-15）
- AI分析結果からデータ反映機能（````changes````ブロック → 「反映する」ボタン）
- AI分析フォローアップ会話（多ターン対応）
- Excel読み取り精度向上（CSV→セル単位→マークダウン→レコード形式）
- AIへの従業員名簿提供（在籍・退社状況の質問対応）
- `commutingUnitPrice`（交通費単価）フィールド追加（API + UI）
- 従業員検索フィルター（名前・社員番号）
- データチェック結果のExcelエクスポート
- GitHubにプッシュ済み

### 以前の作業完了（2026-02-14）
- Excelマッピング設定UI、データチェック機能強化
- 退社予定者の同期ロジック改善
- Slack通知の折りたたみ・未処理/処理済み分離
- イベント（変更通知）クリア機能

### 未完了: Vercelデプロイ
- Vercelプロジェクト作成済み、初回デプロイでビルドエラー
- **エラー:** `Service account object must contain a string "pro..."`
- **原因推定:** `FIREBASE_PRIVATE_KEY` の改行処理 or 環境変数の未設定/誤設定
- **対処:** Vercelの環境変数画面で全20個が正しく設定されているか確認
- `firebase-admin.ts` では `replace(/\\n/g, "\n")` 実装済み
