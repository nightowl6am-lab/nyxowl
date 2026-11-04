#!/usr/bin/env python3
"""
rls_audit.py - deterministic static audit of Postgres / Supabase SQL files.

What it does
  * Finds EVERY *.sql file under the paths you give it (no extension allowlist).
  * Splits each file into statements with a real lexer (handles comments,
    quoted strings, $$ bodies), then replays the statements in file order to
    rebuild the FINAL state of tables, RLS flags, policies, grants, functions
    and views, and reports problems.
  * Refuses to be quiet about gaps: any security-relevant statement it cannot
    parse is reported as COV001 and makes the exit code 2.

What it never does
  * No network, no database connection, no writes, no subprocesses.
  * Python standard library only.

Exit codes
  0  every file read and parsed, no HIGH findings
  1  every file read and parsed, at least one HIGH finding
  2  coverage problem (no files, unreadable file, or unparsed statement)
"""
import argparse
import json
import os
import re
import sys
from collections import OrderedDict

VERSION = "1.0.0"
SEV_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFO": 3}
API_ROLES = ("anon", "authenticated")
ALL_T = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"}
WRITE_T = {"INSERT", "UPDATE", "DELETE", "TRUNCATE"}
SKIP_DIRS = {".git", "node_modules", ".next", "dist", "build", "__pycache__", ".venv", "venv"}

# Statement families that are security-relevant but not modeled by any HANDLER.
# Matched in the process_file for...else to produce COV003 findings.
SECURITY_RELEVANT_UNHANDLED = re.compile(
    r'^\s*('
    r'CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b'
    r'|DROP\s+TRIGGER\b'
    r'|ALTER\s+TRIGGER\b'
    r'|CREATE\s+(?:OR\s+REPLACE\s+)?RULE\b'
    r'|DROP\s+RULE\b'
    r'|DO\s+\$'                               # anonymous code block
    r'|COPY\s+\S+\s+FROM\b'                   # bulk load from file/stdin
    r'|CREATE\s+(?:OR\s+REPLACE\s+)?EVENT\s+TRIGGER\b'
    r'|ALTER\s+SYSTEM\b'
    r'|LOAD\s+'                               # shared-library load
    r'|REASSIGN\s+OWNED\b'
    r'|CREATE\s+(?:OR\s+REPLACE\s+)?FOREIGN\s+TABLE\b'
    r'|IMPORT\s+FOREIGN\s+SCHEMA\b'
    r'|SET\s+(?:LOCAL\s+)?ROLE\b'
    r'|SET\s+SESSION\s+AUTHORIZATION\b'
    r'|SECURITY\s+LABEL\b'
    r')', re.I)

IDENT = r'(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)'
NAME = IDENT + r'(?:\s*\.\s*' + IDENT + r')?'
DOLLAR = re.compile(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$')


# --------------------------------------------------------------------------
# Lexer: strips comments, masks string contents, splits on top-level ';'
# --------------------------------------------------------------------------
def _blank(s):
    return ''.join(c if c in '\r\n' else ' ' for c in s)


def _maskstr(s):
    return ''.join(c if c in '\r\n' else 'x' for c in s)


def lex(sql):
    """Return (T, M, cuts). T = comments blanked, strings intact.
    M = same length as T but string / $$-body contents replaced with 'x'.
    cuts = offsets of top-level semicolons. len(T) == len(M) == len(sql)."""
    n = len(sql)
    T, M, cuts = [], [], []
    i = 0
    while i < n:
        c = sql[i]
        two = sql[i:i + 2]
        if two == '--':
            j = sql.find('\n', i)
            j = n if j == -1 else j
            seg = _blank(sql[i:j])
            T.append(seg); M.append(seg); i = j
        elif two == '/*':
            depth, j = 1, i + 2
            while j < n and depth:
                if sql[j:j + 2] == '/*':
                    depth += 1; j += 2
                elif sql[j:j + 2] == '*/':
                    depth -= 1; j += 2
                else:
                    j += 1
            seg = _blank(sql[i:j])
            T.append(seg); M.append(seg); i = j
        elif c == "'":
            esc = i > 0 and sql[i - 1] in 'eE' and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] in '_$'))
            j = i + 1
            while j < n:
                if esc and sql[j] == '\\':
                    j += 2; continue
                if sql[j] == "'":
                    if sql[j + 1:j + 2] == "'":
                        j += 2; continue
                    break
                j += 1
            j = min(j + 1, n)
            seg = sql[i:j]
            T.append(seg)
            M.append("'" + _maskstr(seg[1:-1]) + "'" if len(seg) >= 2 else seg)
            i = j
        elif c == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if sql[j + 1:j + 2] == '"':
                        j += 2; continue
                    break
                j += 1
            j = min(j + 1, n)
            seg = sql[i:j]
            T.append(seg); M.append(seg); i = j
        elif c == '$' and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] in '_$')) and DOLLAR.match(sql, i):
            tag = DOLLAR.match(sql, i).group(0)
            body_start = i + len(tag)
            j = sql.find(tag, body_start)
            closed = j != -1
            if not closed:
                j = n
            end = j + len(tag) if closed else n
            seg = sql[i:end]
            T.append(seg)
            M.append(tag + _maskstr(sql[body_start:j]) + (tag if closed else ''))
            i = end
        elif c == ';':
            cuts.append(i)
            T.append(' '); M.append(' '); i += 1
        else:
            T.append(c); M.append(c); i += 1
    return ''.join(T), ''.join(M), cuts


def statements(sql):
    """Yield (line, text, masked) for each non-empty statement."""
    T, M, cuts = lex(sql)
    bounds = [-1] + cuts + [len(T)]
    for a, b in zip(bounds, bounds[1:]):
        t, m = T[a + 1:b], M[a + 1:b]
        if not t.strip():
            continue
        lead = len(t) - len(t.lstrip())
        trail = len(t.rstrip())
        line = sql.count('\n', 0, a + 1 + lead) + 1
        yield line, t[lead:trail], m[lead:trail]


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def split_top(s, sep=','):
    out, depth, cur = [], 0, []
    for ch in s:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == sep and depth == 0:
            out.append(''.join(cur)); cur = []
        else:
            cur.append(ch)
    out.append(''.join(cur))
    return [x.strip() for x in out if x.strip()]


def norm_ident(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1].replace('""', '"')
    return s.lower()


def parse_qname(raw, default='public'):
    parts = [norm_ident(p) for p in re.findall(IDENT, raw)]
    if not parts:
        return None
    if len(parts) == 1:
        return (default, parts[0])
    return (parts[-2], parts[-1])


def balanced(M, open_idx):
    """M[open_idx] == '('. Return index of the matching ')' (or len(M))."""
    depth = 0
    for k in range(open_idx, len(M)):
        if M[k] == '(':
            depth += 1
        elif M[k] == ')':
            depth -= 1
            if depth == 0:
                return k
    return len(M)


def norm_role(r):
    r = r.strip()
    r = re.sub(r'^(GROUP)\s+', '', r, flags=re.I)
    return norm_ident(r)


