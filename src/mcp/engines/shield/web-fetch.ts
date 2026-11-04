import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";
import { sanitizeUntrustedContent } from "./sanitize.ts";

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
];

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap (§1.3.4)
const MAX_REDIRECTS = 3;

/**
 * Checks whether an IPv4 or IPv6 address falls in any loopback, private, link-local,
 * CGNAT, cloud metadata, multicast, or unspecified range (§1.3.4).
 */
export function isPrivateOrReservedIp(ipInput: string): boolean {
  const ip = ipInput.trim().replace(/^\[|\]$/g, "").toLowerCase();

  // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIp(mapped);
    }
    const hexParts = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hexParts && hexParts[1] && hexParts[2]) {
      const hi = Number.parseInt(hexParts[1], 16);
      const lo = Number.parseInt(hexParts[2], 16);
      const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isPrivateOrReservedIp(v4);
    }
    return true;
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;

    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
    if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip === "0:0:0:0:0:0:0:0") {
      return true;
    }
    // Unique local fc00::/7 (fc.. or fd..)
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    // Link-local fe80::/10 (fe8., fe9., fea., feb.)
    if (/^fe[89ab]/i.test(ip)) return true;
    // Multicast ff00::/8
    if (ip.startsWith("ff")) return true;
    return false;
  }

  return true;
}

export function isSuspiciousHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host === "instance-data"
  ) {
    return true;
  }

  // Reject integer / hex / octal IP representations (e.g. 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return true;
  }
  const dotParts = host.split(".");
  if (
    dotParts.every((p) => /^\d+$/.test(p) || /^0x[0-9a-f]+$/i.test(p)) &&
    dotParts.some((p) => (p.startsWith("0") && p.length > 1) || p.startsWith("0x"))
  ) {
    return true;
  }

  return false;
}

export type DnsLookupFn = (hostname: string) => Promise<string[]>;

const defaultDnsLookup: DnsLookupFn = async (hostname: string) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export async function validateSafeExternalUrl(
  rawUrl: string,
  options: {
    maxQueryChars?: number;
    allowDomains?: string[];
    denyDomains?: string[];
    dnsLookup?: DnsLookupFn;
  } = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NyxError("ERR_SSRF_BLOCKED", `Invalid URL: "${rawUrl}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NyxError(
      "ERR_SSRF_BLOCKED",
      `Unsupported URL protocol "${parsed.protocol}" (only http/https allowed)`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new NyxError("ERR_SSRF_BLOCKED", "URLs with embedded credentials are forbidden");
  }

  const maxQuery = options.maxQueryChars ?? 256;
  const queryLen = parsed.search.startsWith("?") ? parsed.search.length - 1 : parsed.search.length;
  if (queryLen > maxQuery) {
    throw new NyxError(
      "ERR_SSRF_BLOCKED",
      `Query string length (${queryLen}) exceeds maximum allowed (${maxQuery}) to prevent data exfiltration`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (options.denyDomains?.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
    throw new NyxError("ERR_SSRF_BLOCKED", `Domain "${hostname}" is blocked by webFetchDeny`);
  }

  if (
    options.allowDomains &&
    options.allowDomains.length > 0 &&
    !options.allowDomains.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))
  ) {
    throw new NyxError("ERR_SSRF_BLOCKED", `Domain "${hostname}" is not in webFetchAllow`);
  }

  if (isSuspiciousHostname(hostname)) {
    throw new NyxError("ERR_SSRF_BLOCKED", `Blocked internal/suspicious hostname "${hostname}"`);
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new NyxError("ERR_SSRF_BLOCKED", `Blocked private/reserved IP literal "${hostname}"`);
    }
    return parsed;
  }

  const lookup = options.dnsLookup ?? defaultDnsLookup;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new NyxError(
      "ERR_NETWORK_BLOCKED",
      `DNS resolution failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw new NyxError("ERR_SSRF_BLOCKED", `No DNS records resolved for "${hostname}"`);
  }

  for (const addr of addresses) {
    if (isPrivateOrReservedIp(addr)) {
      throw new NyxError(
        "ERR_SSRF_BLOCKED",
        `DNS rebinding / SSRF blocked: "${hostname}" resolved to private/reserved IP "${addr}"`,
      );
    }
  }

  return parsed;
}

export function extractReadableTextFromHtml(html: string, url: string): string {
  // First strip hidden DOM/CSS/comments/scripts before Readability so hidden text is never extracted
  const preSanitized = sanitizeUntrustedContent(html, url);
  try {
    const { document } = parseHTML(preSanitized.sanitizedText);
    const reader = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    );
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      return `${article.title ? `# ${article.title}\n\n` : ""}${article.textContent.trim()}`;
    }
  } catch {
    // Fallback to tag stripping
  }
  return preSanitized.sanitizedText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export const webFetchInputSchema = z.object({
  url: z.string().min(1),
  purpose: z.string().min(3).max(200),
});

