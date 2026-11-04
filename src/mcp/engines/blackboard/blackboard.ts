import { z } from "zod";
import { NyxError } from "../../../core/errors.ts";
import { defineTool } from "../../tool.ts";

export const blackboardCategorySchema = z.enum([
  "product",
  "architecture",
  "api-contract",
  "db-contract",
  "design",
  "security",
  "docs",
]);

export type BlackboardCategory = z.infer<typeof blackboardCategorySchema>;

const CATEGORY_SCHEMAS: Record<BlackboardCategory, z.ZodTypeAny> = {
  product: z.object({
    summary: z.string().max(500),
    requirements: z.array(z.string().max(240)).max(20),
    acceptanceCriteria: z.array(z.string().max(240)).max(20),
    nonGoals: z.array(z.string().max(200)).max(10).optional(),
  }),
  architecture: z.object({
    summary: z.string().max(500),
    slices: z
      .array(
        z.object({
          id: z.string().max(64),
          title: z.string().max(160),
          files: z.array(z.string().max(200)),
        }),
      )
      .max(15),
    modules: z.array(z.string().max(240)).max(20),
  }),
  "api-contract": z.object({
    endpoints: z
      .array(
        z.object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().max(160),
          requestShape: z.string().max(400).optional(),
          responseShape: z.string().max(400),
          auth: z.string().max(100).optional(),
        }),
      )
      .max(30),
  }),
  "db-contract": z.object({
    tables: z
      .array(
        z.object({
          name: z.string().max(100),
          columns: z.array(z.string().max(160)).max(50),
          rlsPolicy: z.string().max(240).optional(),
        }),
      )
      .max(30),
  }),
  design: z.object({
    tokens: z.record(z.string(), z.string().max(100)),
    components: z
      .array(
        z.object({
          name: z.string().max(100),
          states: z.array(z.string().max(64)),
          a11yNotes: z.string().max(240).optional(),
        }),
      )
      .max(30),
  }),
  security: z.object({
    status: z.enum(["pass", "fail", "review"]),
    findings: z
      .array(
        z.object({
          severity: z.enum(["critical", "high", "medium", "low", "info"]),
          vector: z.string().max(100),
          description: z.string().max(300),
          remediation: z.string().max(300).optional(),
        }),
      )
      .max(30),
  }),
  docs: z.object({
    topic: z.string().max(120),
    summary: z.string().max(500),
    apiSurface: z.array(z.string().max(240)).max(20),
  }),
};

const WRITER_ROLES = new Set([
  "nyx-db",
  "nyx-api",
  "nyx-ui",
  "nyx-designer",
  "nyx-devops",
]);

export const blackboardPublishInputSchema = z.object({
  key: z.string().min(1).max(120),
  category: blackboardCategorySchema,
  schemaJson: z.record(z.string(), z.unknown()).optional(),
  authorRole: z.string().min(1),
  citations: z.array(z.string()).optional(),
  promote: z.boolean().optional(),
  repoPath: z.string().optional(),
});

export const blackboardPublishOutputSchema = z.object({
  key: z.string(),
  version: z.number().int(),
  category: blackboardCategorySchema,
  authorRole: z.string(),
  trust: z.enum(["untrusted", "promoted"]),
  createdAt: z.string(),
});

