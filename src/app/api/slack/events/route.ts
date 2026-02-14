import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// チャンネルID → 会社名（表示名）のマッピングをFirestoreから取得（キャッシュ付き）
// dev環境ではキャッシュしない（本番では5分キャッシュ）
let channelMapCache: Record<string, string> = {};
let channelMapExpiry = 0;
const CACHE_TTL = process.env.NODE_ENV === "development" ? 0 : 5 * 60 * 1000;

async function getChannelMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < channelMapExpiry && Object.keys(channelMapCache).length > 0) {
    return channelMapCache;
  }

  // エイリアスマッピングを取得
  const aliasDoc = await adminDb.collection("appSettings").doc("companyAliases").get();
  const aliasMappings: Record<string, string> = aliasDoc.exists
    ? aliasDoc.data()?.mappings || {}
    : {};

  // 全companySettingsからエイリアス逆引きマップを構築
  // shortName → 表示名（エイリアスがあればそれ、なければshortName自体）
  const snapshot = await adminDb.collection("companySettings").get();
  const allDisplayNames = new Set<string>();
  snapshot.docs.forEach((doc) => {
    const sn = doc.data().shortName || "";
    const display = aliasMappings[sn] || sn;
    allDisplayNames.add(display);
  });

  const map: Record<string, string> = {};
  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    if (data.slackChannelId) {
      const rawName = data.shortName || data.officialName || "";
      // 1. エイリアスがあればそれを使う
      // 2. なければ、表示名一覧からshortNameの先頭一致で探す
      let displayName = aliasMappings[rawName] || "";
      if (!displayName) {
        for (const dn of allDisplayNames) {
          if (rawName.startsWith(dn) && dn !== rawName) {
            displayName = dn;
            break;
          }
        }
      }
      map[data.slackChannelId] = displayName || rawName;
    }
  });

  channelMapCache = map;
  channelMapExpiry = now + CACHE_TTL;
  return map;
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // URL Verification (Slack設定時の初回チャレンジ)
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // イベント受信
  if (body.type === "event_callback") {
    const event = body.event;

    // デバッグ: 全イベントをログ
    console.log(`[Slack Debug] type=${event.type} subtype=${event.subtype || "none"} bot=${event.bot_id || "none"} text=${(event.text || "").slice(0, 50)} attachments=${event.attachments?.length || 0} files=${event.files?.length || 0}`);

    // bot自身のメッセージは無視
    if (event.bot_id) {
      return NextResponse.json({ ok: true });
    }

    // チャンネルメッセージ（テキストまたは添付ファイル）
    if (event.type === "message" && (event.text || event.files || event.attachments)) {
      const channelId = event.channel;
      const channelMap = await getChannelMap();
      const companyName = channelMap[channelId];

      if (companyName) {
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

        // テキスト組み立て
        let text = event.text || "";

        // 転送メッセージ: attachmentsにテキストが入っている
        const attachments = event.attachments as { text?: string; fallback?: string; pretext?: string }[] | undefined;
        if (attachments && attachments.length > 0) {
          const attTexts = attachments
            .map((a) => a.text || a.fallback || a.pretext || "")
            .filter(Boolean);
          if (attTexts.length > 0) {
            const attText = attTexts.join("\n");
            text = text ? `${text}\n${attText}` : attText;
          }
        }

        // 添付ファイルがある場合はテキストに注記を追加
        const files = event.files as { name: string }[] | undefined;
        if (files && files.length > 0) {
          const fileNames = files.map((f) => f.name).join(", ");
          text = text ? `${text}\n[添付: ${fileNames}]` : `[添付: ${fileNames}]`;
        }

        // テキストが空なら保存しない
        if (!text) return NextResponse.json({ ok: true });

        await adminDb.collection("slackMessages").add({
          channelId,
          companyName,
          month,
          text,
          userId: event.user || "",
          timestamp: event.ts,
          threadTs: event.thread_ts || null,
          processed: false,
          createdAt: new Date(),
        });

        console.log(`[Slack] ${companyName}: ${text}`);
      } else {
        console.log(`[Slack] 未登録チャンネル ${channelId}: ${event.text}`);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