# Common Postgres type aliases → canonical form, used to match overloaded
# function signatures even when the CREATE and DROP use different spellings.
PG_TYPE_ALIASES = {
    'int': 'integer', 'int4': 'integer', 'int2': 'smallint',
    'int8': 'bigint', 'float4': 'real', 'float8': 'double precision',
    'bool': 'boolean', 'varchar': 'character varying',
    'char': 'character', 'decimal': 'numeric', 'serial': 'integer',
    'bigserial': 'bigint', 'smallserial': 'smallint',
    'timestamptz': 'timestamp with time zone',
    'timetz': 'time with time zone',
}


def _norm_type(t):
    """Normalise a single SQL type name for signature comparison."""
    t = re.sub(r'\s+', ' ', t.strip().lower())
    t = re.sub(r'\s*\[\s*\]', '[]', t)        # "int []" → "int[]"
    base = t.rstrip('[]')
    suffix = t[len(base):]
    return PG_TYPE_ALIASES.get(base, base) + suffix


def extract_arg_types(M, open_paren):
    """Extract a normalised tuple of INPUT arg types from a function signature.
    OUT-only parameters are excluded (they don't participate in overloading)."""
    close = balanced(M, open_paren)
    inner = M[open_paren + 1:close].strip()
    if not inner:
        return ()
    parts = split_top(inner)
    types = []
    for p in parts:
        # Strip DEFAULT / = default-value clause
        p = re.sub(r'\bDEFAULT\b.*$', '', p, flags=re.I).strip()
        p = re.sub(r'\s*=\s*\S+$', '', p).strip()
        tokens = p.split()
        if not tokens:
            continue
        # Detect and strip parameter mode keyword
        mode = 'IN'
        if tokens[0].upper() in ('IN', 'OUT', 'INOUT', 'VARIADIC'):
            mode = tokens[0].upper()
            tokens = tokens[1:]
        if mode == 'OUT':
            continue  # OUT params don't affect overload resolution
        if not tokens:
            continue
        # Two-or-more tokens: first is param name, rest is type
        # One token: it's the type (unnamed parameter)
        if len(tokens) >= 2:
            type_str = ' '.join(tokens[1:])
        else:
            type_str = tokens[0]
        types.append(_norm_type(type_str))
    return tuple(types)


def expand_privs(tokens, table=True):
    privs = set()
    for tok in tokens:
        if '(' in tok:
            continue  # column-level privilege, reported as COV002
        u = re.sub(r'\s+', ' ', tok.strip().upper())
        if u in ('ALL', 'ALL PRIVILEGES'):
            privs |= (ALL_T if table else {'EXECUTE'})
        else:
            privs.add(u)
    return privs


# --------------------------------------------------------------------------
# State model
# --------------------------------------------------------------------------
class Rel:
    def __init__(self, kind, schema, name, file, line, external=False):
        self.kind, self.schema, self.name = kind, schema, name
        self.file, self.line, self.external = file, line, external
        self.rls = None if external else False
        self.force_rls = False
        self.policies = OrderedDict()
        self.grants = {}
        self.invoker = False

    @property
    def fq(self):
        return "%s.%s" % (self.schema, self.name)

    def grant_state(self, role):
        return self.grants.setdefault(role, {'known': False, 'privs': set()})


class Func:
    def __init__(self, schema, name, sig, file, line):
        self.schema, self.name, self.sig = schema, name, sig
        self.file, self.line = file, line
        self.secdef = False
        self.search_path = False
        self.search_path_val = ""
        self.is_trigger = False
        self.public_exec = True
        self.anon_exec = None
        self.auth_exec = None
        self.dynamic = []
        self.role_switch = False  # SET ROLE / SET SESSION AUTHORIZATION in body

    @property
    def fq(self):
        sig_str = ", ".join(self.sig) if self.sig else ""
        return "%s.%s(%s)" % (self.schema, self.name, sig_str)


class State:
    def __init__(self, exposed):
        self.exposed = set(exposed)
        self.rels = OrderedDict()
        self.funcs = OrderedDict()
        self.tbl_default_events = []   # (scope, is_grant, privs, roles)
        self.fn_default_events = []    # (scope, is_grant, roles)
        self.findings = []
        self.unparsed = []
        self.notes = []

    def add(self, sev, code, title, detail, file, line, fix=""):
        self.findings.append({"severity": sev, "code": code, "title": title, "detail": detail,
                              "file": file, "line": line, "fix": fix})


def apply_table_priv(rel, role, privs, is_grant):
    g = rel.grant_state(role)
    if is_grant:
        g['privs'] |= privs
    else:
        g['privs'] -= privs
        if privs >= ALL_T:
            g['known'] = True


def new_rel(S, kind, key, file, line):
    rel = Rel(kind, key[0], key[1], file, line)
    rel.grant_state('public')['known'] = True
    for scope, is_grant, privs, roles in S.tbl_default_events:
        if scope in ('*', key[0]):
            for r in roles:
                apply_table_priv(rel, r, privs, is_grant)
    S.rels[key] = rel
    return rel


def get_rel(S, key, file, line):
    if key not in S.rels:
        S.rels[key] = Rel('table', key[0], key[1], file, line, external=True)
    return S.rels[key]


# --------------------------------------------------------------------------
# Statement handlers. Each returns True if parsed, False if it matched the
# loose family pattern but the strict parse failed (-> COV001).
# --------------------------------------------------------------------------
RE_CREATE_TABLE = re.compile(r'^\s*CREATE\s+(?P<pre>(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?)TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<n>' + NAME + ')', re.I)
RE_DROP_TABLE = re.compile(r'^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?P<n>' + NAME + r'(?:\s*,\s*' + NAME + ')*)', re.I)
RE_ALTER_TABLE = re.compile(r'^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<n>' + NAME + r')(?P<rest>.*)$', re.I | re.S)
RE_RLS_CLAUSE = re.compile(r'\b(?P<k>ENABLE|DISABLE|NOFORCE_RLS|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b|\bNOFORCE_RLS\b', re.I)
RE_CREATE_POLICY = re.compile(r'^\s*CREATE\s+POLICY\s+(?P<p>' + IDENT + r')\s+ON\s+(?P<t>' + NAME + ')', re.I)
RE_ALTER_POLICY = re.compile(r'^\s*ALTER\s+POLICY\s+(?P<p>' + IDENT + r')\s+ON\s+(?P<t>' + NAME + ')', re.I)
RE_DROP_POLICY = re.compile(r'^\s*DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(?P<p>' + IDENT + r')\s+ON\s+(?P<t>' + NAME + ')', re.I)
RE_GRANT = re.compile(r'^\s*(?P<v>GRANT|REVOKE)\s+(?:GRANT\s+OPTION\s+FOR\s+)?(?P<privs>.+?)\s+ON\s+(?P<obj>.+?)\s+(?P<dir>TO|FROM)\s+(?P<roles>.+)$', re.I | re.S)
RE_ADP = re.compile(r'^\s*ALTER\s+DEFAULT\s+PRIVILEGES\s+(?P<body>.*)$', re.I | re.S)
RE_CREATE_FUNC = re.compile(r'^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?P<k>FUNCTION|PROCEDURE)\s+(?P<n>' + NAME + r')\s*\(', re.I)
RE_ALTER_FUNC = re.compile(r'^\s*ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?P<n>' + NAME + r')\s*(?:\(|\s)', re.I)
RE_DROP_FUNC = re.compile(r'^\s*DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:IF\s+EXISTS\s+)?(?P<n>' + NAME + ')', re.I)
RE_CREATE_VIEW = re.compile(r'^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?(?P<m>MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<n>' + NAME + ')', re.I)
RE_ALTER_VIEW = re.compile(r'^\s*ALTER\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(?P<n>' + NAME + r')\s+(?P<rest>.*)$', re.I | re.S)
RE_DROP_VIEW = re.compile(r'^\s*DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(?P<n>' + NAME + r'(?:\s*,\s*' + NAME + ')*)', re.I)
RE_ROLE = re.compile(r'^\s*(?:CREATE|ALTER)\s+(?:ROLE|USER)\s+(?P<r>' + IDENT + r')(?P<rest>.*)$', re.I | re.S)
RE_EXTENSION = re.compile(r'^\s*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<ext>' + IDENT + r')', re.I)


