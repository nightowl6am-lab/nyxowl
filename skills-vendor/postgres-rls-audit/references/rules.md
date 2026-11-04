# PostgreSQL / Supabase Audit Rule Reference

Reference documentation for all finding codes emitted by `rls_audit.py`.

---

## 1. Row Level Security (`RLS*`)

### `RLS001` — RLS Not Enabled on Exposed Table
- **Severity**: `HIGH` if API roles hold privileges or grants are unknown; `MEDIUM` if no grants found in migrations.
- **Why**: Exposed schemas (like `public`) are directly queryable by clients in Supabase. Without RLS, any caller holding SELECT/INSERT/UPDATE/DELETE privileges can access all rows.
- **Remediation**:
  ```sql
  ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
  ```

### `RLS002` — RLS On, No Policies Defined
- **Severity**: `INFO`
- **Why**: An RLS-enabled table with no policies acts as a deny-all for non-owner roles. This is standard for internal/service-only tables, but a bug if frontend users are expected to read or write data.

### `RLS003` — Policies Exist But RLS is Off
- **Severity**: `HIGH`
- **Why**: Policies defined via `CREATE POLICY` have **zero effect** until `ENABLE ROW LEVEL SECURITY` is run. The table remains completely unprotected.
- **Remediation**:
  ```sql
  ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
  ```

### `RLS004` — RLS On But FORCE ROW LEVEL SECURITY Not Set
- **Severity**: `INFO`
- **Why**: By default in PostgreSQL, table owners and superusers bypass RLS. If backend services connect as the table owner (often `postgres`), RLS policies are skipped.
- **Remediation**:
  ```sql
  ALTER TABLE public.<table_name> FORCE ROW LEVEL SECURITY;
  ```

---

## 2. Table Grants & Privilege Escalation (`GRT*`)

### `GRT001` — TRUNCATE Privilege Granted to API Role
- **Severity**: `HIGH`
- **Why**: In PostgreSQL, `TRUNCATE` completely bypasses Row Level Security. Any role with `TRUNCATE` can wipe the entire table even with strict policies in place.
- **Remediation**:
  ```sql
  REVOKE TRUNCATE ON public.<table_name> FROM anon, authenticated, public;
  ```

### `GRT002` — Write Privileges Granted to Anon/Public
- **Severity**: `MEDIUM`
- **Why**: Grants `INSERT`, `UPDATE`, or `DELETE` to unauthenticated callers. If policies are ever misconfigured, anonymous users can modify data.
- **Remediation**:
  ```sql
  REVOKE INSERT, UPDATE, DELETE ON public.<table_name> FROM anon, public;
  ```

### `GRT003` — No Explicit Migration Grants
- **Severity**: `INFO`
- **Why**: Migrations do not explicitly grant or revoke access; effective permissions depend on database defaults.

---

## 3. Auth Schema Protection (`AUT*`)

### `AUT001` — Internal Auth Table Granted to API Role
- **Severity**: `HIGH`
- **Why**: Tables in the `auth` schema (`auth.users`, `auth.identities`, `auth.sessions`, `auth.mfa_factors`) contain password hashes, confirmation tokens, phone numbers, and secrets.
- **Remediation**:
  ```sql
  REVOKE ALL ON auth.users FROM anon, authenticated, public;
  ```
  Instead, expose non-sensitive profile columns via a dedicated `public.profiles` table synced via triggers.

---

## 4. Role Privileges (`ROL*`)

### `ROL001` — Dangerous Privilege (BYPASSRLS / SUPERUSER) on Role
- **Severity**: `HIGH`
- **Why**: Assigning `BYPASSRLS` or `SUPERUSER` to any API role disables all RLS project-wide for that role.
- **Remediation**:
  ```sql
  ALTER ROLE <role_name> NOBYPASSRLS NOSUPERUSER;
  ```

---

## 5. Extensions (`EXT*`)

### `EXT001` — Dangerous or Network-Capable Extension Installed
- **Severity**: `HIGH` for untrusted languages (`plpython3u`, `plperlu`, `plsh`); `MEDIUM` for network extensions (`http`, `pg_net`, `dblink`, `postgres_fdw`, `pg_cron`).
- **Why**: Allows database functions to initiate outbound HTTP requests or execute operating system commands.
- **Remediation**: Revoke function execute privileges from `anon` and `authenticated`.

---

## 6. Policies (`POL*`)

