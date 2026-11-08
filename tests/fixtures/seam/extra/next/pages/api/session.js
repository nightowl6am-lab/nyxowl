export default function handler(req, res) {
  if (req.method === "DELETE") {
    return res.status(204).end();
  }
  return res.json({ ok: true });
}