def h_create_table(S, f, line, T, M):
    m = RE_CREATE_TABLE.match(M)
    if not m:
        return None
    if re.search(r'TEMP', m.group('pre'), re.I):
        return True  # temporary tables are session-local: ignored
    key = parse_qname(m.group('n'))
    new_rel(S, 'table', key, f, line)
    return True


def h_drop(S, f, line, T, M):
    m = RE_DROP_TABLE.match(M) or RE_DROP_VIEW.match(M)
    if not m:
        return None
    for raw in split_top(m.group('n')):
        S.rels.pop(parse_qname(raw), None)
    return True


def h_alter_table(S, f, line, T, M):
    m = RE_ALTER_TABLE.match(M)
    if not m:
        return None
    key = parse_qname(m.group('n'))
    rest = m.group('rest')
    rest = re.sub(r'\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b', ' NOFORCE_RLS ', rest, flags=re.I)
    if re.search(r'\bROW\s+LEVEL\s+SECURITY\b|\bNOFORCE_RLS\b', rest, re.I):
        clauses = list(RE_RLS_CLAUSE.finditer(rest))
        if not clauses:
            return False
        rel = get_rel(S, key, f, line)
        for c in clauses:
            k = (c.group('k') or 'NOFORCE_RLS').upper()
            if k == 'ENABLE':
                rel.rls = True
            elif k == 'DISABLE':
                rel.rls = False
            elif k == 'FORCE':
                rel.force_rls = True
            elif k == 'NOFORCE_RLS':
                rel.force_rls = False
        return True
    mr = re.search(r'\bRENAME\s+TO\s+(' + IDENT + ')', rest, re.I)
    if mr and not re.search(r'\bRENAME\s+(COLUMN|CONSTRAINT)\b', rest, re.I):
        old = S.rels.pop(key, None)
        if old:
            old.name = norm_ident(mr.group(1))
            S.rels[(old.schema, old.name)] = old
        return True
    ms = re.search(r'\bSET\s+SCHEMA\s+(' + IDENT + ')', rest, re.I)
    if ms:
        old = S.rels.pop(key, None)
        if old:
            old.schema = norm_ident(ms.group(1))
            S.rels[(old.schema, old.name)] = old
        return True
    return True  # some other ALTER TABLE: not security relevant


def parse_policy_parts(T, M, base):
    u = re.compile(r'\bUSING\s*\(', re.I).search(M, base)
    w = re.compile(r'\bWITH\s+CHECK\s*\(', re.I).search(M, base)
    first = min([x.start() for x in (u, w) if x] or [len(M)])
    header = M[base:first]
    out = {}
    ma = re.search(r'\bAS\s+(PERMISSIVE|RESTRICTIVE)\b', header, re.I)
    if ma:
        out['permissive'] = ma.group(1).upper() == 'PERMISSIVE'
    mf = re.search(r'\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b', header, re.I)
    if mf:
        out['cmd'] = mf.group(1).upper()
    mt = re.search(r'\bTO\s+(.+)$', header, re.I | re.S)
    if mt:
        out['roles'] = [norm_role(r) for r in split_top(mt.group(1))]
    if u:
        o = M.index('(', u.start())
        out['using'] = T[o + 1:balanced(M, o)]
    if w:
        o = M.index('(', w.start())
        out['check'] = T[o + 1:balanced(M, o)]
    return out


def h_policy(S, f, line, T, M):
    m = RE_CREATE_POLICY.match(M)
    if m:
        key = parse_qname(m.group('t'))
        rel = get_rel(S, key, f, line)
        parts = parse_policy_parts(T, M, m.end())
        pol = {'roles': parts.get('roles', ['public']), 'cmd': parts.get('cmd', 'ALL'),
               'permissive': parts.get('permissive', True), 'using': parts.get('using'),
               'check': parts.get('check'), 'file': f, 'line': line}
        rel.policies[norm_ident(m.group('p'))] = pol
        return True
    m = RE_ALTER_POLICY.match(M)
    if m:
        key = parse_qname(m.group('t'))
        rel = get_rel(S, key, f, line)
        name = norm_ident(m.group('p'))
        rn = re.match(r'\s*RENAME\s+TO\s+(' + IDENT + ')', M[m.end():], re.I)
        if rn:
            if name in rel.policies:
                rel.policies[norm_ident(rn.group(1))] = rel.policies.pop(name)
            return True
        if name not in rel.policies:
            rel.policies[name] = {'roles': ['public'], 'cmd': 'ALL', 'permissive': True,
                                  'using': None, 'check': None, 'file': f, 'line': line}
        parts = parse_policy_parts(T, M, m.end())
        pol = rel.policies[name]
        for k in ('roles', 'using', 'check'):
            if k in parts:
                pol[k] = parts[k]
        pol['file'], pol['line'] = f, line
        return True
    m = RE_DROP_POLICY.match(M)
    if m:
        rel = S.rels.get(parse_qname(m.group('t')))
        if rel:
            rel.policies.pop(norm_ident(m.group('p')), None)
        return True
    return None


def parse_target(obj):
    o = obj.strip()
    m = re.match(r'ALL\s+(TABLES|FUNCTIONS|ROUTINES|PROCEDURES|SEQUENCES)\s+IN\s+SCHEMA\s+(.+)$', o, re.I | re.S)
    if m:
        return 'all_' + m.group(1).lower(), [norm_ident(x) for x in split_top(m.group(2))]
    m = re.match(r'(TABLE|FUNCTION|ROUTINE|PROCEDURE|SEQUENCE|SCHEMA|DATABASE|DOMAIN|TYPE|LANGUAGE|FOREIGN\s+DATA\s+WRAPPER|FOREIGN\s+SERVER|LARGE\s+OBJECT|TABLESPACE|PARAMETER)\s+(.+)$', o, re.I | re.S)
    if m:
        return re.sub(r'\s+', ' ', m.group(1).lower()), split_top(m.group(2))
    return 'table', split_top(o)


def clean_roles(raw):
    raw = re.sub(r'\s+(WITH\s+GRANT\s+OPTION|WITH\s+ADMIN\s+OPTION|CASCADE|RESTRICT|GRANTED\s+BY\s+.+)\s*$', '', raw.strip(), flags=re.I | re.S)
    return [norm_role(r) for r in split_top(raw)]


