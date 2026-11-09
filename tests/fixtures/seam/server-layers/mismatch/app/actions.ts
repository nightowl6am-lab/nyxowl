"use server";

export async function saveSessionKey(key: string): Promise<void> {
  const client = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_KEY ?? "");
  await client.from("sessions").insert({ key });
}
