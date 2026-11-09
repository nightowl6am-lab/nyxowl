"use server";

export async function loadUser(id: string): Promise<unknown> {
  const client = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_KEY ?? "");
  const person = await client.from("users").select().eq("id", id).maybeSingle();
  return person.data;
}