def apply_func_priv(fn, role, is_grant):
    if role == 'public':
        fn.public_exec = is_grant
    elif role == 'anon':
        fn.anon_exec = is_grant
    elif role == 'authenticated':
        fn.auth_exec = is_grant


def h_grant(S, f, line, T, M):
    if not re.match(r'^\s*(GRANT|REVOKE)\b', M, re.I):
        return None
    m = RE_GRANT.match(M)
    if not m:
        # GRANT role TO role (membership) has no ON: not table-relevant
        if re.match(r'^\s*(GRANT|REVOKE)\b', M, re.I) and not re.search(r'\bON\b', M, re.I):
            return True
        return False
    is_grant = m.group('v').upper() == 'GRANT'
    ptoks = split_top(m.group('privs'))
    if any('(' in p for p in ptoks):
        S.notes.append("COV002 %s:%d column-level privilege not modeled" % (f, line))
    kind, names = parse_target(m.group('obj'))
    roles = clean_roles(m.group('roles'))
    if kind in ('table', 'all_tables'):
        privs = expand_privs(ptoks, True)
        if kind == 'table':
            targets = []
            for n in names:
                k = parse_qname(n)
                if k:
                    targets.append(get_rel(S, k, f, line))
        else:
            targets = [r for r in S.rels.values() if r.schema in names]
        for rel in targets:
            for r in roles:
                apply_table_priv(rel, r, privs, is_grant)
        return True
    if kind in ('function', 'routine', 'procedure', 'all_functions', 'all_routines', 'all_procedures'):
        privs = expand_privs(ptoks, False)
        if 'EXECUTE' not in privs:
            return True
        if kind.startswith('all_'):
            targets = [fn for fn in S.funcs.values() if fn.schema in names]
        else:
            targets = []
            for n in names:
                k = parse_qname(n.split('(')[0])
                # Match all overloads with the same (schema, name)
                targets.extend(fn for fkey, fn in S.funcs.items()
                               if fkey[0] == k[0] and fkey[1] == k[1])
        for fn in targets:
            for r in roles:
                apply_func_priv(fn, r, is_grant)
        return True
    return True  # sequences, schemas, etc.: not modeled, not security-critical for RLS


def h_default_privs(S, f, line, T, M):
    m = RE_ADP.match(M)
    if not m:
        return None
    body = m.group('body')
    scope = '*'
    ms = re.search(r'\bIN\s+SCHEMA\s+(' + IDENT + r'(?:\s*,\s*' + IDENT + ')*)', body, re.I)
    scopes = ['*']
    if ms:
        scopes = [norm_ident(x) for x in split_top(ms.group(1))]
    if re.search(r'\bFOR\s+(ROLE|USER)\b', body, re.I):
        S.notes.append("COV002 %s:%d ALTER DEFAULT PRIVILEGES ... FOR ROLE: applied as if for the migration role" % (f, line))
    mg = re.search(r'\b(GRANT|REVOKE)\s+(.+?)\s+ON\s+(TABLES|FUNCTIONS|ROUTINES|SEQUENCES|TYPES|SCHEMAS)\s+(TO|FROM)\s+(.+)$', body, re.I | re.S)
    if not mg:
        return False
    is_grant = mg.group(1).upper() == 'GRANT'
    obj = mg.group(3).upper()
    roles = clean_roles(mg.group(5))
    ptoks = split_top(mg.group(2))
    if obj == 'TABLES':
        privs = expand_privs(ptoks, True)
        for sc in scopes:
            S.tbl_default_events.append((sc, is_grant, privs, roles))
    elif obj in ('FUNCTIONS', 'ROUTINES'):
        for sc in scopes:
            S.fn_default_events.append((sc, is_grant, roles))
    return True


def analyze_body(S, fn, body_text):
    unsafe_vars = set()
    for _line, t, mm in statements(body_text):
        # Track variables constructed via concatenation or unsafe format()
        v_assign = re.search(r'\b([A-Za-z_]\w*)\s*(?::=|=)\s*(.+)$', t)
        if v_assign:
            v_name = v_assign.group(1).lower()
            rhs = v_assign.group(2)
            if '||' in rhs or (re.search(r'\bformat\s*\(', rhs, re.I) and '%s' in rhs):
                unsafe_vars.add(v_name)

        # Dynamic SQL detection
        if re.search(r'\bEXECUTE\b', mm, re.I):
            concat = '||' in mm
            fmt_unsafe = bool(re.search(r'\bformat\s*\(', mm, re.I)) and '%s' in t
            # Also catch EXECUTE var when var was constructed via concatenation
            m_var = re.search(r'\bEXECUTE\s+([A-Za-z_]\w*)', mm, re.I)
            var_unsafe = bool(m_var and m_var.group(1).lower() in unsafe_vars)
            if concat or fmt_unsafe or var_unsafe:
                safe_helpers = bool(re.search(r'quote_ident|quote_literal|quote_nullable|%I|%L', t, re.I))
                # If %s was used in format(), it is unsafe regardless of whether %I/%L was also used
                if '%s' in t and re.search(r'\bformat\s*\(', mm, re.I):
                    safe_helpers = False
                fn.dynamic.append((re.sub(r'\s+', ' ', t)[:120], safe_helpers))
        # Role switching detection (privilege escalation vector)
        if re.search(r'\bSET\s+(?:LOCAL\s+)?ROLE\b|\bSET\s+SESSION\s+AUTHORIZATION\b|\bRESET\s+ROLE\b', mm, re.I):
            fn.role_switch = True


