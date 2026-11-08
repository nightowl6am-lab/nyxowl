export default function handler(req, res) {
  switch (req.method) {
    case "GET":
      return res.json({ id: 1 });
    case "POST":
      return res.status(201).json({ id: 2 });
    default:
      return res.status(405).end();
  }
}
