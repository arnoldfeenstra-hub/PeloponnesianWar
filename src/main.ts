import "./style.css";
import {
  dateLine, fetchGraph, Model, SIDE_LABEL, TYPE_LABEL,
  type GLink, type GNode, type NodeType, type RawEdge,
} from "./data";
import { GraphView } from "./graph";
import { esc, TimelineView } from "./timeline";

type View = "graph" | "timeline" | "path";

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;

const GLYPH: Record<NodeType, string> = { person: "●", event: "◆", polity: "◎", work: "■" };

async function boot() {
  const { graph, source } = await fetchGraph();
  const model = new Model(graph);
  document.body.dataset.source = source;
  const app = new App(model, source);
  (window as any).__app = app; // handy for QA scripts
}

class App {
  view: View = "graph";
  graph: GraphView;
  timeline: TimelineView;
  selected: GNode | null = null;
  pathFrom: GNode | null = null;
  pathTo: GNode | null = null;
  paths: GNode[][] = [];
  pathIdx = 0;
  hoverEl = $("#hovercard");
  panel = $("#panel");
  graphYear: number | null = null;
  playTimer = 0;

  constructor(public model: Model, public source: string) {
    this.graph = new GraphView($("#graph-view"), model, {
      onHover: (n, x, y) => this.hover(n, x, y),
      onClick: (n) => (n ? this.go(this.view === "path" ? "graph" : this.view, n) : this.clear()),
      onDblClick: (n) => this.expand(n),
    });
    this.timeline = new TimelineView($("#timeline-view"), model, {
      onHover: (n, x, y) => this.hover(n, x, y),
      onClick: (n) => (n ? this.go("timeline", n) : this.clear()),
      onYear: () => {},
    });
    this.fillStats();
    this.bindChrome();
    this.bindSearch($("#search"), (n) => this.go(this.view === "path" ? "graph" : this.view, n));
    this.bindPath();
    window.addEventListener("hashchange", () => this.route());
    this.route();
    requestAnimationFrame(() => document.body.classList.add("ready"));
    // Canvas text is drawn with the web fonts: redraw (and re-measure) once they arrive.
    document.fonts?.ready.then(() => { (this.graph as any).widthCache.clear(); this.graph.dirty = true; if (this.view === "timeline") this.timeline.build(); });
  }

  // ------------------------------------------------------------- routing
  go(view: View, n?: GNode | null) {
    const h = view === "path"
      ? `#path${this.pathFrom ? "/" + this.pathFrom.id : ""}${this.pathTo ? "/" + this.pathTo.id : ""}`
      : `#${view}${n ? "/" + n.id : ""}`;
    if (location.hash === h) this.route(); else location.hash = h;
  }