def h_function(S, f, line, T, M):
    m = RE_CREATE_FUNC.match(M)
    if m:
        key = parse_qname(m.group('n'))
        open_paren = M.index('(', m.end() - 1)
        sig = extract_arg_types(M, open_paren)
        fn = Func(key[0], key[1], sig, f, line)
        old_args_end = balanced(M, open_paren)
        attrs = M[old_args_end:]
        fn.secdef = bool(re.search(r'\bSECURITY\s+DEFINER\b', attrs, re.I))
        sp_m = re.search(r'\bSET\s+search_path\s*(?:TO|=)\s*([^\n;]+)', T[old_args_end:], re.I)
        if sp_m:
            fn.search_path = True
            fn.search_path_val = sp_m.group(1).strip()
        else:
            fn.search_path = bool(re.search(r'\bSET\s+search_path\b', attrs, re.I))
        fn.is_trigger = bool(re.search(r'\bRETURNS\s+(event_)?trigger\b', attrs, re.I))
        fkey = (key[0], key[1], sig)
        for scope, is_grant, roles in S.fn_default_events:
            if scope in ('*', key[0]):
                for r in roles:
                    apply_func_priv(fn, r, is_grant)
        dq = re.search(r'(\$[A-Za-z_0-9]*\$)(.*?)\1', T[old_args_end:], re.S)
        body = dq.group(2) if dq else T[old_args_end:]
        analyze_body(S, fn, body)
        S.funcs[fkey] = fn
        return True
    m = RE_ALTER_FUNC.match(M)
    if m:
        key = parse_qname(m.group('n'))
        rest = M[m.end():]
        sp_alter = re.search(r'\bSET\s+search_path\s*(?:TO|=)\s*([^\n;]+)', T[m.end():], re.I)
        # ALTER without full signature: apply to all overloads (conservative)
        for fkey, fn in list(S.funcs.items()):
            if fkey[0] == key[0] and fkey[1] == key[1]:
                if re.search(r'\bSECURITY\s+DEFINER\b', rest, re.I):
                    fn.secdef = True
                if re.search(r'\bSECURITY\s+INVOKER\b', rest, re.I):
                    fn.secdef = False
                if sp_alter:
                    fn.search_path = True
                    fn.search_path_val = sp_alter.group(1).strip()
                elif re.search(r'\bSET\s+search_path\b', rest, re.I):
                    fn.search_path = True
                if re.search(r'\bRESET\s+(search_path|ALL)\b', rest, re.I):
                    fn.search_path = False
                    fn.search_path_val = ""
        return True
    m = RE_DROP_FUNC.match(M)
    if m:
        raw = m.group('n')
        qname = parse_qname(raw.split('(')[0])
        # If signature is provided, try to match the specific overload
        paren_m = re.search(r'\(', raw)
        if paren_m:
            full_start = m.start() + paren_m.start()
            # Find the open paren in M at or after full_start
            try:
                open_idx = M.index('(', full_start)
                sig = extract_arg_types(M, open_idx)
                S.funcs.pop((qname[0], qname[1], sig), None)
            except ValueError:
                # Fallback: drop all overloads
                for fkey in [k for k in S.funcs if k[0] == qname[0] and k[1] == qname[1]]:
                    S.funcs.pop(fkey)
        else:
            # No signature: drop all overloads (Postgres also errors on ambiguity,
            # but we err on the side of clearing the model)
            for fkey in [k for k in S.funcs if k[0] == qname[0] and k[1] == qname[1]]:
                S.funcs.pop(fkey)
        return True
    return None


def view_opts_invoker(text):
    m = re.search(r'security_invoker\s*(?:=\s*(\w+))?', text, re.I)
    if not m:
        return None
    v = (m.group(1) or 'true').lower()
    return v in ('true', 'on', '1', 'yes', 't')


def h_view(S, f, line, T, M):
    m = RE_CREATE_VIEW.match(M)
    if m:
        key = parse_qname(m.group('n'))
        kind = 'matview' if m.group('m') else 'view'
        ma = re.search(r'\bAS\b', M[m.end():], re.I)
        head = M[m.end():m.end() + ma.start()] if ma else M[m.end():]
        opt = None
        mw = re.search(r'\bWITH\s*\(([^)]*)\)', head, re.I)
        if mw:
            opt = view_opts_invoker(mw.group(1))
        prev = S.rels.get(key)
        rel = new_rel(S, kind, key, f, line)
        if prev and prev.kind == kind:
            rel.grants = prev.grants
            rel.invoker = prev.invoker
        if opt is not None:
            rel.invoker = opt
        return True
    m = RE_ALTER_VIEW.match(M)
    if m:
        rel = S.rels.get(parse_qname(m.group('n')))
        rest = m.group('rest')
        mo = re.match(r'(SET|RESET)\s*\(([^)]*)\)', rest, re.I)
        if rel and mo:
            if mo.group(1).upper() == 'SET':
                v = view_opts_invoker(mo.group(2))
                if v is not None:
                    rel.invoker = v
            elif re.search(r'security_invoker', mo.group(2), re.I):
                rel.invoker = False
        return True
    return None


UNTRUSTED_EXT = {'plpython3u', 'plpythonu', 'plperlu', 'plr', 'plsh'}
NETWORK_EXT = {'http', 'pg_net', 'dblink', 'postgres_fdw', 'pg_cron'}


def h_role(S, f, line, T, M):
    m = RE_ROLE.match(M)
    if not m:
        return None
    rname = norm_role(m.group('r'))
    rest = m.group('rest')
    if re.search(r'\b(BYPASSRLS|SUPERUSER)\b', rest, re.I) and not re.search(r'\bNO(BYPASSRLS|SUPERUSER)\b', rest, re.I):
        bad_attr = "SUPERUSER" if re.search(r'\bSUPERUSER\b', rest, re.I) else "BYPASSRLS"
        S.add('HIGH', 'ROL001', "Dangerous privilege %s granted to role '%s'" % (bad_attr, rname),
              "Role '%s' was granted %s, allowing queries under this role to bypass Row Level Security entirely." % (rname, bad_attr),
              f, line, "ALTER ROLE %s NOBYPASSRLS NOSUPERUSER;" % rname)
    return True


def h_extension(S, f, line, T, M):
    m = RE_EXTENSION.match(M)
    if not m:
        return None
    ext = norm_ident(m.group('ext'))
    if ext in UNTRUSTED_EXT:
        S.add('HIGH', 'EXT001', "Untrusted language extension '%s' installed" % ext,
              "Untrusted language extensions execute arbitrary system code with the Postgres server OS user permissions.",
              f, line, "Do not install untrusted procedural languages in production Supabase databases.")
    elif ext in NETWORK_EXT:
        S.add('MEDIUM', 'EXT001', "Extension '%s' enabled with network/scheduling capabilities" % ext,
              "This extension allows functions to initiate outbound network calls or schedule background jobs.",
              f, line, "Revoke execute permissions on extension functions from API roles (anon/authenticated).")
    return True


HANDLERS = [
    # (loose family pattern, handler). Loose match + handler False => unparsed (COV001)
    (re.compile(r'^\s*CREATE\s+(?:OR\s+REPLACE\s+)?POLICY\b|^\s*ALTER\s+POLICY\b|^\s*DROP\s+POLICY\b', re.I), h_policy),
    (re.compile(r'^\s*(GRANT|REVOKE)\b', re.I), h_grant),
    (re.compile(r'^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b', re.I), h_default_privs),
    (re.compile(r'^\s*ALTER\s+TABLE\b', re.I), h_alter_table),
    (re.compile(r'^\s*CREATE\s+(?:[A-Z]+\s+){0,3}TABLE\b', re.I), h_create_table),
    (re.compile(r'^\s*DROP\s+(?:MATERIALIZED\s+)?(TABLE|VIEW)\b', re.I), h_drop),
    (re.compile(r'^\s*(CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)|DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE))\b', re.I), h_function),
    (re.compile(r'^\s*(CREATE\s+(?:OR\s+REPLACE\s+)?(?:\w+\s+){0,2}VIEW|ALTER\s+(?:MATERIALIZED\s+)?VIEW)\b', re.I), h_view),
    (re.compile(r'^\s*(?:CREATE|ALTER)\s+(?:ROLE|USER)\b', re.I), h_role),
    (re.compile(r'^\s*CREATE\s+EXTENSION\b', re.I), h_extension),
]


