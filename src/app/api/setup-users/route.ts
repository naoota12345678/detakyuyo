import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

// 初回のみ使用するユーザー作成API
// ユーザー作成後はこのファイルを削除してOK
export async function POST(request: Request) {
  try {
    const { email, password, displayName } = await request.json();

    const user = await adminAuth.createUser({
      email,
      password,
      displayName,
    });

    return NextResponse.json({ uid: user.uid, email: user.email });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "ユーザー作成に失敗しました";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
