// Data model, indices and graph algorithms. All content comes from the
// database snapshot (Wikipedia / Wikimedia Commons); nothing is authored here.

export type NodeType = "person" | "event" | "polity" | "work";
export type Side = "athens" | "sparta" | "persia" | null;
export type EdgeType = "commanded" | "fought" | "wrote" | "allegiance" | "mentions";

export interface RawNode {
  id: string; type: NodeType; title: string; desc?: string; bio?: string; lead?: string;
  story?: string; story_section?: string; dyk?: string; side?: Side; side_src?: string; phase?: string;
  birth?: number | null; death?: number | null; birth_approx?: boolean; death_approx?: boolean;
  start?: number | null; end?: number | null; approx?: boolean; result?: string; location?: string;
  url: string; revid: number;
  img?: { url: string; thumb?: string; page: string; license: string; artist?: string; w?: number; h?: number } | null;
  art?: { url: string; model: string } | null;
}
export interface RawEdge {
  source: string; target: string; type: EdgeType; side?: string; flags?: string[];
  weight?: number; evidence?: string | null; evidence_url?: string; section?: string;
}
export interface War { title: string; desc: string; lead: string; start: number; end: number; url: string; revid: number; phases?: Phase[] }
export interface Phase { name: string; start: number; end: number }
export interface Graph { war: War; nodes: RawNode[]; edges: RawEdge[] }

export interface GNode extends RawNode {
  deg: number; r: number; links: GLink[]; nbrs: Set<GNode>;
  appear: number; // year (negative = BC) from which the node "exists" in time
  x: number; y: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null;
  index?: number;
}
export interface GLink {
  source: GNode; target: GNode; rels: RawEdge[]; types: Set<EdgeType>; strength: number;
  index?: number;
}

export const TYPE_LABEL: Record<NodeType, string> = {
  person: "Figure", event: "Event", polity: "Polity", work: "Work",
};
export const SIDE_LABEL: Record<string, string> = {
  athens: "Athens & allies", sparta: "Sparta & allies", persia: "Persia",
};

export function fmtYear(y: number | null | undefined, approx = false): string {
  if (y == null) return "?";
  return `${approx ? "c. " : ""}${Math.abs(y)}${y < 0 ? " BC" : " AD"}`;
}

export function dateLine(n: RawNode): string {
  if (n.type === "person") {
    if (n.birth != null && n.death != null)
      return `${n.birth_approx ? "c. " : ""}${Math.abs(n.birth)}–${n.death_approx ? "c. " : ""}${Math.abs(n.death)} BC`;
    if (n.death != null) return `died ${fmtYear(n.death, n.death_approx)}`;
    if (n.birth != null) return `born ${fmtYear(n.birth, n.birth_approx)}`;
    return "";
  }
  if (n.start != null) {
    if (n.end != null && n.end !== n.start)
      return `${n.approx ? "c. " : ""}${Math.abs(n.start)}–${Math.abs(n.end)} BC`;
    return fmtYear(n.start, n.approx);
  }
  return "";
}

export async function fetchGraph(): Promise<{ graph: Graph; source: "database" | "snapshot" }> {
  try {
    const r = await fetch("/api/graph", { headers: { accept: "application/json" } });
    if (r.ok) {
      const g = await r.json();
      if (g?.nodes?.length) return { graph: g, source: "database" };
    }
  } catch { /* fall through to the static snapshot */ }
  const r = await fetch("/graph.json");
  return { graph: await r.json(), source: "snapshot" };
}

export class Model {
  nodes: GNode[] = [];
  links: GLink[] = [];
  byId = new Map<string, GNode>();
  war: War;
  minYear = -470;
  maxYear = -370;

