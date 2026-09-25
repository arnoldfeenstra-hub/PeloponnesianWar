import { scaleLinear, type ScaleLinear } from "d3-scale";
import { dateLine, type GNode, type Model } from "./data";

const NS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export interface TimelineCallbacks {
  onHover(n: GNode | null, x: number, y: number): void;
  onClick(n: GNode | null): void;
  onYear(y: number): void;
}

type Item = { n: GNode; row: number; x0: number; x1: number; g: SVGGElement };

const SIDES: [string, string][] = [["athens", "Athens & allies"], ["sparta", "Sparta & allies"], ["persia", "Persia"], ["other", "Others"]];

export class TimelineView {
  root: HTMLDivElement;
  head: SVGSVGElement;
  body: SVGSVGElement;
  scroller: HTMLDivElement;
  x!: ScaleLinear<number, number>;
  year: number;
  selected: GNode | null = null;
  items = new Map<GNode, Item>();
  warOnly = false;
  playing = 0;
  width = 0;
  cursorHead!: SVGGElement;
  cursorBody!: SVGLineElement;
  readout: HTMLDivElement;
  private links!: SVGGElement;
  private built = false;
  private peopleTop = 0;

  constructor(private host: HTMLElement, private model: Model, private cb: TimelineCallbacks) {
    this.year = model.war.start;
    this.root = document.createElement("div");
    this.root.className = "timeline";
    this.root.innerHTML = `
      <div class="tl-toolbar">
        <button class="tl-play chip" aria-label="Play through the years"><span class="i">▶</span> Play</button>
        <div class="tl-year" aria-live="polite"></div>
        <div class="tl-readout"></div>
        <div class="tl-range seg" role="group" aria-label="Time range">
          <button data-r="era" class="on">Whole era</button><button data-r="war">War years</button>
        </div>
      </div>
      <div class="tl-headwrap"></div>
      <div class="tl-scroll"></div>`;
    host.appendChild(this.root);
    this.head = el("svg", { class: "tl-head" }) as SVGSVGElement;
    this.root.querySelector(".tl-headwrap")!.appendChild(this.head);
    this.scroller = this.root.querySelector(".tl-scroll") as HTMLDivElement;
    this.body = el("svg", { class: "tl-body" }) as SVGSVGElement;
    this.scroller.appendChild(this.body);
    this.readout = this.root.querySelector(".tl-readout") as HTMLDivElement;

    this.root.querySelector(".tl-play")!.addEventListener("click", () => this.togglePlay());
    this.root.querySelectorAll<HTMLButtonElement>(".tl-range button").forEach((b) =>
      b.addEventListener("click", () => {
        this.root.querySelectorAll(".tl-range button").forEach((x) => x.classList.toggle("on", x === b));
        this.warOnly = b.dataset.r === "war";
        this.build();
      }));

    const scrub = (ev: PointerEvent) => {
      const r = this.head.getBoundingClientRect();
      const y = Math.round(this.x.invert(ev.clientX - r.left));
      this.setYear(Math.max(this.x.domain()[0], Math.min(this.x.domain()[1], y)), true);
    };
    this.head.addEventListener("pointerdown", (ev) => {
      this.head.setPointerCapture(ev.pointerId);
      this.stop();
      scrub(ev);
      const move = (e: PointerEvent) => scrub(e);
      const up = () => { this.head.removeEventListener("pointermove", move); this.head.removeEventListener("pointerup", up); };
      this.head.addEventListener("pointermove", move);
      this.head.addEventListener("pointerup", up);
    });
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") { this.setYear(this.year - 1, true); ev.preventDefault(); }
      if (ev.key === "ArrowRight") { this.setYear(this.year + 1, true); ev.preventDefault(); }
    });
    new ResizeObserver(() => { if (this.root.offsetParent && this.scroller.clientWidth !== this.width) this.build(); }).observe(this.scroller);
  }

  show() { if (!this.built || this.width !== this.scroller.clientWidth) this.build(); this.root.focus({ preventScroll: true }); }

  build() {
    const W = this.scroller.clientWidth;
    if (!W) return;
    this.width = W;
    this.built = true;
    const m = this.model;
    const domain: [number, number] = this.warOnly ? [m.war.start - 2, m.war.end + 1] : [-465, -385];
    const L = 24, R = 24;
    this.x = scaleLinear().domain(domain).range([L, W - R]);
    const x = this.x;
    const clampX = (y: number) => Math.max(L - 6, Math.min(W - R + 6, x(y)));
    this.items.clear();

    // ---------------- sticky head: axis + campaign phases
    const head = this.head;
    head.innerHTML = "";
    const yAxis = 24, yPhase = 32, H = 58;
    head.setAttribute("width", String(W));
    head.setAttribute("height", String(H));
    head.setAttribute("viewBox", `0 0 ${W} ${H}`);
    el("rect", { x: x(m.war.start), y: yPhase, width: x(m.war.end) - x(m.war.start), height: H - yPhase, class: "tl-warband" }, head);
    const phases = m.war.phases ?? [];
    phases.forEach((p, i) => {
      const next = phases[i + 1];
      const x0 = x(p.start), x1 = next ? x(next.start) : x(Math.max(p.end, m.war.end));
      const g = el("g", { class: "tl-phase" }, head);
      el("rect", { x: x0, y: yPhase, width: Math.max(2, x1 - x0 - 2), height: 18, rx: 2 }, g);
      const w = x1 - x0;
      const t = el("text", { x: x0 + 6, y: yPhase + 12.5 }, g);
      t.textContent = w > p.name.length * 6.6 + 10 ? p.name : w > 40 ? p.name.slice(0, Math.floor((w - 12) / 6.6)) + "…" : "";
      const tip = el("title", {}, g); tip.textContent = `${p.name}: ${-p.start}–${-p.end} BC (span of its battles, per the Wikipedia campaign box)`;
    });
    const step = this.warOnly ? 1 : 5;
    for (let y = Math.ceil(domain[0] / step) * step; y <= domain[1]; y += step) {
      const major = this.warOnly ? y % 5 === 0 : y % 10 === 0;
      el("line", { x1: x(y), x2: x(y), y1: yAxis - (major ? 7 : 4), y2: yAxis, class: "tl-tick" }, head);
      if (major || (this.warOnly && W > 900)) {
        const t = el("text", { x: x(y), y: yAxis - 11, class: major ? "tl-ticklabel major" : "tl-ticklabel" }, head);
        t.textContent = `${-y}`;
      }
    }
    el("line", { x1: L, x2: W - R, y1: yAxis, y2: yAxis, class: "tl-axis" }, head);
    const bc = el("text", { x: W - R, y: yAxis - 11, class: "tl-ticklabel era", "text-anchor": "end" }, head); bc.textContent = "BC";
    this.cursorHead = el("g", { class: "tl-cursor" }, head) as SVGGElement;
    el("line", { x1: 0, x2: 0, y1: yAxis - 2, y2: H, class: "tl-cursor-line" }, this.cursorHead);
    el("rect", { x: -26, y: 0, width: 52, height: 18, rx: 9, class: "tl-cursor-chip" }, this.cursorHead);
    el("text", { x: 0, y: 12.5, class: "tl-cursor-text", "text-anchor": "middle" }, this.cursorHead);

    // ---------------- body lanes: events and works (labels for the best-connected)
    const body = this.body;
    body.innerHTML = "";
    this.links = el("g", { class: "tl-links" }, body) as SVGGElement;
    const measure = document.createElement("canvas").getContext("2d")!;
    const RH = 17;
    type Placed = { n: GNode; row: number; x0: number; x1: number; label: boolean };
    const packLane = (list: GNode[], labelFn: (n: GNode) => string, font: string, maxRows: number): Placed[] => {
      measure.font = font;
      const rows: [number, number][][] = Array.from({ length: maxRows }, () => []);
      const free = (r: number, a: number, b: number) => rows[r].every(([p, q]) => b < p - 3 || a > q + 3);
      const out: Placed[] = [];
      for (const n of [...list].sort((p, q) => q.deg - p.deg)) {
        const x0 = clampX(n.start!), x1 = Math.max(x0, clampX(n.end ?? n.start!));
        const lw = measure.measureText(labelFn(n)).width + 16;
        let row = rows.findIndex((_, r) => free(r, x0 - 7, x1 + lw));
        let label = true;
        if (row < 0) { label = false; row = rows.findIndex((_, r) => free(r, x0 - 7, x1 + 7)); }
        if (row < 0) { rows.push([]); row = rows.length - 1; }
        rows[row].push([x0 - 7, label ? x1 + lw : x1 + 7]);
        out.push({ n, row, x0, x1, label });
      }
      return out;
    };
    const evLabel = (n: GNode) => n.title.replace(/^Battle of /, "").replace(/ \(\d+.*\)$/, "");
    const wLabel = (n: GNode) => n.title.replace(/ \(.*\)$/, "");
    const events = m.nodes.filter((n) => n.type === "event" && n.start != null);
    const works = m.nodes.filter((n) => n.type === "work" && n.start != null);
    const evP = packLane(events, evLabel, "500 11px Inter, system-ui, sans-serif", this.warOnly ? 6 : 5);
    const wP = packLane(works, wLabel, "italic 500 12.5px 'EB Garamond', Georgia, serif", 3);
    const evRows = Math.max(1, ...evP.map((p) => p.row + 1));
    const wRows = Math.max(1, ...wP.map((p) => p.row + 1));
    const yEvents = 30, yWorks = yEvents + evRows * RH + 30;
    const lane = (y: number, s: string) => { const t = el("text", { x: L, y, class: "tl-lane" }, body); t.textContent = s; };
    lane(yEvents - 10, "EVENTS");
    lane(yWorks - 10, "WORKS");
    for (const p of evP) {
      const g = el("g", { class: "tl-item tl-event", transform: `translate(0,${yEvents + p.row * RH + 6})` }, body) as SVGGElement;
      if (p.x1 - p.x0 > 3) el("rect", { x: p.x0, y: -1.5, width: p.x1 - p.x0, height: 3, class: "tl-span" }, g);
      el("path", { d: `M${p.x0},-5.5 L${p.x0 + 5.5},0 L${p.x0},5.5 L${p.x0 - 5.5},0Z`, class: "tl-diamond" }, g);
      if (p.label) { const t = el("text", { x: p.x1 + 9, y: 4 }, g); t.textContent = evLabel(p.n); }
      else { const tt = el("title", {}, g); tt.textContent = `${p.n.title} (${dateLine(p.n)})`; }
      this.items.set(p.n, { n: p.n, row: p.row, x0: p.x0, x1: p.x1, g });
      this.bindItem(g, p.n);
    }
    for (const p of wP) {
      const g = el("g", { class: "tl-item tl-work", transform: `translate(0,${yWorks + p.row * RH + 6})` }, body) as SVGGElement;
      el("rect", { x: p.x0 - 4, y: -4, width: 8, height: 8, class: "tl-square" }, g);
      if (p.label) { const t = el("text", { x: p.x0 + 9, y: 4 }, g); t.textContent = wLabel(p.n); }
      else { const tt = el("title", {}, g); tt.textContent = `${p.n.title} (${dateLine(p.n)})`; }
      this.items.set(p.n, { n: p.n, row: p.row, x0: p.x0, x1: p.x0, g });
      this.bindItem(g, p.n);
    }
    el("line", { x1: L, x2: W - R, y1: yWorks + wRows * RH + 14, y2: yWorks + wRows * RH + 14, class: "tl-sep" }, body);
    this.peopleTop = yWorks + wRows * RH + 14;

    // ---------------- body: people as lifespan bars grouped by side
    measure.font = "500 13px 'EB Garamond', Georgia, serif";
    let y = this.peopleTop + 18;
    const BR = 20;
    for (const [side, label] of SIDES) {
      const people = m.nodes.filter((n) => n.type === "person" && (side === "other" ? !n.side : n.side === side));
      if (!people.length) continue;
      const span = (n: GNode): [number, number, boolean, boolean] => {
        const evs = [...n.nbrs].filter((e) => e.type === "event" && e.start != null).map((e) => e.start!);
        const b = n.birth ?? (n.death != null ? n.death - 40 : evs.length ? Math.min(...evs) - 20 : null);
        const d = n.death ?? (evs.length ? Math.max(...evs) + 5 : b != null ? b + 45 : null);
        return [b ?? 0, d ?? 0, n.birth == null, n.death == null];
      };
      const withSpan = people.map((n) => ({ n, s: span(n) })).filter((p) => p.s[0] || p.s[1])
        .sort((a, b) => a.s[0] - b.s[0] || b.n.deg - a.n.deg);
      const t = el("text", { x: L, y: y + 10, class: "tl-group" }, body);
      t.textContent = `${label.toUpperCase()} · ${withSpan.length}`;
      const sw = el("rect", { x: L - 14, y: y + 3, width: 8, height: 8, rx: 4, class: `sw sw-${side}` }, body);
      void sw;
      y += 22;
      const rows: [number, number][][] = [];
      const [d0, d1] = this.x.domain();
      for (const { n, s: sp } of withSpan) {
        const s = [sp[0], sp[1], sp[2] || sp[0] < d0, sp[3] || sp[1] > d1] as [number, number, boolean, boolean];
        const x0 = clampX(s[0]), x1 = clampX(s[1]);
        const name = n.title.replace(/ \((?:[^)]*)\)$/, "");
        const w = measure.measureText(name).width + 12;
        const labelRight = x1 + w < W - R;
        const a = labelRight ? x0 : x0 - w, bEnd = labelRight ? x1 + w : x1;
        let row = rows.findIndex((r) => r.every(([p, q]) => bEnd < p - 6 || a > q + 6));
        if (row < 0) { row = rows.length; rows.push([]); }
        rows[row].push([a, bEnd]);
        const g = el("g", { class: `tl-item tl-person side-${side}`, transform: `translate(0,${y + row * BR + 8})` }, body) as SVGGElement;
        const gid = `fade-${n.id}`;
        if (s[2] || s[3]) {
          const lg = el("linearGradient", { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 }, g);
          el("stop", { offset: "0", "stop-opacity": s[2] ? 0 : 1, class: "stop" }, lg);
          el("stop", { offset: s[2] ? "0.45" : "0.6", "stop-opacity": 1, class: "stop" }, lg);
          el("stop", { offset: "1", "stop-opacity": s[3] ? 0 : 1, class: "stop" }, lg);
        }
        el("rect", { x: x0, y: -3, width: Math.max(3, x1 - x0), height: 6, rx: 3, class: "tl-bar", fill: s[2] || s[3] ? `url(#${gid})` : null }, g);
        for (const e of n.nbrs) {
          if (e.type !== "event" || e.start == null) continue;
          const l = this.model.linkBetween(n, e);
          if (!l || !(l.types.has("commanded"))) continue;
          const c = el("circle", { cx: clampX(e.start), cy: 0, r: 2.6, class: "tl-dot" }, g);
          const tt = el("title", {}, c); tt.textContent = `${e.title} (${dateLine(e)})`;
        }
        const tx = el("text", labelRight ? { x: x1 + 6, y: 4.5 } : { x: x0 - 6, y: 4.5, "text-anchor": "end" }, g); tx.textContent = name;
        this.items.set(n, { n, row, x0, x1, g });
        this.bindItem(g, n);
      }
      y += rows.length * BR + 22;
    }
    body.setAttribute("width", String(W));
    body.setAttribute("height", String(y + 20));
    this.cursorBody = el("line", { x1: 0, x2: 0, y1: 0, y2: y + 20, class: "tl-cursor-line" }, body) as SVGLineElement;
    this.setYear(Math.max(domain[0], Math.min(domain[1], this.year)), false);
    this.select(this.selected);
  }

  bindItem(g: SVGGElement, n: GNode) {
    g.addEventListener("pointerenter", (ev) => this.cb.onHover(n, ev.clientX, ev.clientY));
    g.addEventListener("pointermove", (ev) => this.cb.onHover(n, ev.clientX, ev.clientY));
    g.addEventListener("pointerleave", () => this.cb.onHover(null, 0, 0));
    g.addEventListener("click", (ev) => { ev.stopPropagation(); this.cb.onClick(n); });
  }

  setYear(y: number, fromUser: boolean) {
    if (!this.x) { this.year = y; return; }
    const [d0, d1] = this.x.domain();
    y = Math.max(d0, Math.min(d1, y));
    this.year = y;
    const px = this.x(y);
    this.cursorHead.setAttribute("transform", `translate(${px},0)`);
    this.cursorHead.querySelector("text")!.textContent = `${-y} BC`;
    this.cursorBody.setAttribute("x1", String(px));
    this.cursorBody.setAttribute("x2", String(px));
    this.root.querySelector(".tl-year")!.textContent = `${-y} BC`;
    let alive = 0;
    const now: GNode[] = [];
    for (const [n, it] of this.items) {
      const future = n.type === "person" ? this.x.invert(it.x0) > y : (n.start ?? 0) > y;
      const past = n.type === "person" ? this.x.invert(it.x1) < y : (n.end ?? n.start ?? 0) < y;
      it.g.classList.toggle("future", future);
      it.g.classList.toggle("past", past && n.type === "person");
      if (n.type === "person" && !future && !past) alive++;
      if (n.type !== "person" && n.start != null && n.start <= y && (n.end ?? n.start) >= y) now.push(n);
    }
    const warNote = y < this.model.war.start ? `${this.model.war.start - y} years before the war`
      : y > this.model.war.end ? `${y - this.model.war.end} years after the war`
      : `Year ${y - this.model.war.start + 1} of the war`;
    this.readout.innerHTML = `<div class="ro-note">${warNote} \u00b7 ${alive} figures within their known lifespans</div>` +
      (now.length ? `<ul>${now.slice(0, 4).map((n) => `<li data-id="${n.id}"><span class="ro-k ro-${n.type}"></span>${esc(n.title)}</li>`).join("")}${now.length > 4 ? `<li class="more">+${now.length - 4} more</li>` : ""}</ul>` : `<ul><li class="more">No dated event this year</li></ul>`);
    this.readout.querySelectorAll("li[data-id]").forEach((li) => li.addEventListener("click", () => this.cb.onClick(this.model.byId.get((li as HTMLElement).dataset.id!)!)));
    if (fromUser) this.cb.onYear(y);
  }

  select(n: GNode | null) {
    this.selected = n;
    if (!this.built) return;
    this.root.classList.toggle("has-selection", !!n);
    for (const [m, it] of this.items) {
      it.g.classList.toggle("sel", m === n);
      it.g.classList.toggle("rel", !!n && n.nbrs.has(m));
    }
    this.links.innerHTML = "";
    if (!n) return;
    const it = this.items.get(n);
    if (it) {
      const top = it.g.getBoundingClientRect().top;
      const sr = this.scroller.getBoundingClientRect();
      if (n.type === "person" && (top < sr.top + 20 || top > sr.bottom - 40)) {
        this.scroller.scrollBy({ top: top - sr.top - sr.height / 3, behavior: "smooth" });
      }
      if (n.type === "person") {
        // career lines: from the person's bar up to the top of the body at each event year
        const ty = Number(it.g.getAttribute("transform")!.match(/,([\d.]+)\)/)![1]);
        for (const e of n.nbrs) {
          if (e.type !== "event" || e.start == null) continue;
          el("line", { x1: this.x(e.start), x2: this.x(e.start), y1: 0, y2: ty, class: "tl-link" }, this.links);
        }
      }
    }
  }

  togglePlay() {
    if (this.playing) return this.stop();
    const [d0, d1] = this.x.domain();
    if (this.year >= d1) this.setYear(d0, true);
    const btn = this.root.querySelector(".tl-play")!;
    btn.innerHTML = `<span class="i">❚❚</span> Pause`;
    this.playing = window.setInterval(() => {
      if (this.year >= this.x.domain()[1]) return this.stop();
      this.setYear(this.year + 1, true);
    }, this.warOnly ? 700 : 420);
  }

  stop() {
    if (!this.playing) return;
    clearInterval(this.playing);
    this.playing = 0;
    this.root.querySelector(".tl-play")!.innerHTML = `<span class="i">▶</span> Play`;
  }
}

export function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
