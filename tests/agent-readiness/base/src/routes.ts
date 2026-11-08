import { Router } from "express";
import { db } from "./db.ts";

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

router.get("/invoices/:id", async (req, res) => {
  const invoice = await db.invoices.findById(req.params.id);
  res.json(invoice);
});
