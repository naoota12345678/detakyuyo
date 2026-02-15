import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const ALLOWED_FIELDS = [
  "baseSalary",
  "commutingAllowance",
  "overtimeHours",
  "overtimePay",
  "otherAllowances",
  "deductions",
  "totalPayment",
  "confirmed",
  "memo",
  "allowance1",
  "allowance1Name",
  "allowance2",
  "allowance2Name",
  "allowance3",
  "allowance3Name",
  "allowance4",
  "allowance4Name",
  "allowance5",
  "allowance5Name",
  "allowance6",
  "allowance6Name",
  "deemedOvertimePay",
  "employeeMemo",
  "residentTax",
  "socialInsuranceGrade",
  "unitPrice",
  "commutingType",
  "commutingUnitPrice",
  "bonus",
  "extraAllowance1",
  "extraAllowance1Name",
  "extraAllowance2",
  "extraAllowance2Name",
  "extraAllowance3",
  "extraAllowance3Name",
  "extraDeduction1",
  "extraDeduction1Name",
  "extraDeduction2",
  "extraDeduction2Name",
  "employmentType",
  "branchName",
  "department",
  "conversionDate",
  "events",
];

export async function POST(request: NextRequest) {
  try {
    const { docId, field, value } = await request.json();

    if (!docId || !field) {
      return NextResponse.json(
        { error: "docId と field は必須です" },
        { status: 400 }
      );
    }

    if (!ALLOWED_FIELDS.includes(field)) {
      return NextResponse.json(
        { error: `更新不可のフィールドです: ${field}` },
        { status: 400 }
      );
    }

    await adminDb.collection("monthlyPayroll").doc(docId).update({
      [field]: value,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "更新に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
