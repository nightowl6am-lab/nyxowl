/** Deterministic RLS audit used by the nyx-db readiness fixture. */

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([\w.]+)["'`]?/gi;
const RLS_ENABLE = /enable\s+row\s+level\s+security/i;
const TAUTOLOGY = /using\s*\(\s*true\s*\)/gi;

function tableForIndex(sql, index, tables) {
  let name = null;
  for (const table of tables) {
    if (table.index <= index) name = table.name;
    else break;
  }
  return name;
}

export function auditRls(sql) {
  const findings = [];
  const tables = [...String(sql).matchAll(CREATE_TABLE)].map((match) => ({
    name: match[1],
    index: match.index ?? 0,
  }));

  tables.forEach((table, position) => {
    const end = position + 1 < tables.length ? tables[position + 1].index : sql.length;
    const block = sql.slice(table.index, end);
    if (!RLS_ENABLE.test(block)) {
      findings.push({ code: "RLS_DISABLED", table: table.name });
    }
  });

  for (const match of String(sql).matchAll(TAUTOLOGY)) {
    findings.push({
      code: "TAUTOLOGICAL_POLICY",
      table: tableForIndex(sql, match.index ?? 0, tables),
    });
  }

  return findings;
}

export function run(artifact) {
  const findings = Array.isArray(artifact?.findings) ? artifact.findings : [];
  const errors = [];
  if (!findings.some((finding) => finding?.code === "RLS_DISABLED")) {
    errors.push("missing RLS_DISABLED finding");
  }
  if (!findings.some((finding) => finding?.code === "TAUTOLOGICAL_POLICY")) {
    errors.push("missing TAUTOLOGICAL_POLICY finding");
  }
  return { ok: errors.length === 0, errors };
}