export const webFetchOutputSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  statusCode: z.number().int(),
  contentHash: z.string(),
  riskScore: z.number().int(),
  detectedThreats: z.array(z.string()),
  wrappedContent: z.string(),
});

// Allow tests to inject custom fetch and DNS resolver without live network calls (§12)
let customFetchImpl: typeof fetch | null = null;
let customDnsLookupImpl: DnsLookupFn | null = null;

export function setWebFetchTestHooks(hooks: {
  fetch?: typeof fetch | null;
  dnsLookup?: DnsLookupFn | null;
}): void {
  if (hooks.fetch !== undefined) customFetchImpl = hooks.fetch;
  if (hooks.dnsLookup !== undefined) customDnsLookupImpl = hooks.dnsLookup;
}

export const nyxWebFetchTool = defineTool({
  name: "nyx_web_fetch",
  description: "Fetches external URL via SSRF-safe GET, converts to readable text, sanitizes, and logs citation hash.",
  annotations: {
    title: "SSRF-Safe Sanitized Web Fetch",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: webFetchInputSchema,
  outputSchema: webFetchOutputSchema,
  handler: async (input, ctx) => {
    const fetchFn = customFetchImpl ?? globalThis.fetch;
    const dnsLookup = customDnsLookupImpl ?? defaultDnsLookup;

    let currentUrlStr = input.url;
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const validatedUrl = await validateSafeExternalUrl(currentUrlStr, {
        maxQueryChars: ctx.config.network.maxQueryChars,
        allowDomains: ctx.config.network.webFetchAllow,
        denyDomains: ctx.config.network.webFetchDeny,
        dnsLookup,
      });

      response = await fetchFn(validatedUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Nyxowl-Security-Hardened-Agent/1.0",
          Accept: "text/html, text/plain, text/markdown, application/json",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        if (hop === MAX_REDIRECTS) {
          throw new NyxError("ERR_SSRF_BLOCKED", `Exceeded maximum redirects (${MAX_REDIRECTS})`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new NyxError("ERR_SSRF_BLOCKED", "Redirect response missing Location header");
        }
        currentUrlStr = new URL(location, validatedUrl).toString();
        continue;
      }
      break;
    }

    if (!response) {
      throw new NyxError("ERR_NETWORK_BLOCKED", "Failed to receive HTTP response");
    }

    const contentType = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
    const allowedCt = ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t));
    if (!allowedCt) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        `Disallowed content-type "${contentType}" from ${currentUrlStr}`,
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw new NyxError(
        "ERR_BUDGET_EXCEEDED",
        `Response size (${buf.byteLength} bytes) exceeds 2 MB cap`,
      );
    }

    const rawText = buf.toString("utf8");
    const preCheck = sanitizeUntrustedContent(rawText, currentUrlStr);

    const readable = contentType.includes("text/html")
      ? extractReadableTextFromHtml(rawText, currentUrlStr)
      : preCheck.sanitizedText;

    const finalSanitized = sanitizeUntrustedContent(readable, currentUrlStr);
    const mergedThreats = [
      ...new Set([...preCheck.detectedThreats, ...finalSanitized.detectedThreats]),
    ];
    const finalRisk = Math.min(100, Math.max(preCheck.riskScore, finalSanitized.riskScore));

    const contentHash = crypto
      .createHash("sha256")
      .update(finalSanitized.sanitizedText, "utf8")
      .digest("hex");

    const wrappedContent = `<untrusted_data source="${currentUrlStr.replace(/["<>]/g, "")}" sanitized="true" risk="${finalRisk}">\n${finalSanitized.sanitizedText}\n</untrusted_data>`;

    ctx.db.withImmediateTransaction(() => {
      ctx.db.db
        .prepare(
          `INSERT INTO web_fetch_log (url, purpose, status_code, content_hash, risk_score, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.url,
          input.purpose,
          response.status,
          contentHash,
          finalRisk,
          new Date().toISOString(),
        );
      if (currentUrlStr !== input.url) {
        ctx.db.db
          .prepare(
            `INSERT INTO web_fetch_log (url, purpose, status_code, content_hash, risk_score, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            currentUrlStr,
            input.purpose,
            response.status,
            contentHash,
            finalRisk,
            new Date().toISOString(),
          );
      }
    });

    return {
      url: input.url,
      finalUrl: currentUrlStr,
      statusCode: response.status,
      contentHash,
      riskScore: finalRisk,
      detectedThreats: mergedThreats,
      wrappedContent,
    };
  },
});
