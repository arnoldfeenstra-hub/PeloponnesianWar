import pg from "pg";
import { loadGraph } from "../lib/graphQuery.js";

let pool: pg.Pool | undefined;

export default async function handler(_req: unknown, res: any) {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    res.status(503).json({ error: "DATABASE_URL not configured" });
    return;
  }
  pool ??= new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
  try {
    const graph = await loadGraph(pool);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(graph);
  } catch (err) {
    res.status(500).json({ error: "database query failed" });
  }
}
