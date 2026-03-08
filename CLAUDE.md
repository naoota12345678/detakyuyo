# 給与管理ダッシュボード (payroll-app)

## 最重要ルール

### コード改変ルール
- **絶対にプログラムを勝手に改変しない。必ずユーザーの許可を得てから修正すること。**
- 問題を発見した場合: まず原因を説明 → 修正案を提示 → ユーザーの「はい」を待ってから実装
- 場当たり的な修正禁止。深く考えてから提案すること

### デプロイルール
- `git push` はユーザーが「プッシュして」と指示した時のみ実行
- Vercelへのデプロイ関連操作もユーザーの指示を待つ
- 破壊的なgit操作（force push, reset --hard等）は絶対禁止

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
- **branchName比較**: 完全一致 + `stripEntityType()`で法人格除去後の再比較（kintoneのルックアップ値に法人格付き/なしが混在するため）
- 退社日が過ぎた人は次回同期時に「退社」ステータスに変更
- **kintone在籍状況の値は「退職」**（アプリ内のstatusは「退社」「退社（非表示）」）
- **会社単位同期**: `companyShortName` パラメータで特定会社のみ同期可能（会社ページの「従業員更新」ボタン）
- 会社単位同期時: 退職検知は対象会社のみ、非受託先クリーンアップはスキップ（他社レコード保護）

### 手動編集保護 (manuallyEditedFields)
- `baseSalary`, `commutingAllowance`, `employmentType`, `branchName` をUIで手動編集すると `manuallyEditedFields.{field}` にタイムスタンプを記録
- sync-employees 実行時、`manuallyEditedFields` に記録されたフィールドはkintoneデータで上書きしない
- 月次コピー（generate/complete）時にはリセット（翌月はkintone同期を受け入れる）
- force-sync（デバッグ用）は manuallyEditedFields を無視して上書き可能

### 退職者ソフトデリート
- 退社判定: `isRetired()` ヘルパー関数（`src/lib/employee-utils.ts`）で `"退社"` と `"退社（非表示）"` を統一判定
- 退職者の「非表示にする」ボタン → `POST /api/payroll/hide-retired` → `status: "退社（非表示）"`
- Firestoreにデータは残り、UIの一覧からは非表示になる
- isRetired() 適用箇所: sync-employees, monthly/generate, monthly/complete, data-check/analyze, company/[id]/page.tsx

### 月次生成 (monthly/complete)
- 当月完了→翌月レコード生成
- **欠落補完機能**: 前月にいるが当月に欠けている社員を自動検知し、当月+翌月レコードを同時生成
- 既存レコードの上書きなし（安全に再実行可能）
- `buildMonthRecord()` ヘルパーでレコード構築を共通化

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
| `src/app/api/payroll/hide-retired/route.ts` | 退職者ソフトデリート |
| `src/lib/employee-utils.ts` | 共通ヘルパー（isRetired等） |
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
- FIELD_MAPは動的生成: 従業員データから実際の手当名（資格手当等）を取得してラベルに反映
- 質問応答モード: 従業員の在籍・退社状況などを回答
- **kintoneから退職者情報も取得してAIに渡す**（在籍状況="退職"でクエリ、branchNameでフィルタ）
- 従業員リストにステータスと退社日を表示（[退職]マーク付き）
- max_tokens: 8192（大量変更に対応）
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
`baseSalary`, `commutingAllowance`, `commutingUnitPrice`, `allowance1`〜`allowance6`, `extraAllowance1`〜`extraAllowance3`, `extraDeduction1`〜`extraDeduction2`, `deemedOvertimePay`, `deductions`, `residentTax`, `unitPrice`, `socialInsuranceGrade`, `overtimeHours`, `overtimePay`, `bonus`, `memo`, `employeeMemo`, `employmentType`, `branchName`, `department`, `conversionDate`

## 現在のステータス（2026-02-25）

### 直近の作業完了（2026-02-25）
- AIが退職者を認識: kintoneから退職者情報を取得してparse-instructionに渡す
- kintone在籍状況「退職」（「退社」ではない）に修正
- 法人格付きbranchNameの同期漏れ解消: stripEntityType()で正規化比較（sync-employees, parse-instruction）
- 月次生成の欠落社員自動補完: 前月→当月の欠落を検知し当月+翌月レコード同時生成
- 手動編集保護機能（manuallyEditedFields）: 同期時にアプリで修正したデータを上書きしない仕組み
- 退職者ソフトデリート: 「非表示にする」ボタンでUI非表示、データベースには保持
- isRetired()ヘルパー関数で退社判定を統一（5ファイル8箇所）
- 会社単位の従業員同期: 会社ページから「従業員更新」ボタンで個別同期
- GitHubにプッシュ済み（bd1d34d）

### 以前の作業完了（2026-02-15）
- 計算外手当（extraAllowance1-3）・控除項目（extraDeduction1-2）追加（全9ファイル）
- 雇用形態セレクター追加（正社員/パート/契約社員等）
- commutingUnitPrice翌月引き継ぎ修正
- parse-instruction AI修正: 複数従業員対応、FIELD_MAP動的化（実際の手当名反映）
- データチェックに計算外手当・控除項目追加
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