  constructor(g: Graph) {
    this.war = g.war;
    for (const n of g.nodes) {
      const gn = n as GNode;
      gn.deg = 0; gn.links = []; gn.nbrs = new Set(); gn.x = 0; gn.y = 0; gn.appear = -Infinity;
      this.nodes.push(gn);
      this.byId.set(n.id, gn);
    }
    const pair = new Map<string, GLink>();
    for (const e of g.edges) {
      const a = this.byId.get(e.source), b = this.byId.get(e.target);
      if (!a || !b || a === b) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      let l = pair.get(key);
      if (!l) {
        l = { source: a, target: b, rels: [], types: new Set(), strength: 0 };
        pair.set(key, l);
        this.links.push(l);
        a.links.push(l); b.links.push(l);
        a.nbrs.add(b); b.nbrs.add(a);
      }
      l.rels.push(e);
      l.types.add(e.type);
    }
    for (const l of this.links) {
      const t = l.types;
      l.strength = t.has("commanded") || t.has("wrote") ? 1
        : t.has("fought") ? 0.5
        : t.has("mentions") ? Math.min(1, 0.25 + 0.15 * l.rels.reduce((s, e) => s + (e.weight ?? 1), 0))
        : 0.08;
    }
    for (const n of this.nodes) {
      n.deg = n.links.filter((l) => !(l.types.size === 1 && l.types.has("allegiance"))).length;
      n.r = n.type === "polity" ? 7 + Math.sqrt(n.deg) * 1.6
        : n.type === "event" ? 4.5 + Math.sqrt(n.deg) * 1.25
        : n.type === "work" ? 3.8 + Math.sqrt(n.deg) * 0.8
        : 3.6 + Math.sqrt(n.deg) * 1.15;
    }
    // When does a node enter the story? Events/works: their year. People: birth,
    // else 40 years before death, else their earliest dated connection.
    for (const n of this.nodes) {
      if (n.type === "event" || n.type === "work") n.appear = n.start ?? -Infinity;
    }
    for (const n of this.nodes) {
      if (n.type !== "person") continue;
      if (n.birth != null) n.appear = n.birth;
      else if (n.death != null) n.appear = n.death - 40;
      else {
        const ys = [...n.nbrs].filter((m) => m.type === "event" && m.start != null).map((m) => m.start!);
        n.appear = ys.length ? Math.min(...ys) - 10 : -Infinity;
      }
    }
    const years = this.nodes.flatMap((n) => [n.birth, n.death, n.start, n.end]).filter((y): y is number => y != null);
    this.minYear = Math.max(-500, Math.min(...years) - 2);
    this.maxYear = Math.min(-340, Math.max(...years) + 2);
  }

  linkBetween(a: GNode, b: GNode): GLink | undefined {
    return a.links.find((l) => l.source === b || l.target === b);
  }

  /** All shortest paths (up to `limit`) between two nodes, BFS over permitted nodes. */
  shortestPaths(from: GNode, to: GNode, opts: { viaPolities: boolean; viaWorks: boolean; strongOnly?: boolean }, limit = 24): GNode[][] {
    const ok = (n: GNode) => n === to || n === from ||
      ((opts.viaPolities || n.type !== "polity") && (opts.viaWorks || n.type !== "work"));
    const linkOk = (l: GLink) => {
      if (opts.strongOnly && !(l.types.has("commanded") || l.types.has("fought") || l.types.has("wrote") || (opts.viaPolities && l.types.has("allegiance")))) return false;
      return !(l.types.size === 1 && l.types.has("allegiance")) || opts.viaPolities;
    };
    const dist = new Map<GNode, number>([[from, 0]]);
    const parents = new Map<GNode, GNode[]>();
    let frontier = [from];
    while (frontier.length && !dist.has(to)) {
      const next: GNode[] = [];
      for (const u of frontier) {
        for (const l of u.links) {
          if (!linkOk(l)) continue;
          const v = l.source === u ? l.target : l.source;
          if (!ok(v)) continue;
          const d = dist.get(u)! + 1;
          if (!dist.has(v)) { dist.set(v, d); parents.set(v, [u]); next.push(v); }
          else if (dist.get(v) === d) parents.get(v)!.push(u);
        }
      }
      frontier = next;
    }
    if (!dist.has(to)) return [];
    const out: GNode[][] = [];
    const walk = (n: GNode, acc: GNode[]) => {
      if (out.length >= limit) return;
      if (n === from) { out.push([from, ...acc]); return; }
      for (const p of parents.get(n) ?? []) walk(p, [n, ...acc]);
    };
    walk(to, []);
    return out;
  }

  search(q: string, types?: NodeType[], limit = 8): GNode[] {
    const s = norm(q);
    if (!s) return [];
    const scored: [number, GNode][] = [];
    for (const n of this.nodes) {
      if (types && !types.includes(n.type)) continue;
      const t = norm(n.title);
      let score = -1;
      if (t === s) score = 100;
      else if (t.startsWith(s)) score = 80;
      else if (t.split(/[\s(,-]+/).some((w) => w.startsWith(s))) score = 60;
      else if (t.includes(s)) score = 40;
      else if (norm(n.desc ?? "").includes(s)) score = 15;
      if (score >= 0) scored.push([score + Math.min(n.deg, 30) / 3, n]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  }
}

export function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