export const nyxBlackboardPublishTool = defineTool({
  name: "nyx_blackboard_publish",
  description: "Publishes or promotes a versioned, schema-validated Blackboard entry.",
  annotations: {
    title: "Blackboard Publish",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: blackboardPublishInputSchema,
  outputSchema: blackboardPublishOutputSchema,
  handler: async (input, ctx) => {
    const citations = input.citations ?? [];

    if (input.promote && input.authorRole !== "nyxowl") {
      throw new NyxError(
        "ERR_BLACKBOARD_UNAUTHORIZED",
        `Only role "nyxowl" may promote Blackboard entries (caller was "${input.authorRole}")`,
      );
    }

    // If promoting an existing key without providing new schemaJson, copy the latest version as promoted
    let payloadObj = input.schemaJson;
    if (!payloadObj && input.promote) {
      const existing = ctx.db.db
        .prepare(
          "SELECT schema_json, citations_json FROM blackboard WHERE key = ? ORDER BY version DESC LIMIT 1",
        )
        .get(input.key) as { schema_json: string; citations_json: string } | undefined;
      if (!existing) {
        throw new NyxError(
          "ERR_INVALID_INPUT",
          `Cannot promote nonexistent Blackboard key "${input.key}"`,
        );
      }
      payloadObj = JSON.parse(existing.schema_json) as Record<string, unknown>;
    }

    if (!payloadObj) {
      throw new NyxError("ERR_INVALID_INPUT", "schemaJson is required when publishing a new entry");
    }

    // Validate against category schema with field length caps
    const catSchema = CATEGORY_SCHEMAS[input.category];
    const parsedCat = catSchema.safeParse(payloadObj);
    if (!parsedCat.success) {
      throw new NyxError(
        "ERR_INVALID_INPUT",
        `Blackboard schema validation failed for category "${input.category}": ${parsedCat.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    // Taint rules (§1.3.1, §1.3.2, §6 Engine 5)
    if (input.authorRole === "nyx-product") {
      if (citations.length === 0) {
        throw new NyxError(
          "ERR_BLACKBOARD_CITATION_INVALID",
          "Entries from tainted role nyx-product require citations logged by nyx_web_fetch",
        );
      }
      for (const url of citations) {
        const logRow = ctx.db.db
          .prepare("SELECT id FROM web_fetch_log WHERE url = ? LIMIT 1")
          .get(url) as { id: number } | undefined;
        if (!logRow) {
          throw new NyxError(
            "ERR_BLACKBOARD_CITATION_INVALID",
            `Citation URL "${url}" was not found in nyx_web_fetch log`,
          );
        }
      }
    }

    const trust: "untrusted" | "promoted" =
      input.authorRole === "nyx-product"
        ? "untrusted"
        : input.promote || input.authorRole !== "nyx-product"
          ? "promoted"
          : "untrusted";

    const nowIso = new Date().toISOString();
    let nextVersion = 1;

    ctx.db.withImmediateTransaction(() => {
      const verRow = ctx.db.db
        .prepare("SELECT COALESCE(MAX(version), 0) as max_ver FROM blackboard WHERE key = ?")
        .get(input.key) as { max_ver: number } | undefined;
      nextVersion = (verRow?.max_ver ?? 0) + 1;

      ctx.db.db
        .prepare(
          `INSERT INTO blackboard (
             key, version, category, schema_json, author_role, trust, citations_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.key,
          nextVersion,
          input.category,
          JSON.stringify(parsedCat.data),
          input.authorRole,
          trust,
          JSON.stringify(citations),
          nowIso,
        );
    });

    return {
      key: input.key,
      version: nextVersion,
      category: input.category,
      authorRole: input.authorRole,
      trust,
      createdAt: nowIso,
    };
  },
});

export const blackboardReadInputSchema = z.object({
  key: z.string().optional(),
  category: blackboardCategorySchema.optional(),
  trust: z.enum(["untrusted", "promoted", "all"]).optional(),
  callerRole: z.string().optional(),
  repoPath: z.string().optional(),
});

export const blackboardEntryOutputSchema = z.object({
  key: z.string(),
  version: z.number().int(),
  category: blackboardCategorySchema,
  authorRole: z.string(),
  trust: z.enum(["untrusted", "promoted"]),
  citations: z.array(z.string()),
  content: z.string(),
  createdAt: z.string(),
});

export const blackboardReadOutputSchema = z.object({
  entries: z.array(blackboardEntryOutputSchema),
});

export const nyxBlackboardReadTool = defineTool({
  name: "nyx_blackboard_read",
  description: "Reads latest Blackboard entries; wraps untrusted entries and enforces writer promotion gates.",
  annotations: {
    title: "Blackboard Read",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: blackboardReadInputSchema,
  outputSchema: blackboardReadOutputSchema,
  handler: async (input, ctx) => {
    const role = input.callerRole ?? ctx.callerRole;
    const isWriter = WRITER_ROLES.has(role);

    if (isWriter && input.trust === "untrusted") {
      throw new NyxError(
        "ERR_BLACKBOARD_UNTRUSTED",
        `Writer role "${role}" is only allowed to read promoted Blackboard entries`,
      );
    }

    // Fetch latest version per key
    const rows = ctx.db.db
      .prepare(
        `SELECT b.key, b.version, b.category, b.schema_json, b.author_role, b.trust, b.citations_json, b.created_at
         FROM blackboard b
         INNER JOIN (
           SELECT key, MAX(version) as max_ver FROM blackboard GROUP BY key
         ) latest ON b.key = latest.key AND b.version = latest.max_ver
         ORDER BY b.id DESC`,
      )
      .all() as Array<{
      key: string;
      version: number;
      category: BlackboardCategory;
      schema_json: string;
      author_role: string;
      trust: "untrusted" | "promoted";
      citations_json: string;
      created_at: string;
    }>;

    const filtered = rows.filter((row) => {
      if (input.key && row.key !== input.key) return false;
      if (input.category && row.category !== input.category) return false;
      if (isWriter && row.trust !== "promoted") return false;
      if (input.trust && input.trust !== "all" && row.trust !== input.trust) return false;
      return true;
    });

    if (input.key && filtered.length === 0 && isWriter) {
      // Check if an untrusted version exists so we give an explicit quarantine error
      const untrustedRow = rows.find((r) => r.key === input.key && r.trust === "untrusted");
      if (untrustedRow) {
        throw new NyxError(
          "ERR_BLACKBOARD_UNTRUSTED",
          `Blackboard key "${input.key}" is untrusted and has not been promoted by nyxowl for writer role "${role}"`,
        );
      }
    }

    const entries = filtered.map((row) => {
      const citations = JSON.parse(row.citations_json) as string[];
      const content =
        row.trust === "untrusted"
          ? `<untrusted_data source="blackboard:${row.key}" sanitized="true">\n${row.schema_json}\n</untrusted_data>`
          : row.schema_json;

      return {
        key: row.key,
        version: row.version,
        category: row.category,
        authorRole: row.author_role,
        trust: row.trust,
        citations,
        content,
        createdAt: row.created_at,
      };
    });

    return { entries };
  },
});