  route() {
    const [v, a, b] = location.hash.replace(/^#/, "").split("/");
    const view: View = v === "timeline" ? "timeline" : v === "path" ? "path" : "graph";
    this.setView(view);
    if (view === "path") {
      this.pathFrom = (a && this.model.byId.get(a)) || this.pathFrom;
      this.pathTo = (b && this.model.byId.get(b)) || this.pathTo;
      this.syncPathInputs();
      if (this.pathFrom && this.pathTo) this.runPath();
      return;
    }
    const n = a ? this.model.byId.get(a) ?? null : null;
    if (n) this.select(n); else if (!a) this.clear(false);
  }

  setView(v: View) {
    if (v !== "path" && this.view === "path") { this.graph.setPath(null); }
    this.view = v;
    document.body.dataset.view = v;
    document.querySelectorAll<HTMLButtonElement>(".views button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("#graph-view").hidden = v === "timeline";
    $("#timeline-view").hidden = v !== "timeline";
    if (v === "timeline") this.timeline.show();
    else this.graph.resize();
  }

  // ------------------------------------------------------------- selection
  select(n: GNode) {
    this.selected = n;
    this.renderPanel(n);
    document.body.classList.add("panel-open");
    if (this.view === "timeline") this.timeline.select(n);
    else this.graph.select(n);
    this.timeline.selected = n;
    this.hover(null, 0, 0);
  }

  expand(n: GNode) {
    if (this.view !== "graph") return;
    if (!this.graph.focus) return this.go("graph", n);
    this.graph.select(n, { expand: true });
    this.selected = n;
    this.renderPanel(n);
    document.body.classList.add("panel-open");
    history.replaceState(null, "", `#graph/${n.id}`);
    this.toast(`Expanded ${n.title} — ${n.nbrs.size} connections added to the view`);
  }

  clear(updateHash = true) {
    this.selected = null;
    document.body.classList.remove("panel-open");
    this.graph.select(null);
    this.timeline.select(null);
    if (updateHash && this.view !== "path" && location.hash.includes("/")) history.replaceState(null, "", `#${this.view}`);
  }

  // ------------------------------------------------------------- hover card
  hover(n: GNode | null, x: number, y: number) {
    const el = this.hoverEl;
    if (!n) { el.classList.remove("on"); return; }
    const img = n.img?.url || n.art?.url;
    el.innerHTML = `
      ${img ? `<div class="hc-img" style="background-image:url('${esc(img.replace(/\/(\d+)px-/, "/330px-"))}')"></div>` : `<div class="hc-img hc-glyph t-${n.type} s-${n.side ?? "none"}"><span>${esc(initials(n.title))}</span></div>`}
      <div class="hc-body">
        <div class="kicker">${kicker(n)}</div>
        <div class="hc-title">${esc(n.title)}</div>
        ${dateLine(n) ? `<div class="hc-date">${esc(dateLine(n))}</div>` : ""}
        ${n.desc ? `<div class="hc-desc">${esc(n.desc)}</div>` : ""}
        <div class="hc-hint">${n.nbrs.size} connections · click to focus${this.view === "graph" ? " · double-click to expand" : ""}</div>
      </div>`;
    el.classList.add("on");
    const r = el.getBoundingClientRect();
    let px = x + 18, py = y + 18;
    if (px + r.width > innerWidth - 12) px = x - r.width - 18;
    if (py + r.height > innerHeight - 12) py = innerHeight - r.height - 12;
    el.style.transform = `translate(${Math.max(8, px)}px, ${Math.max(8, py)}px)`;
  }

  // ------------------------------------------------------------- side panel
  renderPanel(n: GNode) {
    const m = this.model;
    const groups = new Map<string, { n: GNode; e: RawEdge; l: GLink }[]>();
    const add = (k: string, o: GNode, e: RawEdge, l: GLink) => { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push({ n: o, e, l }); };
    for (const l of n.links) {
      const o = l.source === n ? l.target : l.source;
      const rels = [...l.rels].sort((a, b) => relRank(a.type) - relRank(b.type));
      const e = rels[0];
      const fwd = e.source === n.id;
      const key = e.type === "commanded" ? (fwd ? "Commanded at" : "Commanders")
        : e.type === "fought" ? (fwd ? "Fought at" : "Combatants")
        : e.type === "wrote" ? (fwd ? "Wrote" : "Written by")
        : e.type === "allegiance" ? (fwd ? "Allegiance" : "Figures who served it")
        : "Linked in Wikipedia prose";
      add(key, o, e, l);
    }
    const order = ["Commanders", "Combatants", "Commanded at", "Fought at", "Wrote", "Written by", "Allegiance", "Linked in Wikipedia prose", "Figures who served it"];
    const img = n.img;
    const art = n.art;
    const hero = img
      ? `<figure class="hero"><img src="${esc(img.url)}" alt="${esc(n.title)}" loading="lazy"><figcaption>${esc(stripHtml(img.artist ?? "Unknown"))} · <a href="${esc(img.page)}" target="_blank" rel="noopener">${esc(img.license)}, Wikimedia Commons</a></figcaption></figure>`
      : art
      ? `<figure class="hero art"><img src="${esc(art.url)}" alt="Illustration for ${esc(n.title)}" loading="lazy"><figcaption><span class="ai">AI illustration</span> generated with ChatGPT Image · decorative, not a historical source</figcaption></figure>`
      : `<div class="hero glyph t-${n.type} s-${n.side ?? "none"}"><span>${esc(initials(n.title))}</span></div>`;
    const facts: string[] = [];
    if (dateLine(n)) facts.push(`<div><dt>${n.type === "person" ? "Lived" : "Date"}</dt><dd>${esc(dateLine(n))}</dd></div>`);
    if (n.result) facts.push(`<div><dt>Result</dt><dd>${esc(n.result)}</dd></div>`);
    if (n.location) facts.push(`<div><dt>Where</dt><dd>${esc(n.location)}</dd></div>`);
    if (n.phase) facts.push(`<div><dt>Phase</dt><dd>${esc(n.phase)}</dd></div>`);
    if (n.side) facts.push(`<div><dt>Side</dt><dd>${esc(SIDE_LABEL[n.side])}<span class="prov">${esc(n.side_src ?? "")}</span></dd></div>`);
    const rev = `${n.url}?oldid=${n.revid}`;
    this.panel.innerHTML = `
      <button class="close" aria-label="Close panel">×</button>
      ${hero}
      <div class="p-body">
        <div class="kicker">${kicker(n)}</div>
        <h2>${esc(n.title)}</h2>
        ${n.desc ? `<p class="p-desc">${esc(n.desc)}</p>` : ""}
        ${facts.length ? `<dl class="facts">${facts.join("")}</dl>` : ""}
        ${n.bio ? `<p class="p-bio">${esc(n.bio)}</p>` : ""}
        ${n.dyk ? `<aside class="dyk"><div class="kicker">Did you know…</div><p>${esc(n.dyk.replace(/^\.\.\.\s*/, "… "))}</p><div class="src">Wikipedia’s “Did you know” feature</div></aside>` : ""}
        ${n.story ? `<section class="story"><div class="kicker">From “${esc(n.story_section ?? "")}”</div><p>${esc(n.story)}</p></section>` : ""}
        <div class="actions">
          <button data-act="path">Find a path from here</button>
          <button data-act="${this.view === "timeline" ? "graph" : "timeline"}">${this.view === "timeline" ? "Show in graph" : "Show on timeline"}</button>
        </div>
        <section class="conns">
          ${order.filter((k) => groups.has(k)).map((k) => {
            const list = groups.get(k)!.sort((a, b) => b.n.deg - a.n.deg);
            return `<div class="cgroup"><h3>${k} <span>${list.length}</span></h3><ul>${list.map(({ n: o, e, l }) => {
              const flags = l.rels.flatMap((r) => r.flags ?? []);
              const ev = l.rels.find((r) => r.type === "mentions" && r.evidence);
              return `<li><button class="conn" data-id="${o.id}"><span class="g t-${o.type} s-${o.side ?? "none"}">${GLYPH[o.type]}</span><span class="cn">${esc(o.title)}</span>${dateLine(o) ? `<span class="cd">${esc(dateLine(o))}</span>` : ""}${flags.length ? `<span class="flag">${esc([...new Set(flags)].join(", "))}</span>` : ""}</button>${e.type === "mentions" && ev ? `<blockquote>${esc(ev.evidence!)} <a href="${esc(ev.evidence_url ?? "")}" target="_blank" rel="noopener">↗</a></blockquote>` : ""}</li>`;
            }).join("")}</ul></div>`;
          }).join("")}
        </section>
        <p class="p-src">Text from the Wikipedia article <a href="${esc(rev)}" target="_blank" rel="noopener">“${esc(n.title)}” (revision ${n.revid})</a>, CC BY-SA 4.0. <a href="${esc(n.url)}" target="_blank" rel="noopener">Read on Wikipedia ↗</a></p>
      </div>`;
    this.panel.scrollTop = 0;
    $(".close", this.panel).addEventListener("click", () => this.clear());
    this.panel.querySelectorAll<HTMLButtonElement>(".conn").forEach((b) =>
      b.addEventListener("click", () => this.go(this.view === "path" ? "graph" : this.view, m.byId.get(b.dataset.id!)!)));
    this.panel.querySelectorAll<HTMLButtonElement>(".conn").forEach((b) => {
      b.addEventListener("pointerenter", () => { if (this.view === "graph") { this.graph.hover = m.byId.get(b.dataset.id!)!; this.graph.dirty = true; } });
      b.addEventListener("pointerleave", () => { this.graph.hover = null; this.graph.dirty = true; });
    });
    this.panel.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.act!;
      if (act === "path") { this.pathFrom = n; this.pathTo = null; this.go("path"); $<HTMLInputElement>("#path-to").focus(); }
      else this.go(act as View, n);
    }));
  }

  // ------------------------------------------------------------- search
  bindSearch(input: HTMLInputElement, pick: (n: GNode) => void, types?: NodeType[]) {
    const wrap = input.parentElement!;
    const list = document.createElement("ul");
    list.className = "results";
    list.setAttribute("role", "listbox");
    wrap.appendChild(list);
    let items: GNode[] = [], active = 0;
    const render = () => {
      list.innerHTML = items.map((n, i) => `<li role="option" class="${i === active ? "on" : ""}" data-i="${i}"><span class="g t-${n.type} s-${n.side ?? "none"}">${GLYPH[n.type]}</span><span class="rt">${esc(n.title)}</span><span class="rd">${esc(dateLine(n) || TYPE_LABEL[n.type])}</span></li>`).join("");
      list.classList.toggle("on", items.length > 0);
    };
    const choose = (n: GNode) => { items = []; render(); input.blur(); pick(n); };
    input.addEventListener("input", () => { items = this.model.search(input.value, types); active = 0; render(); });
    input.addEventListener("focus", () => { if (input.value) { items = this.model.search(input.value, types); render(); } });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); ev.preventDefault(); }
      else if (ev.key === "ArrowUp") { active = Math.max(0, active - 1); render(); ev.preventDefault(); }
      else if (ev.key === "Enter" && items[active]) { choose(items[active]); ev.preventDefault(); }
      else if (ev.key === "Escape") { items = []; render(); input.blur(); }
    });
    list.addEventListener("pointerdown", (ev) => {
      const li = (ev.target as HTMLElement).closest("li");
      if (li) { ev.preventDefault(); choose(items[Number(li.dataset.i)]); }
    });
    input.addEventListener("blur", () => setTimeout(() => { list.classList.remove("on"); }, 120));
  }

  // ------------------------------------------------------------- six degrees
  bindPath() {
    const from = $<HTMLInputElement>("#path-from"), to = $<HTMLInputElement>("#path-to");
    this.bindSearch(from, (n) => { this.pathFrom = n; this.go("path"); }, ["person"]);
    this.bindSearch(to, (n) => { this.pathTo = n; this.go("path"); }, ["person"]);
    $("#path-swap").addEventListener("click", () => { [this.pathFrom, this.pathTo] = [this.pathTo, this.pathFrom]; this.go("path"); });
    $("#path-random").addEventListener("click", () => this.randomPath());
    $("#path-again").addEventListener("click", () => {
      if (this.paths.length < 2) return;
      this.pathIdx = (this.pathIdx + 1) % this.paths.length;
      this.showPath();
    });
    $<HTMLInputElement>("#path-polities").addEventListener("change", () => this.runPath());
    $<HTMLInputElement>("#path-strong").addEventListener("change", () => this.runPath());
  }

  syncPathInputs() {
    $<HTMLInputElement>("#path-from").value = this.pathFrom?.title ?? "";
    $<HTMLInputElement>("#path-to").value = this.pathTo?.title ?? "";
    if (!(this.pathFrom && this.pathTo)) {
      this.graph.setPath(null);
      $("#path-result").innerHTML = `<p class="hint">Pick two figures. The shortest chain of documented links between them — commands, battles, works and sentences in their Wikipedia articles — is traced across the web.</p>`;
    }
  }

  randomPath() {
    const people = this.model.nodes.filter((n) => n.type === "person" && n.deg >= 3);
    for (let i = 0; i < 50; i++) {
      const a = people[Math.floor(Math.random() * people.length)], b = people[Math.floor(Math.random() * people.length)];
      if (a === b || a.nbrs.has(b)) continue;
      const strongOnly = $<HTMLInputElement>("#path-strong").checked;
      const p = this.model.shortestPaths(a, b, { viaPolities: false, viaWorks: true, strongOnly }, 1);
      if (p.length && p[0].length >= 4) { this.pathFrom = a; this.pathTo = b; this.go("path"); return; }
    }
  }

  runPath() {
    if (!this.pathFrom || !this.pathTo) return;
    const viaPolities = $<HTMLInputElement>("#path-polities").checked;
    const strongOnly = $<HTMLInputElement>("#path-strong").checked;
    this.paths = this.model.shortestPaths(this.pathFrom, this.pathTo, { viaPolities, viaWorks: true, strongOnly });
    this.pathIdx = 0;
    this.showPath();
  }

  showPath() {
    const box = $("#path-result");
    const p = this.paths[this.pathIdx];
    if (!p) {
      this.graph.setPath(null);
      const strong = $<HTMLInputElement>("#path-strong").checked;
      const pol = $<HTMLInputElement>("#path-polities").checked;
      box.innerHTML = `<p class="hint">No documented chain connects ${esc(this.pathFrom!.title)} and ${esc(this.pathTo!.title)}${strong ? " using battlefield and authorship links alone" : pol ? "" : " without passing through a city-state"}. ${strong || !pol ? "Try relaxing the options above." : ""}</p>`;
      return;
    }
    this.graph.setPath(p);
    document.body.classList.remove("panel-open");
    const deg = p.length - 1;
    const steps = p.slice(0, -1).map((a, i) => {
      const b = p[i + 1];
      const l = this.model.linkBetween(a, b)!;
      return `<li style="--d:${i}"><div class="hop"><span class="g t-${a.type} s-${a.side ?? "none"}">${GLYPH[a.type]}</span><button class="conn" data-id="${a.id}">${esc(a.title)}</button></div>${hopText(a, b, l)}</li>`;
    }).join("");
    const last = p[p.length - 1];
    box.innerHTML = `
      <div class="deg"><span class="n">${deg}</span><span>degree${deg === 1 ? "" : "s"} of separation</span></div>
      <ol class="chain">${steps}<li style="--d:${p.length - 1}"><div class="hop"><span class="g t-${last.type} s-${last.side ?? "none"}">${GLYPH[last.type]}</span><button class="conn" data-id="${last.id}">${esc(last.title)}</button></div></li></ol>
      ${this.paths.length > 1 ? `<p class="alt">Route ${this.pathIdx + 1} of ${this.paths.length >= 24 ? "24+" : this.paths.length} equally short</p>` : ""}`;
    $("#path-again").hidden = this.paths.length < 2;
    box.querySelectorAll<HTMLButtonElement>(".conn").forEach((b) => b.addEventListener("click", () => {
      const n = this.model.byId.get(b.dataset.id!)!;
      this.renderPanel(n); document.body.classList.add("panel-open");
    }));
  }

  // ------------------------------------------------------------- chrome
  bindChrome() {
    document.querySelectorAll<HTMLButtonElement>(".views button").forEach((b) =>
      b.addEventListener("click", () => this.go(b.dataset.v as View, b.dataset.v === "path" ? null : this.selected)));
    $("#zoom-in").addEventListener("click", () => this.graph.zoomBy(1.4));
    $("#zoom-out").addEventListener("click", () => this.graph.zoomBy(1 / 1.4));
    $("#zoom-fit").addEventListener("click", () => { this.clear(); this.graph.fitAll(); });
    $("#theme").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch { /* ignore */ }
      this.graph.readPalette();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.graph.readPalette());
    document.addEventListener("keydown", (ev) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (ev.key === "/" && tag !== "INPUT") { ev.preventDefault(); $<HTMLInputElement>("#search").focus(); }
      if (ev.key === "Escape" && tag !== "INPUT") { $("#about").hidden = true; this.clear(); }
    });
    $("#about-open").addEventListener("click", () => ($("#about").hidden = false));
    $("#about").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget || (ev.target as HTMLElement).matches(".close")) $("#about").hidden = true; });
    $("#intro-go").addEventListener("click", () => {
      document.body.classList.add("intro-done");
      try { localStorage.setItem("intro", "1"); } catch { /* ignore */ }
    });
    try { if (localStorage.getItem("intro")) document.body.classList.add("intro-done"); } catch { /* ignore */ }

    // "the web as of" year scrubber for the graph
    const slider = $<HTMLInputElement>("#year");
    const label = $("#year-label");
    const war = this.model.war;
    slider.min = String(war.start - 12); slider.max = String(war.end + 6); slider.value = slider.max;
    const setY = (y: number | null) => {
      this.graphYear = y;
      this.graph.setYear(y);
      label.textContent = y == null ? "All years" : `${-y} BC`;
      $("#year-all").classList.toggle("on", y == null);
      if (y != null) slider.value = String(y);
    };
    slider.addEventListener("input", () => { this.stopPlay(); setY(Number(slider.value)); });
    $("#year-all").addEventListener("click", () => { this.stopPlay(); setY(null); slider.value = slider.max; });
    $("#year-play").addEventListener("click", () => {
      if (this.playTimer) return this.stopPlay();
      let y = this.graphYear == null || this.graphYear >= Number(slider.max) ? Number(slider.min) : this.graphYear;
      setY(y);
      $("#year-play").textContent = "❚❚";
      this.playTimer = window.setInterval(() => {
        y += 1;
        if (y > Number(slider.max)) { this.stopPlay(); return; }
        setY(y);
      }, 650);
    });
  }

  stopPlay() {
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = 0; }
    $("#year-play").textContent = "▶";
  }

  fillStats() {
    const c = (t: NodeType) => this.model.nodes.filter((n) => n.type === t).length;
    const withImg = this.model.nodes.filter((n) => n.img).length;
    const withArt = this.model.nodes.filter((n) => n.art).length;
    const mentions = this.model.links.filter((l) => l.types.has("mentions")).length;
    const stats = `<b>${c("person")}</b> figures · <b>${c("event")}</b> events · <b>${c("polity")}</b> polities · <b>${c("work")}</b> works · <b>${this.model.links.length}</b> connections`;
    document.querySelectorAll(".stats").forEach((e) => (e.innerHTML = stats));
    $("#intro-lead").textContent = this.model.war.lead;
    $("#about-counts").innerHTML = `${stats}. ${mentions} connections are sentences in which one article links another; ${withImg} nodes carry a public-domain image from Wikimedia Commons${withArt ? ` and ${withArt} an AI illustration` : ""}. Served from ${this.source === "database" ? "the Neon Postgres database" : "a snapshot exported from the Neon Postgres database"}.`;
  }

  toast(msg: string) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout((t as any)._t);
    (t as any)._t = setTimeout(() => t.classList.remove("on"), 2600);
  }
}

