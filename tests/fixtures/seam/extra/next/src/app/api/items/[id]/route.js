export async function PATCH() {
  return Response.json({ id: 1 });
}

export async function DELETE() {
  return new Response(null, { status: 204 });
}
