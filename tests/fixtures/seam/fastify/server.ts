import express from "express";

const app = express();
const router = express.Router();

app.use("/api/v1", router);

router.get("/users", (_req, res) => res.json({ id: 1 }));

// router.get("/commented", (_req, res) => res.json({ id: 2 }));
