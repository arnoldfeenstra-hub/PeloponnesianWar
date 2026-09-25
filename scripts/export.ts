// Snapshot the database into public/graph.json (static fallback + fast first paint).
import fs from "node:fs";
import pg from "pg";
import { loadGraph } from "../lib/graphQuery.ts";

function dsn(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (fs.existsSync(".env.local")) {
    for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
      const [k, ...rest] = line.split("=");
      if (["DATABASE_URL", "POSTGRES_URL"].includes(k.trim())) return rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  }
  throw new Error("DATABASE_URL not set");
}

const local = /localhost|127\.0\.0\.1|\/var\/run/.test(dsn());
const pool = new pg.Pool({ connectionString: dsn(), ssl: local ? false : { rejectUnauthorized: false } });
const g = await loadGraph(pool);
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/graph.json", JSON.stringify(g));
console.log(`exported ${g.nodes.length} nodes, ${g.edges.length} edges`);
await pool.end();
