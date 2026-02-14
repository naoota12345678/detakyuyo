// kintone REST API クライアント（fetch ベース）

type KintoneRecord = {
  [fieldCode: string]: {
    type: string;
    value: unknown;
  };
};

type KintoneResponse = {
  records: KintoneRecord[];
  totalCount?: string;
};

const RECORDS_PER_REQUEST = 500;
const REQUEST_INTERVAL_MS = 100; // 10リクエスト/秒制限を考慮

function getBaseUrl(): string {
  const subdomain = process.env.KINTONE_SUBDOMAIN;
  if (!subdomain) throw new Error("KINTONE_SUBDOMAIN is not set");
  return `https://${subdomain}.cybozu.com`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRecords(
  appId: string,
  token: string,
  query: string = "",
  fields?: string[]
): Promise<KintoneRecord[]> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams();
  params.set("app", appId);
  params.set("query", query ? `${query} limit ${RECORDS_PER_REQUEST}` : `limit ${RECORDS_PER_REQUEST}`);
  params.set("totalCount", "true");
  if (fields && fields.length > 0) {
    fields.forEach((f) => params.append("fields[0]", f));
  }

  const url = `${baseUrl}/k/v1/records.json?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Cybozu-API-Token": token,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`kintone API error (${res.status}): ${errorText}`);
  }

  const data: KintoneResponse = await res.json();
  return data.records;
}

export async function fetchAllRecords(
  appId: string,
  token: string,
  fields?: string[],
  query: string = ""
): Promise<KintoneRecord[]> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/k/v1/records.json`;
  const allRecords: KintoneRecord[] = [];
  let offset = 0;

  while (true) {
    const paginatedQuery = query
      ? `${query} order by $id asc limit ${RECORDS_PER_REQUEST} offset ${offset}`
      : `order by $id asc limit ${RECORDS_PER_REQUEST} offset ${offset}`;

    const params = new URLSearchParams();
    params.set("app", appId);
    params.set("query", paginatedQuery);
    params.set("totalCount", "true");

    const requestUrl = `${url}?${params.toString()}`;

    const res = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "X-Cybozu-API-Token": token,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`kintone API error (${res.status}): ${errorText}`);
    }

    const data: KintoneResponse = await res.json();
    allRecords.push(...data.records);

    if (data.records.length < RECORDS_PER_REQUEST) {
      break;
    }

    offset += RECORDS_PER_REQUEST;
    await sleep(REQUEST_INTERVAL_MS);
  }

  return allRecords;
}

// kintone レコードからフィールド値を取得するヘルパー
export function getFieldValue(record: KintoneRecord, fieldCode: string): string {
  const field = record[fieldCode];
  if (!field) return "";
  const val = field.value;
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}

export type { KintoneRecord };
