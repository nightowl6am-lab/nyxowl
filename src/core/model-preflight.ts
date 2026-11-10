import { z } from "zod";
import { type ErrorCode, NyxError } from "./errors.ts";
import { defineTool } from "../mcp/tool.ts";

/**
 * BUG 11 — Model/variant preflight.
 *
 * The roster pins the required model and variant per Nyxowl role. Resolution
 * never substitutes a different model or a "free" (variant-less) request
 * silently: unavailable roles, models, or variants fail loudly with the exact
 * list of available variants so dispatches get fixed instead of drifted.
 */

export interface RosterEntry {
  readonly provider: string;
  readonly model: string;
  /** `null` means the role must run WITHOUT a `#variant` suffix. */
  readonly variant: string | null;
}

export const ERR_MODEL_UNAVAILABLE: ErrorCode = "ERR_MODEL_UNAVAILABLE";

export const NYX_MODEL_ROSTER: Readonly<Record<string, RosterEntry>> = {
  "nyx-architect": { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: "high" },
  "nyx-sec": { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: "high" },
  "nyx-api": { provider: "opencode-go", model: "glm-5.3-flash", variant: "high" },
  "nyx-db": { provider: "opencode-go", model: "glm-5.3-flash", variant: "high" },
  "nyx-probe": { provider: "opencode-go", model: "glm-5.3-flash", variant: "high" },
  "nyx-devops": { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: "high" },
  "nyx-ui": { provider: "opencode-go", model: "deepseek-v4.1-flash", variant: "high" },
  "nyx-designer": { provider: "opencode-go", model: "qwen3.8-flash", variant: "xhigh" },
  "nyx-product": { provider: "opencode-go", model: "qwen3.8-flash", variant: "xhigh" },
  "nyx-testwriter": { provider: "opencode-go", model: "glm-5.3-flash", variant: "high" },
} as const;

/** `null` in the list means "no variant suffix" (displayed as "none"). */
export const AVAILABLE_MODEL_VARIANTS: Readonly<Record<string, readonly (string | null)[]>> = {
  "deepseek-v4.1-flash": ["low", "high", "max"],
  "glm-5.3-flash": ["low", "high", "max"],
  "qwen3.8-flash": [null, "low", "medium", "xhigh"],
} as const;

export const KNOWN_MODEL_NAMES: readonly string[] = Object.keys(AVAILABLE_MODEL_VARIANTS);

function formatVariants(variants: readonly (string | null)[]): string[] {
  return variants.map((v) => v ?? "none");
}

export interface ModelPreflightRequest {
  readonly role: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly variant?: string | undefined;
}

export interface ModelPreflightResult {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly resolved: string;
  /** Available variants for the model, "none" included for variant-free models. */
  readonly availableVariants: string[];
  readonly ok: boolean;
}

function rejectModelUnavailable(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new NyxError(ERR_MODEL_UNAVAILABLE, message, details);
}

/**
 * Resolves a role (and optional explicit provider/model/variant request)
 * against the roster. Throws `NyxError` with code `ERR_MODEL_UNAVAILABLE` for
 * unknown roles, unknown models, unsupported variants, or a request that
 * deviates from the roster for the role. Never substitutes.
 */
export function resolveModelVariant(request: ModelPreflightRequest): ModelPreflightResult {
  const expected = NYX_MODEL_ROSTER[request.role];
  if (!expected) {
    rejectModelUnavailable(
      `Unknown Nyxowl role "${request.role}". Known roles: ${Object.keys(NYX_MODEL_ROSTER).join(", ")}`,
      {
        requestedRole: request.role,
        availableRoles: Object.keys(NYX_MODEL_ROSTER),
        availableVariants: [],
      },
    );
  }

  const provider = request.provider ?? expected.provider;
  const model = request.model ?? expected.model;

  const variantsForModel = AVAILABLE_MODEL_VARIANTS[model];
  if (variantsForModel === undefined) {
    rejectModelUnavailable(
      `Model "${model}" is not available to Nyxowl. Available models: ${KNOWN_MODEL_NAMES.join(", ")}`,
      {
        requestedModel: model,
        availableModels: [...KNOWN_MODEL_NAMES],
        availableVariants: [],
      },
    );
  }

  // Variant availability is checked BEFORE roster match so that an unsupported
  // variant (e.g. qwen3.8-flash#high) reports the model's real variant list.
  const variant = request.variant ?? expected.variant;
  const variantsFormatted = formatVariants(variantsForModel);
  if (variant !== null && variant !== undefined && !variantsForModel.includes(variant)) {
    rejectModelUnavailable(
      `Model "${model}" does not support variant "${variant}". Available variants: ${variantsFormatted.join(" | ")}`,
      {
        requestedModel: model,
        requestedVariant: variant,
        availableVariants: variantsFormatted,
      },
    );
  }

  // Explicit requests must exactly match the roster for the role; no drift, no
  // substitution, no dropping of a variant to the free form.
  if (request.provider !== undefined && request.provider !== expected.provider) {
    rejectModelUnavailable(
      `Role "${request.role}" requires provider "${expected.provider}", received "${request.provider}". Expected model: ${expected.provider}/${expected.model}`,
      {
        requestedProvider: request.provider,
        expectedProvider: expected.provider,
        expectedResolved: `${expected.provider}/${expected.model}`,
        availableVariants: variantsFormatted,
      },
    );
  }
  if (request.model !== undefined && request.model !== expected.model) {
    rejectModelUnavailable(
      `Role "${request.role}" requires model "${expected.model}", received "${model}". Expected: ${expected.provider}/${expected.model}`,
      {
        requestedModel: model,
        expectedModel: expected.model,
        expectedResolved: `${expected.provider}/${expected.model}`,
        availableVariants: variantsFormatted,
      },
    );
  }
  if (request.variant !== undefined && request.variant !== expected.variant) {
    rejectModelUnavailable(
      `Role "${request.role}" requires variant "${expected.variant ?? "none"}", received "${request.variant}". Expected: ${expected.provider}/${expected.model}${expected.variant ? `#${expected.variant}` : ""}`,
      {
        requestedVariant: request.variant,
        expectedVariant: expected.variant,
        expectedResolved: `${expected.provider}/${expected.model}${expected.variant ? `#${expected.variant}` : ""}`,
        availableVariants: variantsFormatted,
      },
    );
  }

  const finalVariant = variant ?? null;
  return {
    role: request.role,
    provider,
    model,
    variant: finalVariant,
    resolved: `${provider}/${model}${finalVariant ? `#${finalVariant}` : ""}`,
    availableVariants: variantsFormatted,
    ok: true,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const modelPreflightInputSchema = z.strictObject({
  role: z.string().min(1),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
});

export const modelPreflightOutputSchema = z.strictObject({
  role: z.string(),
  provider: z.string(),
  model: z.string(),
  variant: z.string().nullable(),
  resolved: z.string(),
  availableVariants: z.array(z.string()),
  ok: z.boolean(),
});

const PREFLIGHT_DESCRIPTION =
  "Preflights a role's model and variant against the Nyxowl roster; rejects unavailable models/variants and never substitutes.";

export const nyxModelPreflightTool = defineTool({
  name: "nyx_model_preflight",
  description: PREFLIGHT_DESCRIPTION,
  annotations: {
    title: "Model Preflight",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: modelPreflightInputSchema,
  outputSchema: modelPreflightOutputSchema,
  handler: (input, _ctx) => {
    const result = resolveModelVariant({
      role: input.role,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
    });
    return Promise.resolve(result);
  },
});
