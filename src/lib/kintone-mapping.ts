import { KintoneRecord, getFieldValue } from "./kintone";

// ========================================
// 従業員名簿 (App 19) → monthlyPayroll マッピング
// ========================================

export type EmployeeData = {
  kintoneRecordId: string;
  employeeNumber: string;
  name: string;
  nameKana: string;
  companyName: string;
  companyShortName: string;
  branchName: string;
  employmentType: string;
  hireDate: string;
  leaveDate: string;
  status: string;
  position: string;
  baseSalary: number;
  commutingAllowance: number;
  socialInsurance: boolean;
  employmentInsurance: boolean;
  healthStandardMonthly: string;
  pensionStandardMonthly: string;
};

// kintone フィールドコード定義
const EMPLOYEE_FIELDS = {
  recordId: "レコード番号",
  employeeNumber: "従業員番号",
  name: "氏名",
  nameKana: "氏名よみがな",
  companyName: "文字列__1行_",
  companyShortName: "文字列__1行__77",
  branchName: "ルックアップ",
  employmentType: "ラジオボタン_2",
  hireDate: "入社日",
  leaveDate: "退社日",
  status: "在籍状況",
  position: "役職",
  baseSalary: "文字列__1行__1",
  commutingAllowance: "文字列__1行__75",
  socialInsurance: "チェックボックス_27",
  employmentInsurance: "チェックボックス_28",
  healthStandardMonthly: "文字列__1行__8",
  pensionStandardMonthly: "文字列__1行__9",
} as const;

export const EMPLOYEE_FIELD_CODES = Object.values(EMPLOYEE_FIELDS);

export function mapKintoneToEmployee(record: KintoneRecord): EmployeeData {
  const socialInsField = record[EMPLOYEE_FIELDS.socialInsurance];
  const empInsField = record[EMPLOYEE_FIELDS.employmentInsurance];

  // チェックボックスは配列で返る
  const socialInsValues = socialInsField?.value;
  const empInsValues = empInsField?.value;

  const hasSocialInsurance = Array.isArray(socialInsValues) && socialInsValues.length > 0;
  const hasEmploymentInsurance = Array.isArray(empInsValues) && empInsValues.length > 0;

  const baseSalaryStr = getFieldValue(record, EMPLOYEE_FIELDS.baseSalary);
  const commutingStr = getFieldValue(record, EMPLOYEE_FIELDS.commutingAllowance);

  const companyName = getFieldValue(record, EMPLOYEE_FIELDS.companyName);
  const rawShortName = getFieldValue(record, EMPLOYEE_FIELDS.companyShortName);
  const companyShortName = stripEntityType(rawShortName || companyName);

  return {
    kintoneRecordId: getFieldValue(record, EMPLOYEE_FIELDS.recordId),
    employeeNumber: getFieldValue(record, EMPLOYEE_FIELDS.employeeNumber),
    name: getFieldValue(record, EMPLOYEE_FIELDS.name),
    nameKana: getFieldValue(record, EMPLOYEE_FIELDS.nameKana),
    companyName,
    companyShortName,
    branchName: getFieldValue(record, EMPLOYEE_FIELDS.branchName),
    employmentType: getFieldValue(record, EMPLOYEE_FIELDS.employmentType),
    hireDate: getFieldValue(record, EMPLOYEE_FIELDS.hireDate),
    leaveDate: getFieldValue(record, EMPLOYEE_FIELDS.leaveDate),
    status: getFieldValue(record, EMPLOYEE_FIELDS.status),
    position: getFieldValue(record, EMPLOYEE_FIELDS.position),
    baseSalary: parseNumber(baseSalaryStr),
    commutingAllowance: parseNumber(commutingStr),
    socialInsurance: hasSocialInsurance,
    employmentInsurance: hasEmploymentInsurance,
    healthStandardMonthly: getFieldValue(record, EMPLOYEE_FIELDS.healthStandardMonthly),
    pensionStandardMonthly: getFieldValue(record, EMPLOYEE_FIELDS.pensionStandardMonthly),
  };
}

