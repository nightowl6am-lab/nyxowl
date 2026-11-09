export async function GET(): Promise<Response> {
  const users = await listUsers();
  return Response.json({ users, total: users.length });
}