def process_file(S, path, display):
    with open(path, 'r', encoding='utf-8', errors='strict') as fh:
        sql = fh.read()
    total = modeled = 0
    for line, t, m in statements(sql):
        total += 1
        for loose, handler in HANDLERS:
            if loose.match(m):
                res = handler(S, display, line, t, m)
                if res is True:
                    modeled += 1
                elif res is False or res is None:
                    S.unparsed.append({"file": display, "line": line, "stmt": re.sub(r'\s+', ' ', t)[:140]})
                break
        else:
            # No handler family matched this statement.
            # Flag it if it belongs to a security-relevant family we don't model.
            if SECURITY_RELEVANT_UNHANDLED.match(m):
                S.unparsed.append({"file": display, "line": line, "stmt": re.sub(r'\s+', ' ', t)[:140],
                                   "reason": "security-relevant statement type not modeled"})
    return total, modeled


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------
def norm_expr(e):
    e = re.sub(r'\s+', '', (e or '').lower())
    while e.startswith('(') and e.endswith(')') and balanced(e, 0) == len(e) - 1:
        e = e[1:-1]
    return e


def is_true(e):
    """Detect expressions that are unconditionally true (tautologies).
    Operates on the whitespace-stripped, lowered, outer-paren-stripped form."""
    if e is None:
        return False
    n = norm_expr(e)
    # --- fixed known tautologies ---
    if n in _TAUTOLOGIES:
        return True
    # --- N = N  where N is any integer literal ---
    if re.match(r'^(\d+)=\1$', n):
        return True
    # --- 'str' = 'str'  where str is any identical quoted string ---
    if re.match(r"^('(?:[^']|'')*')=\1$", n):
        return True
    # --- ident = ident  (same column on both sides, e.g. id = id) ---
    if re.match(r'^([a-z_]\w*)=\1$', n):
        return True
    # --- coalesce(true,...) / coalesce('t',...) ---
    if re.match(r"^coalesce\((?:true|'t'),", n):
        return True
    return False


_TAUTOLOGIES = frozenset({
    'true', '1=1', '0=0', '2=2',
    '1<>0', '0<>1', '1!=0', '0!=1',
    'selecttrue', '(selecttrue)',
    'trueandtrue', 'trueortrue', 'trueorfalse', 'falseortrue',
    'notfalse',
    '1=1or1=2', '1=1or0=1',
    'null is null', 'nullisnull',
})


AUTH_RE = re.compile(r'\bauth\s*\.\s*(uid|jwt|role|email)\s*\(|current_setting\s*\(', re.I)


def visible_privs(rel):
    out = {}
    for r in ('anon', 'authenticated', 'public'):
        g = rel.grants.get(r)
        if g and g['privs']:
            out[r] = sorted(g['privs'])
    return out