// ========================================
// クライアント一覧 (App 10) → companySettings マッピング
// ========================================

export type CompanyData = {
  officialName: string;
  shortName: string;
  nameKana: string;
  closingDay: string;
  payDay: string;
  standardWorkingHours: number;
  isPayrollClient: boolean;
  clientNumber: string;
  employeeCount: string;
};

const CLIENT_FIELDS = {
  officialName: "法人名",
  shortName: "文字列__1行_",
  nameKana: "文字列__1行__0",
  closingDay: "ドロップダウン_0",
  payDay: "ドロップダウン_1",
  standardWorkingHoursNum: "数値_0",
  standardWorkingHoursStr: "文字列__1行__40",
  payrollClient: "ドロップダウン_17",
  clientNumber: "文字列__1行__107",
  employeeCount: "文字列__1行__9",
} as const;

export const CLIENT_FIELD_CODES = Object.values(CLIENT_FIELDS);

export function mapKintoneToCompany(record: KintoneRecord): CompanyData {
  const workingHoursNum = getFieldValue(record, CLIENT_FIELDS.standardWorkingHoursNum);
  const workingHoursStr = getFieldValue(record, CLIENT_FIELDS.standardWorkingHoursStr);
  const payrollClientValue = getFieldValue(record, CLIENT_FIELDS.payrollClient);

  let standardWorkingHours = parseNumber(workingHoursNum);
  if (standardWorkingHours === 0) {
    standardWorkingHours = parseNumber(workingHoursStr);
  }

  return {
    officialName: getFieldValue(record, CLIENT_FIELDS.officialName),
    shortName: getFieldValue(record, CLIENT_FIELDS.shortName),
    nameKana: getFieldValue(record, CLIENT_FIELDS.nameKana),
    closingDay: getFieldValue(record, CLIENT_FIELDS.closingDay),
    payDay: getFieldValue(record, CLIENT_FIELDS.payDay),
    standardWorkingHours,
    isPayrollClient: payrollClientValue === "〇",
    clientNumber: getFieldValue(record, CLIENT_FIELDS.clientNumber),
    employeeCount: getFieldValue(record, CLIENT_FIELDS.employeeCount),
  };
}

// ========================================
// ユーティリティ
// ========================================

// 企業名から法人格を除去して親会社名を抽出
const ENTITY_TYPES = [
  "特定非営利活動法人",
  "医療法人社団",
  "医療法人",
  "社会福祉法人",
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
];

function stripEntityType(name: string): string {
  if (!name) return "";
  const trimmed = name.trim();

  for (const entity of ENTITY_TYPES) {
    const idx = trimmed.indexOf(entity);
    if (idx === -1) continue;

    if (idx === 0) {
      // 先頭: "株式会社　Aslan" → "Aslan"
      return trimmed.slice(entity.length).replace(/^[\s　]+/, "").trim();
    } else {
      // 途中・末尾: "ノースワン　株式会社　TNOC" → "ノースワン"
      return trimmed.slice(0, idx).replace(/[\s　]+$/, "").trim();
    }
  }

  // 法人格なし: そのまま返す
  return trimmed;
}

function parseNumber(value: string): number {
  if (!value) return 0;
  // カンマ・全角数字・円マーク等を除去
  const cleaned = value
    .replace(/[,，]/g, "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[円¥￥]/g, "")
    .trim();
  const num = Number(cleaned);
  return isNaN(num) ? 0 : num;
}

// 締日文字列をパースして日付(数値)に変換
export function parseClosingDay(value: string): number | null {
  if (!value) return null;
  const match = value.match(/(\d+)/);
  if (match) return parseInt(match[1], 10);
  if (value.includes("末")) return 31; // 末日
  return null;
}

// 支払日文字列をパースして日付(数値)に変換
export function parsePayDay(value: string): number | null {
  if (!value) return null;
  const match = value.match(/(\d+)/);
  if (match) return parseInt(match[1], 10);
  return null;
}
