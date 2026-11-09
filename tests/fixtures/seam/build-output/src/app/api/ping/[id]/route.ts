type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: unknown, _context: RouteContext): Promise<Response> {
  return Response.json({ pong: true });
}
