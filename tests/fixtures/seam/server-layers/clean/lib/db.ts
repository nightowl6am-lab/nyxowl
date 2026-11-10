import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_KEY ?? "",
);

export async function listUsers(): Promise<unknown> {
  const result = await supabase.from("users").select("id,display_name");
  return result.data ?? [];
}

export async function userCount(): Promise<number> {
  const { count } = await supabase.rpc("get_user_count");
  return count ?? 0;
}
