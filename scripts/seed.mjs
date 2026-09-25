// Build-time loader: data/graph.raw.json (+ data/artwork.json) -> Neon Postgres.
// Runs on Vercel before the snapshot export, so the database connection string
// only ever lives in Vercel's environment. Never logs the connection string.
import fs from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.log("seed: DATABASE_URL not set, skipping (the committed snapshot is used)");
  process.exit(0);
}
const local = /@(localhost|127\.0\.0\.1)[:/]|host=\/|sslmode=disable/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });

const g = JSON.parse(fs.readFileSync("data/graph.raw.json", "utf8"));
const art = fs.existsSync("data/artwork.json") ? JSON.parse(fs.readFileSync("data/artwork.json", "utf8")) : [];
const ids = new Set(g.nodes.map((n) => n.id));

/** INSERT ... VALUES in batches with positional parameters. */
async function insert(table, cols, rows, suffix = "") {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const values = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")} ${suffix}`, params);
  }
}

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("DROP TABLE IF EXISTS edges, images, artwork, meta, nodes CASCADE");
  await client.query(fs.readFileSync("db/schema.sql", "utf8"));
  await insert("nodes",
    ["id", "type", "title", "short_desc", "bio", "lead", "story", "story_section", "dyk", "side", "side_src",
      "birth", "death", "birth_approx", "death_approx", "year_start", "year_end", "year_approx", "result",
      "location", "wiki_url", "wiki_revid", "seed", "phase"],
    g.nodes.map((n) => [n.id, n.type, n.title, n.desc ?? null, n.bio ?? null, n.lead ?? null, n.story ?? null,
      n.story_section ?? null, n.dyk ?? null, n.side ?? null, n.side_src ?? null, n.birth ?? null, n.death ?? null,
      n.birth_approx ?? null, n.death_approx ?? null, n.start ?? null, n.end ?? null, n.approx ?? null,
      n.result ?? null, n.location ?? null, n.url, n.revid, n.seed ?? false, n.phase ?? null]));
  await insert("images",
    ["node_id", "url", "thumb", "source_url", "commons_page", "file", "license", "artist", "description", "width", "height"],
    g.nodes.filter((n) => n.img).map((n) => [n.id, n.img.url, n.img.thumb ?? null, n.img.source ?? null, n.img.page,
      n.img.file ?? null, n.img.license, n.img.artist ?? null, n.img.description ?? null, n.img.w ?? null, n.img.h ?? null]));
  const artRows = art.filter((a) => ids.has(a.node_id)).map((a) => [a.node_id, a.url, a.model, a.prompt]);
  if (artRows.length) await insert("artwork", ["node_id", "url", "model", "prompt"], artRows);
  await insert("edges",
    ["source", "target", "type", "side", "flags", "weight", "evidence", "evidence_url", "section"],
    g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => [e.source, e.target, e.type, e.side ?? null,
      e.flags?.length ? e.flags : null, e.weight ?? 1, e.evidence ?? null, e.evidence_url ?? null, e.section ?? null]));
  await client.query("INSERT INTO meta (key, value) VALUES ('war', $1), ('built', $2)",
    [JSON.stringify(g.war), JSON.stringify({ at: new Date().toISOString(), source: "Wikipedia / Wikimedia Commons" })]);
  await client.query("COMMIT");
  const { rows } = await client.query("SELECT (SELECT count(*) FROM nodes) n, (SELECT count(*) FROM edges) e, (SELECT count(*) FROM images) i, (SELECT count(*) FROM artwork) a");
  console.log(`seed: loaded ${rows[0].n} nodes, ${rows[0].e} edges, ${rows[0].i} images, ${rows[0].a} artworks into Postgres`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("seed failed:", String(err.message).replace(/postgres(ql)?:\/\/\S+/g, "<redacted>"));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