### `POL001` — Tautology / Always-True Policy
- **Severity**: `HIGH` on write operations; `MEDIUM` on SELECT.
- **Why**: Expressions like `USING (true)`, `USING (1 = 1)`, `USING (0 = 0)`, or `WITH CHECK (id = id)` allow every row unconditionally.
- **Remediation**: Replace with an ownership predicate:
  ```sql
  CREATE POLICY "Users can access own data" ON public.<table_name>
    FOR ALL TO authenticated
    USING ((select auth.uid()) = user_id)
    WITH CHECK ((select auth.uid()) = user_id);
  ```

### `POL002` — Anonymous Write Path Without Auth Check
- **Severity**: `HIGH`
- **Why**: An `INSERT`, `UPDATE`, or `DELETE` policy applies to `public` or `anon` without referencing `auth.uid()`.
- **Remediation**: Change `TO public` to `TO authenticated`.

### `POL003` — User-Editable Metadata in Policy
- **Severity**: `HIGH`
- **Why**: `raw_user_meta_data` / `user_metadata` can be edited by the user themself via `supabase.auth.updateUser()`. It must never be used for access control (e.g. checking `role = 'admin'`).
- **Remediation**: Use `app_metadata` (server-managed) or a dedicated database roles table.

### `POL004` — Storage Objects Policy Missing bucket_id
- **Severity**: `MEDIUM`
- **Why**: Policies on `storage.objects` without `bucket_id = '<name>'` apply to all buckets across the project.
- **Remediation**: Add `AND bucket_id = 'my_bucket'` to the condition.

### `POL005` — Weak Auth Check (Identity Proved, Ownership Not Verified)
- **Severity**: `MEDIUM`
- **Why**: Checking `auth.uid() IS NOT NULL` or `auth.role() = 'authenticated'` proves the user is logged in, but permits them to read or write *every other user's* rows.
- **Remediation**: Check row ownership: `(select auth.uid()) = user_id`.

### `POL006` — current_user / session_user Used in Policy
- **Severity**: `HIGH`
- **Why**: In Supabase connection poolers, `current_user` evaluates to the internal Postgres role (`authenticator`), not the API caller.
- **Remediation**: Use `auth.uid()` or `auth.role()`.

---

## 7. Functions (`FUN*`)

### `FUN001` — SECURITY DEFINER Function Missing SET search_path
- **Severity**: `HIGH`
- **Why**: `SECURITY DEFINER` executes with the owner's privileges. Without an explicit `SET search_path = ''`, an attacker can shadow objects or operators via `search_path` manipulation (Postgres CVE-2018-1058).
- **Remediation**:
  ```sql
  CREATE OR REPLACE FUNCTION public.my_func()
  RETURNS void LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
  AS $$ ... $$;
  ```

### `FUN002` — SECURITY DEFINER Function Callable by Anon
- **Severity**: `MEDIUM`
- **Why**: In Postgres, new functions grant `EXECUTE` to `PUBLIC` by default.
- **Remediation**:
  ```sql
  REVOKE EXECUTE ON FUNCTION public.my_func FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.my_func TO authenticated;
  ```

### `FUN003` — Dynamic SQL with Concatenation
- **Severity**: `HIGH` (in SECURITY DEFINER); `MEDIUM` otherwise.
- **Why**: `EXECUTE` with string concatenation (`||`) or `%s` in `format()` is vulnerable to SQL injection.
- **Remediation**: Use `format('%I', identifier)`, `format('%L', literal)`, or `EXECUTE ... USING param`.

### `FUN004` — SET ROLE Inside Function
- **Severity**: `HIGH` (in SECURITY DEFINER); `MEDIUM` otherwise.
- **Why**: Runtime role switching allows escalation of privileges.

### `FUN005` — Unsafe search_path in SECURITY DEFINER Function
- **Severity**: `HIGH`
- **Why**: `SET search_path = public` or `"$user", public` still includes user-writable schemas.
- **Remediation**: Change to `SET search_path = ''` (empty string) and schema-qualify all references.

---

## 8. Views (`VEW*`)

### `VEW001` — View Runs as Owner (Missing security_invoker)
- **Severity**: `MEDIUM`
- **Why**: Standard PostgreSQL views run as the view owner, bypassing RLS of underlying tables.
- **Remediation**:
  ```sql
  CREATE VIEW public.my_view WITH (security_invoker = true) AS ...;
  ```

### `VEW002` — Materialized View in Exposed Schema
- **Severity**: `MEDIUM` if visible grants; `LOW` otherwise.
- **Why**: Materialized views do not support Row Level Security.
- **Remediation**: Move materialized views to a private schema or revoke access from API roles.

---

## 9. Coverage Gaps (`COV*`)

- **`COV001`**: Statement matched loose pattern but failed strict parsing.
- **`COV002`**: Construct not fully modeled (e.g. column-level grants).
- **`COV003`**: Security-relevant statement not modeled (triggers, rules, anonymous blocks, copy commands).