def run_rules(S):
    unknown_grant_tables = []
    for rel in S.rels.values():
        exposed = rel.schema in S.exposed
        if rel.kind == 'table' and not rel.external and exposed:
            vp = visible_privs(rel)
            anon_known = rel.grants.get('anon', {}).get('known')
            auth_known = rel.grants.get('authenticated', {}).get('known')
            if not rel.rls:
                if vp:
                    sev = 'HIGH'
                    why = "API roles hold privileges in the migrations: %s." % "; ".join("%s=%s" % (k, ",".join(v)) for k, v in vp.items())
                elif anon_known and auth_known:
                    sev = 'MEDIUM'
                    why = "anon/authenticated have no grants in the migrations, so access depends on grants alone."
                else:
                    sev = 'HIGH'
                    why = "No evidence in the migrations that anon/authenticated lack access (Supabase default privileges normally grant them access to new tables)."
                S.add(sev, 'RLS001', "RLS not enabled on %s" % rel.fq, why, rel.file, rel.line,
                      "ALTER TABLE %s ENABLE ROW LEVEL SECURITY; then add explicit policies." % rel.fq)
                if rel.policies:
                    S.add('HIGH', 'RLS003', "Policies on %s are NOT enforced (RLS is off)" % rel.fq,
                          "%d policy(ies) exist but have no effect while RLS is disabled." % len(rel.policies),
                          rel.file, rel.line, "Enable RLS on the table.")
            elif not rel.policies:
                S.add('INFO', 'RLS002', "RLS on, no policies on %s" % rel.fq,
                      "Deny-all for non-owner roles. Fine if only the service role / backend uses it; a bug if users should reach it.",
                      rel.file, rel.line, "")
            for role in ('anon', 'public'):
                g = rel.grants.get(role)
                if g and (g['privs'] & WRITE_T) and rel.rls:
                    S.add('MEDIUM', 'GRT002', "%s has write privileges on %s" % (role, rel.fq),
                          "Granted: %s. Only RLS stands between anonymous callers and writes." % ",".join(sorted(g['privs'] & WRITE_T)),
                          rel.file, rel.line, "REVOKE write privileges from %s unless anonymous writes are intended." % role)
            for role in API_ROLES + ('public',):
                g = rel.grants.get(role)
                if g and 'TRUNCATE' in g['privs']:
                    S.add('HIGH', 'GRT001', "%s can TRUNCATE %s (RLS does not apply to TRUNCATE)" % (role, rel.fq),
                          "TRUNCATE bypasses row level security entirely.", rel.file, rel.line,
                          "REVOKE TRUNCATE ON %s FROM %s;" % (rel.fq, role))
            if not (anon_known and auth_known):
                unknown_grant_tables.append(rel.fq)
        # policies
        if rel.kind == 'table':
            for pname, pol in rel.policies.items():
                roles = set(pol['roles'])
                writes = pol['cmd'] in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
                exprs = [e for e in (pol['using'], pol['check']) if e is not None]
                alltext = " ".join(exprs)
                reaches_anon = bool(roles & {'anon', 'public'})
                title = "policy \"%s\" on %s" % (pname, rel.fq)
                trivially_open = pol['permissive'] and any(is_true(e) for e in exprs)
                if trivially_open:
                    sev = 'HIGH' if writes else 'MEDIUM'
                    S.add(sev, 'POL001', "Always-true %s" % title,
                          "cmd=%s roles=%s expression is literally true: every row is allowed for those roles%s." % (pol['cmd'], ",".join(sorted(roles)), "" if writes else " (fine only if this data is meant to be public)"),
                          pol['file'], pol['line'], "Replace with an ownership/tenant check, e.g. (select auth.uid()) = user_id.")
                elif writes and reaches_anon and pol['permissive'] and not AUTH_RE.search(alltext):
                    S.add('HIGH', 'POL002', "Anonymous write path via %s" % title,
                          "cmd=%s applies to %s and the expression never checks auth.uid()/auth.jwt()." % (pol['cmd'], ",".join(sorted(roles))),
                          pol['file'], pol['line'], "Add TO authenticated and an ownership check.")
                # POL005: auth check present but proves identity, not ownership
                if writes and pol['permissive'] and AUTH_RE.search(alltext):
                    weak_patterns = []
                    if re.search(r'\bauth\s*\.\s*uid\s*\(\s*\)\s+IS\s+NOT\s+NULL\b', alltext, re.I):
                        weak_patterns.append('auth.uid() IS NOT NULL')
                    if re.search(r'\(\s*select\s+auth\s*\.\s*uid\s*\(\s*\)\s*\)\s+IS\s+NOT\s+NULL\b', alltext, re.I):
                        weak_patterns.append('(select auth.uid()) IS NOT NULL')
                    if re.search(r'\bauth\s*\.\s*role\s*\(\s*\)\s*=\s*\'authenticated\'', alltext, re.I):
                        weak_patterns.append("auth.role() = 'authenticated'")
                    if re.search(r'\bauth\s*\.\s*jwt\s*\(\s*\)\s*(?:->>?|#>>?)\s*[\'"]?(?:role|aud)\b', alltext, re.I):
                        weak_patterns.append('JWT role/aud claim (user-controllable in some configurations)')
                    if weak_patterns:
                        S.add('MEDIUM', 'POL005', "Weak auth check in %s" % title,
                              "cmd=%s — checks prove the caller is authenticated but do NOT verify row ownership: %s. "
                              "Any logged-in user can access every row." % (pol['cmd'], "; ".join(weak_patterns)),
                              pol['file'], pol['line'],
                              "Add an ownership predicate, e.g. (select auth.uid()) = user_id.")
                # POL006: current_user / session_user in Supabase is the internal
                # Postgres role ('authenticator'), not the end user — almost always a bug.
                if re.search(r'\b(current_user|session_user|current_role)\b', alltext, re.I):
                    S.add('HIGH', 'POL006', "current_user/session_user used in %s" % title,
                          "In Supabase, current_user evaluates to the internal Postgres role (e.g. 'authenticator'), "
                          "NOT the API caller. This policy likely does not do what was intended.",
                          pol['file'], pol['line'],
                          "Use auth.uid() for user identity or auth.role() for the Supabase role name.")
                if re.search(r'user_metadata|raw_user_meta_data', alltext, re.I):
                    S.add('HIGH', 'POL003', "User-editable metadata used in %s" % title,
                          "user_metadata / raw_user_meta_data can be changed by the user themself; it must not drive authorization.",
                          pol['file'], pol['line'], "Use app_metadata (server-set) or a roles table.")
                if rel.schema == 'storage' and rel.name == 'objects' and not re.search(r'\bbucket_id\b', alltext, re.I):
                    S.add('MEDIUM', 'POL004', "Storage %s does not restrict bucket_id" % title,
                          "It applies to objects in every bucket.", pol['file'], pol['line'],
                          "Add bucket_id = '<bucket>' to the expression.")
        # Check for exposure of internal auth tables
        if rel.schema == 'auth':
            for role in API_ROLES + ('public',):
                g = rel.grants.get(role)
                if g and g['privs']:
                    S.add('HIGH', 'AUT001', "Internal auth table %s granted to API role '%s'" % (rel.fq, role),
                          "Granted: %s. Exposing auth schema tables allows API callers to access password hashes, tokens, or security logs." %
                          ",".join(sorted(g['privs'])),
                          rel.file, rel.line, "REVOKE ALL ON %s FROM %s;" % (rel.fq, role))
        if rel.kind == 'table' and not rel.external and exposed:
            if rel.rls and not rel.force_rls:
                S.add('INFO', 'RLS004', "RLS on %s does not enforce FORCE ROW LEVEL SECURITY" % rel.fq,
                      "Table owners and superusers bypass RLS by default. If your backend service connects as table owner, RLS is bypassed.",
                      rel.file, rel.line, "ALTER TABLE %s FORCE ROW LEVEL SECURITY;" % rel.fq)
        if rel.kind == 'view' and exposed and not rel.invoker:
            S.add('MEDIUM', 'VEW001', "View %s runs as its owner (bypasses RLS of underlying tables)" % rel.fq,
                  "Views are security_definer-like by default.", rel.file, rel.line,
                  "CREATE VIEW ... WITH (security_invoker = true) (Postgres 15+) or move it out of the exposed schema.")
        if rel.kind == 'matview' and exposed:
            vp = visible_privs(rel)
            S.add('MEDIUM' if vp else 'LOW', 'VEW002', "Materialized view %s in exposed schema" % rel.fq,
                  "Materialized views ignore RLS. Visible grants: %s." % (vp or "none seen in migrations"),
                  rel.file, rel.line, "Move out of the exposed schema or REVOKE API role access.")
    if unknown_grant_tables:
        S.add('INFO', 'GRT003', "%d table(s) with no explicit grant/revoke state for anon/authenticated" % len(unknown_grant_tables),
              "Effective access depends on default privileges outside these files: " + ", ".join(unknown_grant_tables[:15]) +
              (" ..." if len(unknown_grant_tables) > 15 else ""),
              "-", 0, "Run references/live-checks.sql in the Supabase SQL editor to see the real grants.")
    for fn in S.funcs.values():
        if fn.secdef and not fn.search_path:
            S.add('HIGH', 'FUN001', "SECURITY DEFINER function %s has no SET search_path" % fn.fq,
                  "A caller can shadow objects via search_path and run code with the owner's privileges.",
                  fn.file, fn.line, "Add SET search_path = '' (and schema-qualify every object inside).")
        elif fn.secdef and fn.search_path and fn.search_path_val:
            if re.search(r'\b(public|"\$user"|\$user)\b', fn.search_path_val, re.I):
                S.add('HIGH', 'FUN005', "Unsafe search_path in SECURITY DEFINER function %s" % fn.fq,
                      "search_path is set to '%s' which includes user-writable schemas (public/$user). Callers can shadow objects and hijack execution." % fn.search_path_val,
                      fn.file, fn.line, "Change to SET search_path = '' (or pg_catalog, pg_temp) and schema-qualify all object references inside the function body.")
        if fn.secdef and fn.schema in S.exposed and not fn.is_trigger and not (fn.public_exec is False and fn.anon_exec is False):
            S.add('MEDIUM', 'FUN002', "SECURITY DEFINER function %s may be callable by anon via the API" % fn.fq,
                  "No REVOKE of EXECUTE from both PUBLIC and anon found in the migrations.",
                  fn.file, fn.line, "REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated (or move to a private schema).")
        for snippet, safe in fn.dynamic:
            if fn.secdef and not safe:
                sev = 'HIGH'
            elif not safe:
                sev = 'MEDIUM'
            elif fn.secdef:
                sev = 'LOW'
            else:
                continue
            S.add(sev, 'FUN003', "Dynamic SQL in %s" % fn.fq,
                  "EXECUTE with string building%s: %s" % (" (quote helper seen - verify every value is quoted)" if safe else " and no quote_ident/quote_literal/%I/%L/USING", snippet),
                  fn.file, fn.line, "Use format('%I'/'%L') or EXECUTE ... USING $1 and avoid raw concatenation.")
        if fn.role_switch:
            sev = 'HIGH' if fn.secdef else 'MEDIUM'
            S.add(sev, 'FUN004', "SET ROLE / SET SESSION AUTHORIZATION in %s" % fn.fq,
                  "The function switches Postgres roles at runtime%s. "
                  "This can escalate privileges if the target role is not carefully validated." %
                  (" and runs as SECURITY DEFINER (owner privileges)" if fn.secdef else ""),
                  fn.file, fn.line,
                  "Audit the role target; prefer passing identity via function arguments rather than switching roles.")
    for u in S.unparsed:
        if u.get('reason'):
            S.add('HIGH', 'COV003', u['reason'],
                  u['stmt'], u['file'], u['line'],
                  "This statement type can affect security but is not modeled by the auditor. Review by hand.")
        else:
            S.add('HIGH', 'COV001', "Statement NOT understood by the auditor (coverage gap)",
                  u['stmt'], u['file'], u['line'], "Review this statement by hand; the audit result is incomplete.")
    for n in S.notes:
        S.add('INFO', 'COV002', n.split(' ', 1)[1], "Construct not fully modeled.", "-", 0, "")


