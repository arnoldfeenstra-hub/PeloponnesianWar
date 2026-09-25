// Single source for the graph payload: used by the Vercel function (api/graph.ts)
// and by scripts/export.ts, which snapshots the database to public/graph.json.
import type { Pool } from "pg";

export async function loadGraph(pool: Pool) {
  const [nodes, edges, meta] = await Promise.all([
    pool.query(`
      SELECT n.*, row_to_json(i.*) AS img, row_to_json(a.*) AS art
      FROM nodes n
      LEFT JOIN images i ON i.node_id = n.id
      LEFT JOIN artwork a ON a.node_id = n.id
      ORDER BY n.id`),
    pool.query(`SELECT source, target, type, side, flags, weight, evidence, evidence_url, section
                FROM edges ORDER BY id`),
    pool.query(`SELECT key, value FROM meta`),
  ]);
  const m = Object.fromEntries(meta.rows.map((r) => [r.key, r.value]));
  return {
    war: m.war,
    nodes: nodes.rows.map((n) => ({
      id: n.id, type: n.type, title: n.title, desc: n.short_desc, bio: n.bio, lead: n.lead,
      story: n.story, story_section: n.story_section, dyk: n.dyk, side: n.side, side_src: n.side_src, phase: n.phase,
      birth: n.birth, death: n.death, birth_approx: n.birth_approx, death_approx: n.death_approx,
      start: n.year_start, end: n.year_end, approx: n.year_approx, result: n.result,
      location: n.location, url: n.wiki_url, revid: Number(n.wiki_revid),
      img: n.img && {
        url: n.img.url, thumb: n.img.thumb, source: n.img.source_url, page: n.img.commons_page, license: n.img.license,
        artist: n.img.artist, w: n.img.width, h: n.img.height,
      },
      art: n.art && { url: n.art.url, model: n.art.model },
    })),
    edges: edges.rows.map((e) => ({
      source: e.source, target: e.target, type: e.type, side: e.side,
      flags: e.flags ?? undefined, weight: e.weight, evidence: e.evidence,
      evidence_url: e.evidence_url, section: e.section,
    })),
  };
}
