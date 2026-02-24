import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function POST(request: NextRequest) {
  try {
    const { docId } = await request.json();

    if (!docId) {
      return NextResponse.json(
        { error: "docId は必須です" },
        { status: 400 }
      );
    }

    const docRef = adminDb.collection("monthlyPayroll").doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: "レコードが見つかりません" },
        { status: 404 }
      );
    }

    const data = doc.data()!;
    if (data.status !== "退社") {
      return NextResponse.json(
        { error: "退社済みの従業員のみ非表示にできます" },
        { status: 400 }
      );
    }

    await docRef.update({
      status: "退社（非表示）",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "非表示処理に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