# --------------------------------------------------------------------------
# File discovery and CLI
# --------------------------------------------------------------------------
def discover(paths):
    found = []
    for p in paths:
        if os.path.isfile(p):
            found.append(p)
        elif os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
                for fn in sorted(files):
                    if fn.lower().endswith('.sql'):
                        found.append(os.path.join(root, fn))
        else:
            print("ERROR: path not found: %s" % p, file=sys.stderr)
            sys.exit(2)
    seen, out = set(), []
    for x in sorted(found):
        r = os.path.realpath(x)
        if r not in seen:
            seen.add(r); out.append(x)
    return out


def audit(paths, exposed):
    S = State(exposed)
    files = discover(paths)
    report = {"tool": "rls_audit", "version": VERSION, "exposed_schemas": sorted(exposed),
              "files": [], "files_found": len(files), "files_read": 0, "files_failed": []}
    for path in files:
        try:
            total, modeled = process_file(S, path, os.path.relpath(path))
            report["files"].append({"file": os.path.relpath(path), "statements": total, "security_modeled": modeled})
            report["files_read"] += 1
        except Exception as exc:  # unreadable or undecodable: never skip silently
            report["files_failed"].append({"file": os.path.relpath(path), "error": str(exc)})
    run_rules(S)
    S.findings.sort(key=lambda x: (SEV_ORDER[x["severity"]], x["code"], x["file"], x["line"]))
    report["findings"] = S.findings
    report["unparsed"] = len(S.unparsed)
    return report


def exit_code(report):
    if report["files_found"] == 0 or report["files_failed"] or report["unparsed"]:
        return 2
    return 1 if any(f["severity"] == "HIGH" for f in report["findings"]) else 0


def print_report(report):
    print("RLS AUDIT v%s  (read-only, static, no network)" % VERSION)
    print("Exposed schemas assumed: %s" % ", ".join(report["exposed_schemas"]))
    print("\nFILES (%d found, %d read, %d failed)" % (report["files_found"], report["files_read"], len(report["files_failed"])))
    for fl in report["files"]:
        print("  [read] %s  statements=%d  security-modeled=%d" % (fl["file"], fl["statements"], fl["security_modeled"]))
    for fl in report["files_failed"]:
        print("  [FAILED] %s  %s" % (fl["file"], fl["error"]))
    counts = {}
    for f in report["findings"]:
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1
    print("\nFINDINGS: " + (", ".join("%s=%d" % (k, counts[k]) for k in SEV_ORDER if k in counts) or "none"))
    for f in report["findings"]:
        loc = "%s:%d" % (f["file"], f["line"]) if f["file"] != "-" else "(project-wide)"
        print("\n[%s] %s  %s" % (f["severity"], f["code"], f["title"]))
        print("   at %s" % loc)
        print("   %s" % f["detail"])
        if f["fix"]:
            print("   fix: %s" % f["fix"])
    print("\nCOVERAGE")
    print("  files_found=%d files_read=%d files_failed=%d unparsed_statements=%d"
          % (report["files_found"], report["files_read"], len(report["files_failed"]), report["unparsed"]))
    code = exit_code(report)
    verdict = {0: "COMPLETE - no HIGH findings (this is NOT proof of security; see limitations)",
               1: "COMPLETE - HIGH findings present",
               2: "INCOMPLETE - coverage problem; do not treat any 'clean' result as valid"}[code]
    print("  verdict: %s" % verdict)
    print("\nLIMITATIONS: static analysis of the files only. Cannot see the live database, default privileges set outside")
    print("these files, overloaded function signatures, roles other than anon/authenticated/public, or runtime logic inside")
    print("policy expressions. Confirm with references/live-checks.sql and the Supabase Security Advisor.")


def self_test():
    here = os.path.dirname(os.path.abspath(__file__))
    fixture = os.path.join(here, '..', 'tests', 'sample_bad.sql')
    expected_file = os.path.join(here, '..', 'tests', 'expected_codes.txt')
    if os.path.isfile(fixture) and os.path.isfile(expected_file):
        with open(expected_file) as fh:
            expected = sorted(l.strip() for l in fh if l.strip() and not l.startswith('#'))
        report = audit([fixture], {'public', 'storage'})
        got = sorted("%s" % f["code"] for f in report["findings"] if f["severity"] != "INFO")
        if got == expected and report["unparsed"] == 0 and not report["files_failed"]:
            print("SELF-TEST PASSED (%d expected findings reproduced)" % len(expected))
            return 0
        print("SELF-TEST FAILED")
        print("expected:", expected)
        print("got:     ", got)
        return 2

    # Standalone built-in self-test suite (runs without external test files)
    import tempfile
    test_sql = (
        "CREATE TABLE public.t1 (id int);\n"
        "GRANT SELECT ON public.t1 TO anon;\n"
        "ALTER TABLE public.t1 ENABLE ROW LEVEL SECURITY;\n"
        "CREATE POLICY \"p1\" ON public.t1 FOR ALL TO public USING (1 = 1);\n"
        "CREATE POLICY \"p2\" ON public.t1 FOR ALL TO public USING (auth.uid() IS NOT NULL);\n"
        "CREATE POLICY \"p3\" ON public.t1 FOR SELECT TO authenticated USING (current_user = 'bob');\n"
        "CREATE FUNCTION public.f_sec() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END; $$;\n"
        "CREATE FUNCTION public.f_bad_sp() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN NULL; END; $$;\n"
        "ALTER ROLE anon BYPASSRLS;\n"
        "CREATE EXTENSION http;\n"
        "GRANT SELECT ON auth.users TO anon;\n"
        "CREATE TRIGGER tr_test AFTER INSERT ON public.t1 EXECUTE FUNCTION f_sec();\n"
    )
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as tf:
        tf.write(test_sql)
        tf_name = tf.name
    try:
        report = audit([tf_name], {'public'})
        got_codes = set(f["code"] for f in report["findings"])
        required = {'POL001', 'POL005', 'POL006', 'FUN001', 'FUN005', 'ROL001', 'EXT001', 'AUT001', 'COV003'}
        missing = required - got_codes
        if not missing and report["unparsed"] > 0:
            print("BUILT-IN SELF-TEST PASSED (%d findings verified: %s)" % (len(required), ", ".join(sorted(required))))
            return 0
        else:
            print("BUILT-IN SELF-TEST FAILED: missing codes %s" % sorted(missing))
            return 2
    finally:
        try:
            os.remove(tf_name)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description="Deterministic static RLS / privilege audit for Postgres & Supabase SQL files.")
    ap.add_argument("paths", nargs="*", help="directories or .sql files (e.g. supabase/migrations)")
    ap.add_argument("--exposed", default="public", help="comma-separated schemas exposed via the API (default: public)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--self-test", action="store_true", help="run against the bundled sample to prove the auditor works")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    if not args.paths:
        ap.error("give at least one path, e.g. supabase/migrations")
    report = audit(args.paths, set(x.strip().lower() for x in args.exposed.split(",") if x.strip()))
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    sys.exit(exit_code(report))


if __name__ == "__main__":
    main()
