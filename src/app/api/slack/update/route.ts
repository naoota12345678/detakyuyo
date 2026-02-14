import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function POST(req: NextRequest) {
  try {
    const { docId, field, value } = await req.json();

    if (!docId || !field) {
      return NextResponse.json({ error: "docId と field は必須です" }, { status: 400 });
    }

    if (!["processed"].includes(field)) {
      return NextResponse.json({ error: `更新不可のフィールドです: ${field}` }, { status: 400 });
    }

    await adminDb.collection("slackMessages").doc(docId).update({ [field]: value });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
