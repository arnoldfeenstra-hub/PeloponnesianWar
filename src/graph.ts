import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation,
} from "d3-force";
import { select } from "d3-selection";
import "d3-transition";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { easeCubicInOut } from "d3-ease";
import type { GLink, GNode, Model } from "./data";

export interface GraphCallbacks {
  onHover(n: GNode | null, x: number, y: number): void;
  onClick(n: GNode | null): void;
  onDblClick(n: GNode): void;
}

interface Palette {
  bg: string; ink: string; ink2: string; muted: string; faint: string;
  athens: string; sparta: string; persia: string; neutral: string; event: string; work: string;
  accent: string;
}

const YEAR_TOP = -440, YEAR_BOTTOM = -395, SPAN = 760;
export const yearToY = (y: number) => ((y - YEAR_TOP) / (YEAR_BOTTOM - YEAR_TOP) - 0.5) * SPAN;
const POLE_X = 330;
const POLES: Record<string, [number, number]> = {
  athens: [-POLE_X, 0], sparta: [POLE_X, 0], persia: [POLE_X * 0.75, 330],
};

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class GraphView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w = 0; h = 0; dpr = 1;
  sim: Simulation<GNode, GLink>;
  t: ZoomTransform = zoomIdentity;
  zoomer: ZoomBehavior<HTMLCanvasElement, unknown>;
  pal!: Palette;
  hover: GNode | null = null;
  selected: GNode | null = null;
  focus: Set<GNode> | null = null;
  expanded = new Set<GNode>();
  path: GNode[] | null = null;
  pathStart = 0;
  year: number | null = null;
  appearAt = new Map<GNode, number>();
  images = new Map<string, HTMLCanvasElement | "loading" | "error">();
  dirty = true;
  dragging: GNode | null = null;
  downAt: { x: number; y: number; n: GNode | null; time: number } | null = null;
  rank = new Map<GNode, number>();
  private raf = 0;

  constructor(private host: HTMLElement, private model: Model, private cb: GraphCallbacks) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "graph-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Force-directed network of Peloponnesian War figures, events, polities and works");
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.readPalette();

    [...model.nodes].sort((a, b) => b.deg - a.deg).forEach((n, i) => this.rank.set(n, i));

    // seed positions near their pole / year so the bloom reads immediately
    for (const n of model.nodes) {
      const pole = n.side ? POLES[n.side] : [0, 0];
      const y = this.nodeYear(n);
      n.x = pole[0] * 0.6 + (Math.random() - 0.5) * 120;
      n.y = (y != null ? yearToY(y) : pole[1]) + (Math.random() - 0.5) * 80;
    }

    this.sim = forceSimulation<GNode, GLink>(model.nodes)
      .force("link", forceLink<GNode, GLink>(model.links)
        .distance((l) => (l.types.has("allegiance") && l.types.size === 1 ? 140 : l.types.has("commanded") ? 34 : l.types.has("wrote") ? 26 : 48) + l.source.r + l.target.r)
        .strength((l) => l.strength * 0.55 / Math.sqrt(Math.min(l.source.links.length, l.target.links.length))))
      .force("charge", forceManyBody<GNode>().strength((n) => -28 - n.r * 9).distanceMax(420))
      .force("collide", forceCollide<GNode>((n) => n.r + 3.5).iterations(2))
      .force("x", forceX<GNode>((n) => (n.side ? POLES[n.side][0] : 0)).strength((n) => (n.side ? (n.type === "polity" ? 0.35 : 0.1) : 0.012)))
      .force("y", forceY<GNode>((n) => {
        const y = this.nodeYear(n);
        if (n.type === "polity") return n.side ? POLES[n.side][1] : 0;
        return y != null ? yearToY(y) : 0;
      }).strength((n) => {
        if (n.type === "polity") return n.side ? 0.35 : 0.02;
        const y = this.nodeYear(n);
        if (y == null) return 0.01;
        return n.type === "person" ? 0.05 : 0.14;
      }))
      .alphaDecay(0.022)
      .velocityDecay(0.38)
      .on("tick", () => (this.dirty = true));

    this.zoomer = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.25, 8])
      .filter((ev: any) => {
        if (ev.type === "dblclick") return false;
        if (ev.type === "mousedown" || ev.type === "touchstart" || ev.type === "pointerdown") {
          const p = this.pointer(ev.touches ? ev.touches[0] : ev);
          if (this.hit(p[0], p[1])) return false;
        }
        return !ev.ctrlKey || ev.type === "wheel";
      })
      .on("zoom", (ev) => { this.t = ev.transform; this.dirty = true; this.zoomEndAt = performance.now() + 120; });
    select(this.canvas).call(this.zoomer).on("dblclick.zoom", null);

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.t = zoomIdentity.translate(this.w / 2, this.h / 2).scale(Math.min(this.w, this.h) / 1100);
    select(this.canvas).call(this.zoomer.transform, this.t);
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    loop();
  }

  nodeYear(n: GNode): number | null {
    if (n.type === "event" || n.type === "work") return n.start ?? null;
    if (n.type === "person") {
      const ys = [...n.nbrs].filter((m) => m.type === "event" && m.start != null).map((m) => m.start!);
      if (ys.length) return ys.reduce((a, b) => a + b, 0) / ys.length;
      if (n.death != null) return Math.max(n.death - 8, YEAR_TOP);
      return null;
    }
    return null;
  }

  readPalette() {
    this.pal = {
      bg: cssVar("--bg"), ink: cssVar("--ink"), ink2: cssVar("--ink-2"), muted: cssVar("--muted"),
      faint: cssVar("--faint"), athens: cssVar("--athens"), sparta: cssVar("--sparta"),
      persia: cssVar("--persia"), neutral: cssVar("--neutral"), event: cssVar("--event"),
      work: cssVar("--work"), accent: cssVar("--accent"),
    };
    this.dirty = true;
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width; this.h = r.height;
    this.applyScale();
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    this.dirty = true;
  }

  pointer(ev: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  hit(sx: number, sy: number): GNode | null {
    const [x, y] = this.t.invert([sx, sy]);
    let best: GNode | null = null, bd = Infinity;
    const slop = 6 / this.t.k;
    for (const n of this.model.nodes) {
      if (!this.isVisible(n)) continue;
      const d = Math.hypot(n.x - x, n.y - y) - n.r - slop;
      if (d < 0 && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener("pointermove", (ev) => {
      const [x, y] = this.pointer(ev);
      if (this.dragging) {
        const [wx, wy] = this.t.invert([x, y]);
        this.dragging.fx = wx; this.dragging.fy = wy;
        this.cb.onHover(null, 0, 0);
        return;
      }
      if (this.downAt?.n && Math.hypot(x - this.downAt.x, y - this.downAt.y) > 4) {
        this.dragging = this.downAt.n;
        this.sim.alphaTarget(0.18).restart();
        c.setPointerCapture(ev.pointerId);
      }
      const n = this.hit(x, y);
      if (n !== this.hover) { this.hover = n; this.dirty = true; }
      c.style.cursor = n ? "pointer" : "grab";
      this.cb.onHover(n, ev.clientX, ev.clientY);
    });
    c.addEventListener("pointerleave", () => {
      if (this.hover) { this.hover = null; this.dirty = true; }
      this.cb.onHover(null, 0, 0);
    });
    c.addEventListener("pointerdown", (ev) => {
      const [x, y] = this.pointer(ev);
      this.downAt = { x, y, n: this.hit(x, y), time: performance.now() };
    });
    c.addEventListener("pointerup", (ev) => {
      const [x, y] = this.pointer(ev);
      if (this.dragging) {
        this.dragging.fx = null; this.dragging.fy = null;
        this.dragging = null;
        this.sim.alphaTarget(0);
      } else if (this.downAt && Math.hypot(x - this.downAt.x, y - this.downAt.y) < 5) {
        this.cb.onClick(this.downAt.n);
      }
      this.downAt = null;
    });
    c.addEventListener("dblclick", (ev) => {
      const [x, y] = this.pointer(ev);
      const n = this.hit(x, y);
      if (n) this.cb.onDblClick(n);
    });
  }

  // ------------------------------------------------------------------ state
  isVisible(n: GNode) {
    return this.year == null || n.appear <= this.year;
  }

  setYear(y: number | null) {
    const now = performance.now();
    for (const n of this.model.nodes) {
      const was = this.year == null || n.appear <= this.year;
      const is = y == null || n.appear <= y;
      if (is && !was) this.appearAt.set(n, now);
    }
    this.year = y;
    this.dirty = true;
  }

  select(n: GNode | null, opts: { expand?: boolean; fly?: boolean } = {}) {
    if (!n) {
      this.selected = null; this.focus = null; this.expanded.clear();
      this.dirty = true;
      return;
    }
    if (opts.expand && this.focus) {
      this.expanded.add(n);
      for (const m of n.nbrs) this.focus.add(m);
      this.focus.add(n);
    } else {
      this.expanded = new Set([n]);
      this.focus = new Set([n, ...n.nbrs]);
    }
    this.selected = n;
    this.dirty = true;
    if (opts.fly !== false) this.flyTo([...this.focus], opts.expand ? 900 : 1100);
  }

  setPath(p: GNode[] | null) {
    this.path = p;
    this.pathStart = performance.now();
    if (p) {
      this.focus = new Set(p);
      this.selected = null;
      this.expanded.clear();
      this.flyTo(p, 1200);
    } else {
      this.focus = null;
    }
    this.dirty = true;
  }

  flyTo(nodes: GNode[], duration = 1000) {
    if (!nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    }
    const wide = this.w > 760;
    const pathMode = document.body.dataset.view === "path";
    const right = document.body.classList.contains("panel-open") && wide ? 400 : 0;
    const left = pathMode && wide ? 420 : 0;
    const bottom = !wide && (document.body.classList.contains("panel-open") || pathMode) ? this.h * 0.5 : 0;
    const W = this.w - right - left, H = this.h - bottom - 70;
    const pad = 90;
    const kMax = nodes.length <= 4 ? 1.9 : 3;
    const k = Math.min(kMax, Math.max(0.35, Math.min((W - pad * 2) / Math.max(x1 - x0, 1), (H - pad * 2) / Math.max(y1 - y0, 1))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const target = zoomIdentity.translate(left + W / 2, 10 + H / 2).scale(k).translate(-cx, -cy);
    select(this.canvas).transition().duration(duration).ease(easeCubicInOut)
      .call(this.zoomer.transform as any, target);
  }

  fitAll(duration = 900) {
    this.flyTo(this.model.nodes.filter((n) => this.isVisible(n)), duration);
  }

  zoomBy(f: number) {
    select(this.canvas).transition().duration(350).call(this.zoomer.scaleBy as any, f);
  }

  reheat() { this.sim.alpha(0.5).restart(); }

  // ------------------------------------------------------------------ drawing
  color(n: GNode): string {
    const p = this.pal;
    if (n.type === "event") return p.event;
    if (n.type === "work") return p.work;
    return n.side === "athens" ? p.athens : n.side === "sparta" ? p.sparta : n.side === "persia" ? p.persia : p.neutral;
  }

  /** Portrait for a node, pre-tinted once into an offscreen canvas (no per-frame filters). */
  image(n: GNode): HTMLCanvasElement | null {
    const src = n.art?.url ?? n.img?.thumb ?? n.img?.url;
    if (!src) return null;
    const c = this.images.get(src);
    if (c instanceof HTMLCanvasElement) return c;
    if (!c) {
      this.images.set(src, "loading");
      const img = new Image();
      img.onload = () => {
        const S = 96;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const x = cv.getContext("2d")!;
        const s = Math.max(S / img.width, S / img.height);
        x.filter = "grayscale(0.35) sepia(0.25) contrast(1.05)";
        x.drawImage(img, (S - img.width * s) / 2, (S - img.height * s) / 2.6, img.width * s, img.height * s);
        this.images.set(src, cv);
        this.dirty = true;
      };
      img.onerror = () => this.images.set(src, "error");
      img.src = src;
    }
    return null;
  }

  private lastMotion = 0;
  private lastFrameT = 0;
  private drewLast = false;
  private slowFrames = 0;
  motionScale = 2;

  frame() {
    const now = performance.now();
    const dt = now - this.lastFrameT;
    this.lastFrameT = now;
    const pathAnim = this.path != null; // draw-in, then a looping spark
    const appearing = this.appearAt.size > 0 && [...this.appearAt.values()].some((t) => now - t < 700);
    const moving = this.dirty && (this.sim.alpha() > this.sim.alphaMin() || this.zooming() || this.dragging != null);
    if (moving || pathAnim || appearing) this.lastMotion = now;
    const inMotion = now - this.lastMotion < 250;
    // Adaptive resolution: while things move, step the backing-store scale down
    // until frames arrive on time; render one crisp full-resolution frame at rest.
    if (inMotion && this.drewLast && dt > 22 && dt < 250) {
      if (++this.slowFrames > 5 && this.motionScale > 1) { this.motionScale = Math.max(1, this.motionScale - 0.375); this.slowFrames = 0; }
    } else if (dt < 19) this.slowFrames = Math.max(0, this.slowFrames - 1);
    const want = inMotion ? Math.min(this.dpr, this.motionScale) : this.dpr;
    if (want !== this.scale) { this.scale = want; this.applyScale(); this.dirty = true; }
    if (!this.dirty && !pathAnim && !appearing) { this.drewLast = false; return; }
    this.dirty = false;
    this.drewLast = true;
    this.draw();
  }

  private zoomEndAt = 0;
  zooming() { return performance.now() < this.zoomEndAt; }

  applyScale() {
    const s = (this.scale = this.scale || this.dpr);
    this.canvas.width = Math.round(this.w * s);
    this.canvas.height = Math.round(this.h * s);
  }

  scale = 0;
  private order: GNode[] | null = null;
  private widthCache = new Map<string, number>();

  measure(font: string, text: string) {
    const k = font + "|" + text;
    let w = this.widthCache.get(k);
    if (w == null) { this.ctx.font = font; w = this.ctx.measureText(text).width; this.widthCache.set(k, w); }
    return w;
  }

  draw() {
    const { ctx, pal, t } = this;
    const now = performance.now();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    const k = t.k;

    // year rules: the chronicle reads top to bottom
    ctx.font = `500 ${10 / k}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const [lx] = t.invert([16, 0]);
    const [rx] = t.invert([this.w, 0]);
    for (const y of [-435, -431, -425, -421, -415, -413, -411, -405, -404, -400]) {
      const yy = yearToY(y);
      const major = y === this.model.war.start || y === this.model.war.end;
      ctx.strokeStyle = pal.faint;
      ctx.globalAlpha = major ? 0.9 : 0.45;
      ctx.lineWidth = (major ? 1 : 0.6) / k;
      ctx.setLineDash(major ? [] : [2 / k, 5 / k]);
      ctx.beginPath(); ctx.moveTo(lx, yy); ctx.lineTo(rx, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = major ? 0.85 : 0.55;
      ctx.fillStyle = pal.muted;
      ctx.fillText(`${-y} BC${major ? (y === this.model.war.start ? " · war begins" : " · Athens surrenders") : ""}`, lx, yy - 3 / k);
    }

    // pole captions
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 104px "Cormorant Garamond", Georgia, serif`;
    ctx.globalAlpha = 0.07;
    for (const [side, [px, py]] of Object.entries(POLES)) {
      ctx.fillStyle = side === "athens" ? pal.athens : side === "sparta" ? pal.sparta : pal.persia;
      const word = side === "athens" ? "ΑΘΗΝΑΙ" : side === "sparta" ? "ΣΠΑΡΤΗ" : "ΠΕΡΣΑΙ";
      ctx.fillText(word, py === 0 ? px * 1.3 : px * 1.1, py === 0 ? -340 : py + 150);
    }
    ctx.globalAlpha = 1;

    const focus = this.focus;
    const hov = this.hover;
    const hovSet = hov ? new Set([hov, ...hov.nbrs]) : null;
    const pathSet = this.path ? new Set(this.path) : null;

    const nodeAlpha = (n: GNode) => {
      if (!this.isVisible(n)) return 0.05;
      let a = 1;
      if (focus && !focus.has(n)) a = 0.1;
      if (hovSet && !hovSet.has(n) && !(focus && focus.has(n))) a = Math.min(a, 0.22);
      const ap = this.appearAt.get(n);
      if (ap) a *= Math.min(1, (now - ap) / 600);
      return a;
    };

    // links, batched into a handful of Path2D buckets
    const buckets = new Map<string, { p: Path2D; color: string; a: number; w: number; dash: number }>();
    for (const l of this.model.links) {
      const s = l.source, g = l.target;
      if (!this.isVisible(s) || !this.isVisible(g)) continue;
      const onlyAllegiance = l.types.size === 1 && l.types.has("allegiance");
      const inFocus = focus && focus.has(s) && focus.has(g) && (this.expanded.has(s) || this.expanded.has(g) || pathSet != null);
      const inHover = hov && (s === hov || g === hov);
      let a = onlyAllegiance ? 0 : l.types.has("mentions") && l.types.size === 1 ? 0.07 : 0.13;
      if (focus) a = inFocus ? (onlyAllegiance ? 0.25 : 0.55) : a * 0.25;
      if (hov) a = inHover ? (onlyAllegiance ? 0.3 : 0.75) : a * 0.5;
      if (pathSet) a = Math.min(a, 0.05);
      if (a <= 0.004) continue;
      const person = s.type === "person" ? s : g.type === "person" ? g : null;
      const hot = !!(inFocus || inHover);
      const color = hot && l.types.has("commanded") && person ? this.color(person) : pal.ink2;
      const w = hot ? 1.3 : 0.8;
      const dash = onlyAllegiance ? 1 : l.types.has("fought") && !l.types.has("commanded") ? 2 : 0;
      const qa = Math.round(a * 40) / 40;
      const key = `${color}|${qa}|${w}|${dash}`;
      let b = buckets.get(key);
      if (!b) { b = { p: new Path2D(), color, a: qa, w, dash }; buckets.set(key, b); }
      b.p.moveTo(s.x, s.y);
      b.p.lineTo(g.x, g.y);
    }
    ctx.lineCap = "round";
    for (const b of buckets.values()) {
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = b.a;
      ctx.lineWidth = b.w / k;
      ctx.setLineDash(b.dash === 1 ? [2 / k, 4 / k] : b.dash === 2 ? [5 / k, 3 / k] : []);
      ctx.stroke(b.p);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // six-degrees path
    if (this.path) {
      const per = 700;
      const el = now - this.pathStart - 500;
      for (let i = 0; i < this.path.length - 1; i++) {
        const a = this.path[i], b = this.path[i + 1];
        const p = Math.max(0, Math.min(1, (el - i * per) / per));
        if (p <= 0) break;
        const x = a.x + (b.x - a.x) * p, y = a.y + (b.y - a.y) * p;
        ctx.strokeStyle = pal.accent;
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 9 / k;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.4 / k;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
        if (p < 1) {
          ctx.fillStyle = pal.accent;
          ctx.beginPath(); ctx.arc(x, y, 4.5 / k, 0, Math.PI * 2); ctx.fill();
        }
      }
      const total = (this.path.length - 1) * per;
      if (el > total) {
        const loopT = ((el - total) % 2600) / 2600;
        const seg = loopT * (this.path.length - 1);
        const i = Math.min(this.path.length - 2, Math.floor(seg));
        const f = seg - i;
        const a = this.path[i], b = this.path[i + 1];
        ctx.fillStyle = pal.ink;
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 2.6 / k, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // nodes
    const ringW = 2 / k;
    this.order ??= [...this.model.nodes].sort((a, b) => (a.type === "polity" ? 0 : 1) - (b.type === "polity" ? 0 : 1));
    const [vx0, vy0] = t.invert([-40, -40]);
    const [vx1, vy1] = t.invert([this.w + 40, this.h + 40]);
    for (const n of this.order) {
      if (n.x < vx0 || n.x > vx1 || n.y < vy0 || n.y > vy1) continue;
      const a = nodeAlpha(n);
      if (a <= 0.01) continue;
      ctx.globalAlpha = a;
      const ap = this.appearAt.get(n);
      const grow = ap ? easeCubicInOut(Math.min(1, (now - ap) / 600)) : 1;
      const r = n.r * grow;
      const col = this.color(n);
      const screenR = r * k;
      const img = screenR > 13 && n.type !== "polity" && (focus ? focus.has(n) : true) ? this.image(n) : null;
      ctx.lineWidth = ringW;
      ctx.strokeStyle = pal.bg;
      ctx.beginPath();
      if (n.type === "event") {
        const d = r * 1.25;
        ctx.moveTo(n.x, n.y - d); ctx.lineTo(n.x + d, n.y); ctx.lineTo(n.x, n.y + d); ctx.lineTo(n.x - d, n.y);
        ctx.closePath();
        ctx.fillStyle = col; ctx.fill(); ctx.stroke();
      } else if (n.type === "work") {
        const d = r * 0.95;
        ctx.rect(n.x - d, n.y - d, d * 2, d * 2);
        ctx.fillStyle = col; ctx.fill(); ctx.stroke();
      } else if (n.type === "polity") {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = pal.bg; ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 1.6 / k; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, n.y, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill(); ctx.stroke();
      }
      if (img) {
        const ir = n.type === "event" ? r * 0.8 : r * 0.86;
        ctx.save();
        ctx.beginPath(); ctx.arc(n.x, n.y, ir, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, n.x - ir, n.y - ir, ir * 2, ir * 2);
        ctx.restore();
        ctx.beginPath(); ctx.arc(n.x, n.y, ir, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = 1.5 / k; ctx.stroke();
      }
      if (n === this.selected || n === hov || (pathSet && pathSet.has(n))) {
        const pulse = pathSet?.has(n) ? 0.5 + 0.5 * Math.sin(now / 380) : 0.6;
        ctx.globalAlpha = n === hov ? 0.9 : 0.55 + 0.35 * pulse;
        ctx.strokeStyle = pathSet && pathSet.has(n) ? pal.accent : pal.ink;
        ctx.lineWidth = 1.4 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + (4 + pulse * 2.5) / k, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    this.drawLabels(nodeAlpha, pathSet, hovSet);
  }

  drawLabels(alpha: (n: GNode) => number, pathSet: Set<GNode> | null, hovSet: Set<GNode> | null) {
    const { ctx, t, pal } = this;
    const k = t.k;
    const budget = Math.round(16 * Math.pow(k, 1.7));
    const prio = (n: GNode) => {
      if (n === this.hover) return 0;
      if (pathSet?.has(n)) return 1;
      if (n === this.selected) return 2;
      if (this.expanded.has(n)) return 3;
      if (this.focus?.has(n)) return 4 + (this.rank.get(n) ?? 0) / 1000;
      if (hovSet?.has(n)) return 5;
      return 10 + (this.rank.get(n) ?? 0);
    };
    const cands = this.model.nodes.filter((n) => alpha(n) > 0.5 || n === this.hover).sort((a, b) => prio(a) - prio(b));
    const placed: [number, number, number, number][] = [];
    let shown = 0;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const n of cands) {
      const p = prio(n);
      if (p >= 10 && (shown >= budget || (this.focus && !pathSet))) break;
      const [sx, sy] = t.apply([n.x, n.y]);
      if (sx < -50 || sy < -20 || sx > this.w + 50 || sy > this.h + 20) continue;
      const big = n.type === "polity";
      const size = big ? 11 : p < 3 ? 14 : n.type === "event" ? 12 : 12.5;
      const font = big ? `600 ${size}px Inter, system-ui, sans-serif`
        : n.type === "work" ? `italic 500 ${size + 1}px "EB Garamond", Georgia, serif`
        : n.type === "event" ? `500 ${size}px Inter, system-ui, sans-serif`
        : `500 ${size + 1.5}px "EB Garamond", Georgia, serif`;
      const label = big ? n.title.replace(/^Classical /, "").replace(/^Ancient /, "").replace(/, .*$/, "").toUpperCase() : n.title.replace(/ \((?:[^)]*)\)$/, "");
      const tw = this.measure(font, label) + (big ? label.length * 1.2 : 0);
      const r = n.r * k;
      const x = sx + r + 5, y = sy;
      const box: [number, number, number, number] = [x - 2, y - size / 2 - 2, x + tw + 2, y + size / 2 + 2];
      if (p >= 4 && placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push(box);
      shown++;
      ctx.font = font;
      ctx.globalAlpha = p >= 10 ? Math.min(1, alpha(n)) * 0.92 : 1;
      if (big) (ctx as any).letterSpacing = "1.2px";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = pal.bg;
      ctx.strokeText(label, x, y);
      ctx.fillStyle = p <= 2 ? pal.ink : big ? this.color(n) : n.type === "event" ? pal.ink2 : pal.ink;
      ctx.fillText(label, x, y);
      if (big) (ctx as any).letterSpacing = "0px";
    }
    ctx.globalAlpha = 1;
  }

  screenPos(n: GNode): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const [x, y] = this.t.apply([n.x, n.y]);
    return [x + r.left, y + r.top];
  }

  destroy() { cancelAnimationFrame(this.raf); this.sim.stop(); }
}