function relRank(t: string) { return ["commanded", "wrote", "fought", "mentions", "allegiance"].indexOf(t); }

function hopText(a: GNode, b: GNode, l: GLink): string {
  const rels = [...l.rels].sort((x, y) => relRank(x.type) - relRank(y.type));
  const e = rels[0];
  const fwd = e.source === a.id;
  const src = fwd ? a : b, tgt = fwd ? b : a;
  const flags = (e.flags ?? []).length ? ` (${esc(e.flags!.join(", "))})` : "";
  let text = "";
  switch (e.type) {
    case "commanded": text = `${esc(src.title)} commanded at ${esc(tgt.title)}${flags}`; break;
    case "fought": text = `${esc(src.title)} fought at ${esc(tgt.title)}`; break;
    case "wrote": text = `${esc(src.title)} wrote ${esc(tgt.title)}`; break;
    case "allegiance": text = `${esc(src.title)} served ${esc(tgt.title)}`; break;
    case "mentions": text = `Wikipedia’s article on ${esc(src.title)} links to ${esc(tgt.title)}`; break;
  }
  const ev = rels.find((r) => r.type === "mentions" && r.evidence);
  return `<div class="rel"><span class="rel-t">${text}</span>${ev ? `<blockquote>${esc(ev.evidence!)} <a href="${esc(ev.evidence_url ?? "")}" target="_blank" rel="noopener">source ↗</a></blockquote>` : e.evidence ? `<div class="rel-src">${esc(e.evidence)}</div>` : ""}</div>`;
}

function kicker(n: GNode) {
  const side = n.side ? SIDE_LABEL[n.side] : null;
  return `<span class="g t-${n.type} s-${n.side ?? "none"}">${GLYPH[n.type]}</span> ${TYPE_LABEL[n.type].toUpperCase()}${side ? ` · ${side.toUpperCase()}` : ""}`;
}

function initials(t: string) {
  const w = t.replace(/\(.*\)/, "").replace(/^(Battle|Siege|Peace|Classical|Ancient) of |^(Battle|Siege|Classical|Ancient) /, "").trim();
  return w.charAt(0);
}

function stripHtml(s: string) { return s.replace(/<[^>]+>/g, "").trim(); }

boot().catch((err) => {
  console.error(err);
  document.body.classList.add("failed");
  const f = document.querySelector("#loading");
  if (f) f.textContent = "The data could not be loaded.";
});
