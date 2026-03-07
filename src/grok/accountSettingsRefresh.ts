import type { GrokSettings } from "../settings";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TOS_PROTO = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x10, 0x01]);
const NSFW_PROTO = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x00,
  0x20,
  0x0a,
  0x02,
  0x10,
  0x01,
  0x12,
  0x1a,
  0x0a,
  0x18,
  ...Array.from(new TextEncoder().encode("always_show_nsfw_content")),
]);

export interface AccountSettingsApplyResult {
  ok: boolean;
  step: "parse" | "tos" | "birth" | "nsfw";
  error?: string;
}

function extractCookieValue(cookieString: string, name: string): string | null {
  const needle = `${name}=`;
  if (!cookieString.includes(needle)) return null;
  for (const rawPart of cookieString.split(";")) {
    const part = rawPart.trim();
    if (!part.startsWith(needle)) continue;
    const value = part.slice(needle.length).trim();
    return value || null;
  }
  return null;
}

export function parseSsoPair(rawToken: string): { sso: string; ssoRw: string } {
  const raw = String(rawToken || "").trim();
  if (!raw) return { sso: "", ssoRw: "" };

  if (raw.includes(";")) {
    const sso = extractCookieValue(raw, "sso") || "";
    const ssoRw = extractCookieValue(raw, "sso-rw") || sso;
    return { sso: sso.trim(), ssoRw: ssoRw.trim() };
  }

  const sso = raw.startsWith("sso=") ? raw.slice(4).trim() : raw;
  return { sso, ssoRw: sso };
}

export function normalizeRefreshToken(rawToken: string): string {
  return parseSsoPair(rawToken).sso;
}

function buildCookieHeader(args: { sso: string; ssoRw: string; cfClearance?: string }): string {
  const parts = [`sso=${args.sso}`, `sso-rw=${args.ssoRw}`];
  const clearance = String(args.cfClearance || "").trim();
  if (clearance) {
    const value = clearance.startsWith("cf_clearance=")
      ? clearance.slice("cf_clearance=".length)
      : clearance;
    if (value) parts.push(`cf_clearance=${value}`);
  }
  return parts.join(";");
}

function randomBirthDateIso(): string {
  const now = new Date();
  const age = 20 + Math.floor(Math.random() * 21); // [20, 40]
  const year = now.getUTCFullYear() - age;
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T16:00:00.000Z`;
}

async function postGrpc(args: {
  url: string;
  origin: string;
  referer: string;
  cookie: string;
  body: Uint8Array;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const bodyBuffer = new ArrayBuffer(args.body.byteLength);
  new Uint8Array(bodyBuffer).set(args.body);
  const resp = await fetch(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+proto",
      origin: args.origin,
      referer: args.referer,
      "x-grpc-web": "1",
      "user-agent": DEFAULT_USER_AGENT,
      cookie: args.cookie,
    },
    body: bodyBuffer,
  });

  const grpcStatus = String(resp.headers.get("grpc-status") || "").trim();
  if (resp.status !== 200) {
    const text = (await resp.text().catch(() => "")).slice(0, 200);
    const suffix = text ? ` ${text}` : "";
    return { ok: false, error: `HTTP ${resp.status}${suffix}`.trim() };
  }
  if (grpcStatus && grpcStatus !== "0") return { ok: false, error: `gRPC ${grpcStatus}` };
  return { ok: true };
}

async function setBirthDate(args: {
  cookie: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const resp = await fetch("https://grok.com/rest/auth/set-birth-date", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://grok.com",
      referer: "https://grok.com/",
      "user-agent": DEFAULT_USER_AGENT,
      cookie: args.cookie,
    },
    body: JSON.stringify({ birthDate: randomBirthDateIso() }),
  });

  if (resp.status === 200) return { ok: true };
  const text = (await resp.text().catch(() => "")).slice(0, 200);
  const suffix = text ? ` ${text}` : "";
  return { ok: false, error: `HTTP ${resp.status}${suffix}`.trim() };
}

export async function applyAccountSettingsForToken(args: {
  rawToken: string;
  settings: GrokSettings;
}): Promise<AccountSettingsApplyResult> {
  const { sso, ssoRw } = parseSsoPair(args.rawToken);
  if (!sso) return { ok: false, step: "parse", error: "missing sso" };

  const cfClearance = String(args.settings.cf_clearance || "").trim();
  const cookie = buildCookieHeader({ sso, ssoRw: ssoRw || sso, cfClearance });

  const tos = await postGrpc({
    url: "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion",
    origin: "https://accounts.x.ai",
    referer: "https://accounts.x.ai/accept-tos",
    cookie,
    body: TOS_PROTO,
  });
  if (!tos.ok) return { ok: false, step: "tos", error: tos.error };

  const birth = await setBirthDate({ cookie });
  if (!birth.ok) return { ok: false, step: "birth", error: birth.error };

  const nsfw = await postGrpc({
    url: "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls",
    origin: "https://grok.com",
    referer: "https://grok.com/?_s=data",
    cookie,
    body: NSFW_PROTO,
  });
  if (!nsfw.ok) return { ok: false, step: "nsfw", error: nsfw.error };

  return { ok: true, step: "nsfw" };
}

