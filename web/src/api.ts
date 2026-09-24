/** Management bearers stay in storage scoped to this exact browser origin. */
const sessionKey = "bridge-admin-session";
let session =
  sessionStorage.getItem(sessionKey) ?? localStorage.getItem(sessionKey) ?? "";
/** CSRF token stays in memory and is recovered after a page reload. */
let csrf = "";
/** Small typed adapter for the same-origin management API. */
export async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/admin/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(session ? { "x-admin-session": session } : {}),
      ...(data === undefined
        ? {}
        : { "content-type": "application/json", "x-csrf-token": csrf }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  if (result.session && (path === "login" || path === "local-login")) {
    session = result.session;
    const remembered =
      path === "login" &&
      data !== null &&
      typeof data === "object" &&
      "remember" in data &&
      data.remember === true;
    sessionStorage.removeItem(sessionKey);
    localStorage.removeItem(sessionKey);
    (remembered ? localStorage : sessionStorage).setItem(sessionKey, session);
  }
  if (result.csrf) csrf = result.csrf;
  if (path === "logout") {
    session = "";
    csrf = "";
    sessionStorage.removeItem(sessionKey);
    localStorage.removeItem(sessionKey);
  }
  return result;
}
/** Runtime state deliberately excludes upstream login credentials. */
export interface Overview {
  ready: boolean;
  active: number;
  authMode: string;
  authSource: string;
  settings: { model: string; timeoutMs: number; maxRequests: number };
  apiBase: string;
  retentionDays: number;
}
/** Display metadata never carries plaintext API keys. */
export interface Key {
  id: string;
  name: string;
  prefix: string;
  enabled: number;
  created: number;
  last_used: number | null;
}
/** Null counters represent unavailable measurements, not zero usage. */
export interface Summary {
  costUsd: number | null;
  priced: number;
  requests: number;
  successful: number | null;
  measured: number;
  input: number | null;
  output: number | null;
  cached: number | null;
  reasoning: number | null;
  total: number | null;
}
/** Bounded report returned by the accounting module. */
export interface Report {
  pricing: {
    source: string;
    checkedAt: string;
    custom: boolean;
    updatedAt: string | null;
  };
  summary: Summary;
  trend: (Summary & { day: string })[];
  byModel: (Summary & { model: string })[];
  rows: {
    id: string;
    key_id: string;
    model: string;
    started: number;
    duration: number;
    status: number;
    error: string | null;
    input: number | null;
    output: number | null;
    total: number | null;
    costUsd: number | null;
  }[];
}
/** Shared counter formatting keeps missing usage visible. */
export function number(value: number | null | undefined): string {
  return value == null ? "未知" : value.toLocaleString("zh-CN");
}
