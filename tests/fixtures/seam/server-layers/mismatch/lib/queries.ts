import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_KEY ?? "");

export async function rows(): Promise<unknown> {
  const result = await supabase.from("missing_table").select("id");
  return result.data ?? [];
}

export async function loginCount(): Promise<number> {
  const { count } = await supabase.rpc("nonexistent_rpc");
  return count ?? 0;
}
