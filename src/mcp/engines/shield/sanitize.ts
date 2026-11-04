import { z } from "zod";
import { defineTool } from "../../tool.ts";

export interface SanitizeResult {
  sanitizedText: string;
  wrappedBlock: string;
  riskScore: number;
  detectedThreats: string[];
}

const INJECTION_PATTERNS: Array<{ id: string; weight: number; regex: RegExp }> = [
  {
    id: "ignore-instructions",
    weight: 45,
    regex: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions|prompts|rules|guidelines)\b/gi,
  },
  {
    id: "persona-hijack",
    weight: 35,
    regex: /\b(?:you\s+are\s+now|act\s+as\s+an?\s+unrestricted|new\s+system\s+prompt|system\s+override|developer\s+mode\s+enabled)\b/gi,
  },
  {
    id: "fake-role-tags",
    weight: 40,
    regex: /<\s*\/?\s*(?:system|developer|assistant|user_request|tool_call|tool_response|function_calls)\b[^>]*>/gi,
  },
  {
    id: "command-execution-directive",
    weight: 40,
    regex: /\b(?:run\s+this\s+command\s+immediately|execute\s+in\s+terminal|curl\s+[^\n|]+\|\s*(?:ba)?sh|wget\s+[^\n|]+\|\s*(?:ba)?sh)\b/gi,
  },
  {
    id: "secret-exfiltration-directive",
    weight: 50,
    regex: /\b(?:printenv|cat\s+[^\n]*\.env|read\s+[^\n]*\.ssh\/id_rsa|send\s+[^\n]*api[_-]?key|upload\s+[^\n]*credentials)\b/gi,
  },
];

export function sanitizeUntrustedContent(
  rawContent: string,
  sourceUrl = "unknown",
): SanitizeResult {
  const threats = new Set<string>();
  let score = 0;
  let text = rawContent;

  // 1. Strip HTML comments
  if (/<!--[\s\S]*?-->/.test(text)) {
    threats.add("html-comment");
    score += 10;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  }

  // 2. Strip <script>, <style>, <iframe>, <object>, <embed>, <svg> blocks
  if (/<\s*(?:script|style|iframe|object|embed)\b/i.test(text)) {
    threats.add("active-html-tags");
    score += 20;
    text = text.replace(
      /<\s*(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    );
  }

  // 3. Strip hidden DOM elements (display:none, visibility:hidden, opacity:0, font-size:0, hidden attr)
  const hiddenDomRegex =
    /<([a-zA-Z0-9]+)\b[^>]*(?:style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|font-size\s*:\s*0)[^"']*["']|\bhidden\b|\baria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
  if (hiddenDomRegex.test(text)) {
    threats.add("hidden-dom-css");
    score += 40;
    text = text.replace(hiddenDomRegex, "[STRIPPED:HIDDEN_DOM]");
  }

  // 4. Strip zero-width and bidi-control Unicode characters
  const zeroWidthBidiRegex = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  if (zeroWidthBidiRegex.test(text)) {
    threats.add("zero-width-or-bidi-unicode");
    score += 35;
    text = text.replace(zeroWidthBidiRegex, "");
  }

  // 5. Strip Markdown image / link exfiltration URLs (`![...](http...)` with query/interpolation)
  const mdImageRegex = /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\s*\)/gi;
  if (mdImageRegex.test(text)) {
    threats.add("markdown-image-exfil");
    score += 30;
    text = text.replace(mdImageRegex, "[STRIPPED:MARKDOWN_IMAGE]");
  }

  // 6. Detect and neutralize base64 payloads that decode to instructions or shell commands
  text = text.replace(/\b([A-Za-z0-9+/]{32,}={0,2})\b/g, (match) => {
    try {
      const decoded = Buffer.from(match, "base64").toString("utf8");
      if (
        /\b(?:ignore\s+previous|curl\s+|wget\s+|bash\s+-c|sh\s+-c|printenv|\.env|eval\s*\()\b/i.test(
          decoded,
        )
      ) {
        threats.add("base64-encoded-payload");
        score += 45;
        return "[STRIPPED:ENCODED_PAYLOAD]";
      }
    } catch {
      // Keep non-malicious token
    }
    return match;
  });

  // 7. Strip instruction-override phrases
  for (const pat of INJECTION_PATTERNS) {
    pat.regex.lastIndex = 0;
    if (pat.regex.test(text)) {
      threats.add(pat.id);
      score += pat.weight;
      text = text.replace(pat.regex, `[STRIPPED:${pat.id.toUpperCase()}]`);
    }
  }

  // Escape any attempt to close </untrusted_data>
  text = text.replace(/<\s*\/?\s*untrusted_data[^>]*>/gi, "[STRIPPED:TAG_ESCAPE]");

  const boundedScore = Math.min(100, score);
  const safeSource = sourceUrl.replace(/["<>]/g, "");
  const wrappedBlock = `<untrusted_data source="${safeSource}" sanitized="true" risk="${boundedScore}">\n${text.trim()}\n</untrusted_data>`;

  return {
    sanitizedText: text.trim(),
    wrappedBlock,
    riskScore: boundedScore,
    detectedThreats: [...threats],
  };
}

export const sanitizeUntrustedInputSchema = z.object({
  content: z.string(),
  sourceUrl: z.string().default("external"),
});

export const sanitizeUntrustedOutputSchema = z.object({
  sanitizedText: z.string(),
  wrappedBlock: z.string(),
  riskScore: z.number().int().min(0).max(100),
  detectedThreats: z.array(z.string()),
});

export const nyxSanitizeUntrustedTool = defineTool({
  name: "nyx_sanitize_untrusted",
  description: "Sanitizes untrusted text/HTML against prompt injection, hidden DOM, bidi tricks, and exfil links.",
  annotations: {
    title: "Untrusted Content Sanitizer",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: sanitizeUntrustedInputSchema,
  outputSchema: sanitizeUntrustedOutputSchema,
  handler: async (input) => {
    return sanitizeUntrustedContent(input.content, input.sourceUrl);
  },
});
