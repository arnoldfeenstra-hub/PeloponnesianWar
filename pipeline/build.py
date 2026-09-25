"""Stage 2: fetch every node's Wikipedia content and derive the graph.

Nothing here is invented: bios, stories and "did you know" hooks are verbatim
Wikipedia text; dates are parsed from infoboxes / short descriptions / lead
parentheticals; edges come from battle infoboxes (commanders, combatants),
play/book infoboxes (writer), Wikipedia categories (Athenians/Spartans of the
Peloponnesian War) and in-prose article links (with the linking sentence kept
as evidence). Images are Wikimedia Commons files whose licence is public
domain or CC0.
"""
import collections
import json
import os
import re
import unicodedata
import urllib.parse

import mwparserfromhell as mw
from bs4 import BeautifulSoup

import prose
import wiki

OUT = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT, exist_ok=True)

WAR = (-431, -404)

# Some combatant links point at the modern city's article; use the article
# Wikipedia itself has for the classical polity instead.
POLITY_ALIAS = {
    "Athens": "Classical Athens",
    "Corinth": "Ancient Corinth",
    "Argos, Peloponnese": "Ancient Argos",
    "Argos": "Ancient Argos",
    "Thebes, Greece": "Thebes, Greece",
}

PERSON_SECTIONS = r"death|later life|legacy|trial|exile|execution|assassination|downfall|character|anecdote|assessment|reputation|return|recall|fall|final|last|career|life"
EVENT_SECTIONS = r"battle|aftermath|consequences|significance|legacy|siege|engagement|course|prelude|background"
WORK_SECTIONS = r"plot|synopsis|legacy|reception|content|historical|context|summary|themes"


# ---------------------------------------------------------------- helpers
def slug(title):
    s = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s


def wiki_url(title):
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe="(),'")


def ucfirst(t):
    return t[0].upper() + t[1:] if t else t


def link_target(l):
    t = str(l.title).split("#")[0].strip().replace("_", " ")
    return ucfirst(t)


def plain(value):
    """Wikitext -> readable text, keeping template params (e.g. {{circa|450}})."""
    code = mw.parse(value)
    for tag in code.filter_tags(recursive=True):
        if str(tag.tag).lower() == "ref":
            try:
                code.remove(tag)
            except ValueError:
                pass
    for tp in code.filter_templates(recursive=True):
        n = str(tp.name).strip().lower()
        if n in ("sfn", "efn", "refn", "citation needed", "cn", "#tag:ref", "r", "rp") or n.startswith("cite"):
            try:
                code.remove(tp)
            except ValueError:
                pass
    s = code.strip_code(normalize=True, collapse=True, keep_template_params=True)
    return re.sub(r"\s+", " ", s).strip()


def infobox(text):
    for tp in mw.parse(text).filter_templates(recursive=False):
        if str(tp.name).strip().lower().startswith("infobox"):
            return {str(p.name).strip(): str(p.value) for p in tp.params}
    return {}


YEAR = r"(\d{1,4})(?:s)?"


def parse_span(text, default_bc=False):
    """Return (years, approx) from a date string: every '### BC' year found."""
    if not text:
        return [], False
    t = text.replace("–", "-").replace("—", "-").replace("−", "-")
    t = re.sub(r"\bBCE\b", "BC", t)
    approx = bool(re.search(r"\bc\.|circa|\bca\.|about|around|\bfl\.", t, re.I))
    years = []
    # ranges "431-404 BC" / "431 BC - 404 BC"
    for m in re.finditer(r"(\d{2,4})\s*(?:BC)?\s*-\s*(\d{2,4})\s*BC", t):
        a, b = int(m.group(1)), int(m.group(2))
        if a >= b:  # BC ranges count down
            years += [-a, -b]
    for m in re.finditer(r"(\d{2,4})\s*BC", t):
        years.append(-int(m.group(1)))
    if years and not re.search(r"\bAD\b|\bCE\b", t):
        years += [-int(x) for x in re.findall(r"(?<![\d,.])(\d{3})(?![\d,])", t)]
    if not years and default_bc and not re.search(r"\bAD\b|\bCE\b", t):
        for m in re.finditer(r"\b(\d{3})\b", t):
            years.append(-int(m.group(1)))
    return sorted(set(years)), approx


def clean_lead(p):
    p = re.sub(r"\(\s*(?:or\s*)?[;,]\s*", "(", p)
    p = re.sub(r"\(\s*(?:or\s*)?\)", "", p)
    p = re.sub(r"\s{2,}", " ", p)
    return p.strip()


def first_paren(text):
    m = re.search(r"\(([^()]*\d[^()]*)\)", text or "")
    return m.group(1) if m else ""


def person_dates(ib, desc, lead):
    birth = death = None
    approx_b = approx_d = False
    fl = None
    b_raw = ib.get("birth_date", "") or ib.get("born", "")
    d_raw = ib.get("death_date", "") or ib.get("died", "")
    ys, ap = parse_span(plain(b_raw) + (" c." if "circa" in b_raw.lower() else ""))
    if ys:
        birth, approx_b = ys[0], ap
    ys, ap = parse_span(plain(d_raw) + (" c." if "circa" in d_raw.lower() else ""))
    if ys:
        death, approx_d = ys[-1], ap
    for src in (first_paren(desc), first_paren(lead)):
        if birth is not None and death is not None:
            break
        if not src:
            continue
        s = src.replace("–", "-")
        ys, ap = parse_span(s, default_bc=True)
        if not ys:
            continue
        low = s.lower()
        if re.search(r"\bdied\b|\bd\.", low) and "-" not in s:
            death = death if death is not None else ys[-1]
            approx_d = approx_d or ap
        elif re.search(r"\bborn\b|\bb\.", low) and "-" not in s:
            birth = birth if birth is not None else ys[0]
            approx_b = approx_b or ap
        elif re.search(r"fl\.|floruit|flourished", low):
            fl = fl or ys
        elif "-" in s and len(ys) >= 2:
            if birth is None:
                birth, approx_b = ys[0], ap
            if death is None:
                death, approx_d = ys[-1], ap
        elif len(ys) == 1 and "-" in s:
            # "c. 450 - 404 BC" parsed as a range already; lone year + dash
            if birth is None and s.strip().endswith("-"):
                birth = ys[0]
    if birth is not None and death is not None and birth > death:
        birth, death = death, birth
    return dict(birth=birth, death=death, birth_approx=approx_b, death_approx=approx_d,
                floruit=fl)


def event_dates(ib, desc, title, lead):
    for src in (plain(ib.get("date", "")), first_paren(title), first_paren(desc), desc,
                first_paren(lead)):
        ys, ap = parse_span(src)
        if ys:
            return dict(start=ys[0], end=ys[-1], approx=ap)
    m = re.search(r"(\d{3})\s*BC", lead or "")
    if m:
        return dict(start=-int(m.group(1)), end=-int(m.group(1)), approx=True)
    return dict(start=None, end=None, approx=False)


def work_dates(ib, desc, lead):
    for k in ("date_premiered", "premiere", "date", "published", "pub_date",
              "release_date", "written", "date_written"):
        if ib.get(k):
            ys, ap = parse_span(plain(ib[k]))
            if ys:
                return dict(start=ys[0], end=ys[-1], approx=ap)
    for src in (first_paren(desc), desc, first_paren(lead)):
        ys, ap = parse_span(src)
        if ys:
            return dict(start=ys[0], end=ys[-1], approx=ap)
    m = re.search(r"(?:produced|performed|staged|written|premiered|composed)[^.]{0,160}?(\d{3})\s*BC", lead or "")
    if m:
        return dict(start=-int(m.group(1)), end=-int(m.group(1)), approx=False)
    return dict(start=None, end=None, approx=False)


def split_markers(raw):
    """[(target, display, flags)] for each wikilink in an infobox field."""
    out = []
    matches = list(re.finditer(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]", raw))
    for i, m in enumerate(matches):
        tail = raw[m.end(): matches[i + 1].start() if i + 1 < len(matches) else len(raw)]
        tail = re.split(r"<br|\n\s*\*|\|\[\[", tail)[0]
        flags = []
        if re.search(r"\{\{\s*KIA|†|killed", tail, re.I):
            flags.append("killed in action")
        if re.search(r"\{\{\s*POW|captured|prisoner", tail, re.I):
            flags.append("captured")
        if re.search(r"\{\{\s*Executed|executed", tail, re.I):
            flags.append("executed")
        if re.search(r"\{\{\s*WIA|wounded", tail, re.I):
            flags.append("wounded")
        out.append((ucfirst(m.group(1).strip().replace("_", " ")), (m.group(2) or m.group(1)).strip(), flags))
    return out


ABBR = re.compile(r"\b(c|ca|fl|St|Mt|i\.e|e\.g|cf|vol|pp?|ed|Jr|Sr|Dr|Mr|Mrs|no)\.$", re.I)


def sentences(text):
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\"“(])", text)
    out, buf = [], ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if ABBR.search(buf) or re.search(r"\b[A-Z]\.$", buf):
            continue
        out.append(buf)
        buf = ""
    if buf:
        out.append(buf)
    return out


def trim(text, limit):
    if len(text) <= limit:
        return text
    out = ""
    for s in sentences(text):
        if len(out) + len(s) + 1 > limit and out:
            break
        out = (out + " " + s).strip()
    return out if out else text[:limit].rsplit(" ", 1)[0] + "…"


# ---------------------------------------------------------------- fetch
def fetch_html(title):
    t = urllib.parse.quote(title.replace(" ", "_"), safe="")
    return wiki._get_text(f"https://en.wikipedia.org/api/rest_v1/page/html/{t}")


def parse_html(html):
    """Paragraph list [(section, text, [(href_title, sentence_index)])]."""
    soup = BeautifulSoup(html, "html.parser")
    for sel in ["sup.reference", "sup.noprint", "span.mw-ref", "style", "table",
                "figure", "div.navbox", "div.reflist", "div.hatnote", ".mw-editsection",
                "span.rt-commentedText", "div.thumb"]:
        for el in soup.select(sel):
            el.decompose()
    out = []
    stop = re.compile(r"^(see also|references|notes|further reading|external links|sources|bibliography|citations|footnotes|works cited|primary sources|secondary sources)$", re.I)
    for sec in soup.find_all("section"):
        h = sec.find(["h2", "h3", "h4"], recursive=False)
        name = h.get_text(" ", strip=True) if h else "Lead"
        top = sec
        while top.parent and top.parent.name == "section":
            top = top.parent
        th = top.find(["h2"], recursive=False)
        if th and stop.match(th.get_text(" ", strip=True)):
            continue
        if stop.match(name):
            continue
        for p in sec.find_all("p", recursive=False):
            text = re.sub(r"\s+", " ", p.get_text("", strip=False)).strip()
            text = re.sub(r"\s+([,.;:])", r"\1", text)
            if len(text) < 40:
                continue
            sents = sentences(text)
            links = []
            for a in p.find_all("a", rel=lambda r: r and "mw:WikiLink" in r):
                href = a.get("href", "")
                if not href.startswith("./"):
                    continue
                tgt = urllib.parse.unquote(href[2:].split("#")[0]).replace("_", " ")
                anchor = a.get_text("", strip=True)
                idx = next((i for i, s in enumerate(sents) if anchor and anchor in s), None)
                links.append((ucfirst(tgt), idx))
            out.append((name, text, sents, links))
    return out


def dyk_hooks(talk_text):
    hooks = []
    if not talk_text:
        return hooks
    for tp in mw.parse(talk_text).filter_templates():
        n = str(tp.name).strip().lower()
        for key in ("entry", "dykentry", "hook"):
            if n in ("dyk talk", "dyktalk", "dyk talk/multiple", "articlehistory", "article history") \
                    and tp.has(key):
                h = plain(str(tp.get(key).value))
                if "..." in h or h.lower().startswith("that"):
                    hooks.append(h)
        if n in ("dyk talk", "dyktalk") and not tp.has("entry"):
            for p in tp.params:
                v = str(p.value)
                if v.strip().startswith("...") or "... that" in v:
                    hooks.append(plain(v))
    return hooks


# ---------------------------------------------------------------- main
def main():
    rows = json.load(open(os.path.join(os.path.dirname(__file__), "candidates.json")))
    by_title = {}
    for r in rows:
        by_title.setdefault(r["title"], r)
    seed_people = {t for t, r in by_title.items() if r["seed"] and r["kind"] == "person"}
    seed_events = {t for t, r in by_title.items() if r["seed"] and r["kind"] == "event"}
    seed_events.discard("Peloponnesian War")
    cand_people = {t for t, r in by_title.items() if not r["seed"] and r["kind"] == "person"}
    cand_events = {t for t, r in by_title.items() if not r["seed"] and r["kind"] == "event"}
    # Events whose article lacks the usual title words but are core (from the war category)
    for t, r in by_title.items():
        if r["seed"] and r["kind"] is None and re.search(r"treaty|conflict|event", r["infobox"]):
            seed_events.add(t)
    for t in ("Thirty Years' Peace",):
        cand_events.add(t)

    pool = sorted(seed_people | seed_events | cand_people | cand_events | {"Peloponnesian War"})
    pages = wiki.batch_pages(pool, "revisions|pageprops|pageimages",
                             rvprop="content|ids", rvslots="main", piprop="name")
    pages = {t: p for t, p in pages.items() if p and "revisions" in p}
    leads = wiki.batch_pages(list(pages), "extracts", per=20, exintro=1, explaintext=1,
                             exlimit=20, exsectionformat="plain")

    def meta(t):
        p = pages[t]
        text = p["revisions"][0]["slots"]["main"]["content"]
        lead = (leads.get(t) or {}).get("extract", "") or ""
        return dict(title=p["title"], text=text, ib=infobox(text), revid=p["revisions"][0]["revid"],
                    desc=p.get("pageprops", {}).get("wikibase-shortdesc", ""), lead=lead,
                    image=p.get("pageimage"), pageid=p["pageid"])

    nodes = {}

    def add(t, kind, seed):
        m = meta(t)
        if m["title"] in nodes:
            return nodes[m["title"]]
        n = dict(id=slug(m["title"]), type=kind, seed=seed, **m)
        nodes[m["title"]] = n
        return n

    seed_work_authors = []
    for t in sorted(pages):
        if t == "Peloponnesian War":
            continue
        is_person = t in seed_people or t in cand_people
        is_event = t in seed_events or t in cand_events
        if is_person:
            m = meta(t)
            d = person_dates(m["ib"], m["desc"], m["lead"])
            if t not in seed_people:
                lo = d["birth"] if d["birth"] is not None else (d["death"] - 60 if d["death"] else None)
                hi = d["death"] if d["death"] is not None else (d["birth"] + 60 if d["birth"] else None)
                if lo is None or hi is None or hi < WAR[0] or lo > WAR[1]:
                    continue
            n = add(t, "person", t in seed_people)
            n.update(d)
        elif is_event:
            m = meta(t)
            if any(k in m["ib"] for k in ("writer", "author", "playwright")):
                # e.g. Aristophanes' "Peace": a work filed in the war's category
                n = add(t, "work", t in seed_events)
                n.update(work_dates(m["ib"], m["desc"], m["lead"]))
                for k in ("writer", "author", "playwright"):
                    for tgt, _, _ in split_markers(m["ib"].get(k, "")):
                        seed_work_authors.append((tgt, n["title"]))
                continue
            d = event_dates(m["ib"], m["desc"], m["title"], m["lead"])
            if t not in seed_events and (d["start"] is None or not (-446 <= d["start"] <= -399)):
                continue
            n = add(t, "event", t in seed_events)
            n.update(d)

    # ---- edges from event infoboxes: commanders and combatants
    edges = []
    polity_refs = collections.defaultdict(list)
    all_link_targets = set()
    for n in list(nodes.values()):
        if n["type"] != "event":
            continue
        ib = n["ib"]
        n["result"] = plain(ib.get("result", ""))[:160]
        n["location"] = plain(ib.get("location", "") or ib.get("place", ""))[:160]
        for side in ("1", "2", "3"):
            for tgt, disp, flags in split_markers(ib.get("commander" + side, "")):
                all_link_targets.add(tgt)
                edges.append(dict(kind="commanded", person=tgt, event=n["title"], side=side, flags=flags))
            for tgt, disp, flags in split_markers(ib.get("combatant" + side, "")):
                all_link_targets.add(tgt)
                polity_refs[tgt].append((n["title"], side, disp))

    # resolve link targets (redirects) in one batch
    resolved = {}
    targets = sorted(all_link_targets | set(POLITY_ALIAS.values()))
    info = wiki.batch_pages(targets, "pageprops|pageimages", piprop="name")
    for t in targets:
        p = info.get(t)
        resolved[t] = p["title"] if p and "missing" not in p else None

    # ---- polities: every combatant named in >= 1 battle infobox
    polity_titles = collections.defaultdict(list)
    for t, refs in polity_refs.items():
        c = resolved.get(t)
        if not c:
            continue
        c = POLITY_ALIAS.get(c, c)
        c = resolved.get(c, c) or c
        polity_titles[c] += refs
    pol_pages = wiki.batch_pages(sorted(polity_titles), "revisions|pageprops|pageimages",
                                 rvprop="content|ids", rvslots="main", piprop="name")
    pol_leads = wiki.batch_pages(sorted(polity_titles), "extracts", per=20, exintro=1,
                                 explaintext=1, exlimit=20, exsectionformat="plain")
    for t, refs in polity_titles.items():
        p = pol_pages.get(t)
        if not p or "revisions" not in p:
            continue
        # Skip generic regions/ethnonyms only referenced once and not a state
        pages[t] = p
        leads[t] = pol_leads.get(t) or {}
        n = add(t, "polity", False)
        n["battles"] = len({r[0] for r in refs})

    # ---- people referenced as commanders but not yet present -> add if dated in era
    extra_people = set()
    for e in edges:
        c = resolved.get(e["person"])
        if c and c not in nodes:
            extra_people.add(c)
    if extra_people:
        ep = wiki.batch_pages(sorted(extra_people), "revisions|pageprops|pageimages",
                              rvprop="content|ids", rvslots="main", piprop="name")
        el = wiki.batch_pages(sorted(extra_people), "extracts", per=20, exintro=1,
                              explaintext=1, exlimit=20, exsectionformat="plain")
        for t in sorted(extra_people):
            p = ep.get(t)
            if not p or "revisions" not in p:
                continue
            pages[t] = p
            leads[t] = el.get(t) or {}
            m = meta(t)
            ibn = (mw.parse(m["text"]).filter_templates(recursive=False) or [None])
            d = person_dates(m["ib"], m["desc"], m["lead"])
            # commanders named in a battle infobox are participants by definition
            looks_person = re.search(r"general|admiral|king|statesman|politician|commander|navarch|satrap|strategos|tyrant|spartan|athenian|son of|ruler|leader|soldier|oligarch", (m["desc"] + " " + m["lead"][:200]).lower())
            if "BC" not in (m["desc"] + " " + m["lead"][:400]):
                continue
            if not looks_person or re.search(r"\b(city|region|league|island|dynasty)\b", m["desc"].lower()):
                continue
            n = add(t, "person", False)
            n.update(d)

    # ---- works: plays / books linked from included people, written by them
    work_cands = collections.Counter()
    for n in nodes.values():
        if n["type"] != "person":
            continue
        for l in mw.parse(n["text"]).filter_wikilinks():
            t = link_target(l)
            if t and ":" not in t:
                work_cands[t] += 1
    for t, r in by_title.items():
        if r["kind"] == "work":
            work_cands[t] += 5
    wtitles = [t for t, c in work_cands.items() if t not in nodes]
    wpages = wiki.batch_pages(wtitles, "pageprops", )
    wlist = []
    for t in wtitles:
        p = wpages.get(t)
        if not p or "missing" in p:
            continue
        d = p.get("pageprops", {}).get("wikibase-shortdesc", "").lower()
        if re.search(r"\b(play|comedy|tragedy|satyr|history|dialogue|speech|oration|treatise|book|historiograph)", d) and \
                re.search(r"\b(by|of)\b", d):
            wlist.append(p["title"])
    wlist = sorted(set(wlist))
    wp = wiki.batch_pages(wlist, "revisions|pageprops|pageimages", rvprop="content|ids",
                          rvslots="main", piprop="name")
    wl = wiki.batch_pages(wlist, "extracts", per=20, exintro=1, explaintext=1, exlimit=20,
                          exsectionformat="plain")
    person_by_title = {t for t, n in nodes.items() if n["type"] == "person"}
    work_author_edges = [(a, w) for a, w in seed_work_authors if a in person_by_title]
    for t in wlist:
        p = wp.get(t)
        if not p or "revisions" not in p:
            continue
        pages[t] = p
        leads[t] = wl.get(t) or {}
        m = meta(t)
        authors = []
        for k in ("writer", "author", "authors", "writers", "playwright"):
            for tgt, _, _ in split_markers(m["ib"].get(k, "")):
                authors.append(tgt)
        if not authors:
            mm = re.search(r"\bby \[\[([^\]|]+)", m["text"][:3000])
            dm = re.search(r"\bby ([A-Z][\w ]+?)(?:\(|$|,)", m["desc"])
            if dm:
                authors.append(dm.group(1).strip())
        authors = [a for a in authors if a in person_by_title]
        if not authors:
            continue
        d = work_dates(m["ib"], m["desc"], m["lead"])
        if d["start"] is None or not (-432 <= d["start"] <= -380):
            continue
        n = add(t, "work", False)
        n.update(d)
        for a in authors:
            work_author_edges.append((a, n["title"]))

    # ---- redirects -> node map for prose-link resolution
    alias = {}
    titles = list(nodes)
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        cont = {}
        while True:
            d = wiki.api(action="query", titles="|".join(chunk), prop="redirects",
                         rdlimit="max", rdnamespace=0, **cont)
            for p in d["query"]["pages"]:
                for r in p.get("redirects", []):
                    alias[r["title"]] = p["title"]
            if "continue" not in d:
                break
            cont = dict(d["continue"])
    for t in titles:
        alias[t] = t
    for k, v in POLITY_ALIAS.items():
        if v in nodes:
            alias[k] = v

    def node_for(t):
        t = ucfirst(t)
        return nodes.get(alias.get(t) or resolved.get(t) or "")

    # ---- final edge list
    E = {}

    def edge(a, b, kind, **kw):
        if a is None or b is None or a is b:
            return
        key = (a["id"], b["id"], kind)
        e = E.setdefault(key, dict(source=a["id"], target=b["id"], type=kind, weight=0, **kw))
        e["weight"] += 1
        return e

    for e in edges:
        p = node_for(e["person"])
        ev = nodes.get(e["event"])
        if p and p["type"] == "person":
            edge(p, ev, "commanded", side=e["side"], flags=e["flags"],
                 evidence=f"Listed as a commander in the infobox of “{ev['title']}”.",
                 evidence_url=wiki_url(ev["title"]))
    for t, refs in polity_refs.items():
        pol = node_for(t)
        if not pol or pol["type"] != "polity":
            continue
        for ev_t, side, disp in refs:
            ev = nodes.get(ev_t)
            edge(pol, ev, "fought", side=side,
                 evidence=f"Listed as a combatant in the infobox of “{ev['title']}”.",
                 evidence_url=wiki_url(ev["title"]))
    for a, w in work_author_edges:
        edge(nodes[a], nodes[w], "wrote",
             evidence=f"Named as the author in the infobox or short description of “{w}”.",
             evidence_url=wiki_url(w))

    # allegiance: Wikipedia categories + infobox allegiance field
    cat_side = {"Category:Athenians of the Peloponnesian War": "Classical Athens",
                "Category:Spartans of the Peloponnesian War": "Sparta"}
    for cat, pol_t in cat_side.items():
        pol = nodes.get(pol_t)
        for t in wiki.category_members(cat):
            n = node_for(t)
            if n and pol:
                n["side"] = "athens" if pol_t == "Classical Athens" else "sparta"
                edge(n, pol, "allegiance", evidence=f"In the Wikipedia category “{cat[9:]}”.",
                     evidence_url=wiki_url(cat))
    for n in list(nodes.values()):
        if n["type"] != "person":
            continue
        for tgt, _, _ in split_markers(n["ib"].get("allegiance", "")):
            pol = node_for(tgt)
            if pol and pol["type"] == "polity":
                edge(n, pol, "allegiance",
                     evidence=f"Allegiance given in the infobox of “{n['title']}”.",
                     evidence_url=wiki_url(n["title"]))

    pol_mentions = collections.defaultdict(set)
    # ---- per-page prose: story paragraphs + prose-link evidence
    for n in list(nodes.values()):
        paras = prose.paragraphs(n["text"])
        n["paras"] = len(paras)
        # story
        pat = {"person": PERSON_SECTIONS, "event": EVENT_SECTIONS, "work": WORK_SECTIONS,
               "polity": r"peloponnesian|classical|5th|history|war"}[n["type"]]
        story = None
        for sec, text, sents, links in paras:
            if sec != "Lead" and re.search(pat, sec, re.I) and len(text) > 220:
                story = (sec, trim(text, 900))
                break
        if not story:
            body = [(s, t) for s, t, _, _ in paras if s != "Lead" and len(t) > 220]
            if body:
                story = (body[0][0], trim(body[0][1], 900))
        n["story_section"], n["story"] = story if story else (None, None)
        # prose links
        for sec, text, sents, links in paras:
            for tgt, idx in links:
                other = node_for(tgt)
                if not other or other is n:
                    continue
                if other["type"] == "polity" and n["type"] != "polity":
                    pol_mentions[other["id"]].add(n["id"])
                if other["type"] == "polity" or n["type"] == "polity":
                    continue
                sent = sents[idx] if idx is not None else None
                e = edge(n, other, "mentions", evidence=None, evidence_url=wiki_url(n["title"]),
                         section=sec)
                if e is not None and sent and not e.get("evidence"):
                    e["evidence"] = trim(sent, 420)
                    e["section"] = sec

    # ---- DYK hooks from talk pages
    talk = wiki.batch_pages(["Talk:" + t for t in nodes], "revisions", rvprop="content",
                            rvslots="main")
    for t, n in nodes.items():
        p = talk.get("Talk:" + t)
        hooks = []
        if p and "revisions" in p:
            hooks = dyk_hooks(p["revisions"][0]["slots"]["main"]["content"])
        key = re.sub(r" \(.*\)$", "", t).lower()
        key2 = re.sub(r"^(battle|siege|peace) of ", "", key)
        hooks = [h for h in hooks if key in h.lower() or key2 in h.lower()]
        n["dyk"] = hooks[0] if hooks else None

    # ---- images: Wikimedia Commons, public domain / CC0 only
    files = sorted({n["image"] for n in nodes.values() if n.get("image")})
    lic = {}
    for i in range(0, len(files), 50):
        chunk = files[i:i + 50]
        d = wiki._get(wiki.COMMONS, dict(action="query", titles="|".join("File:" + f for f in chunk),
                                         prop="imageinfo", iiprop="url|extmetadata|size",
                                         iiurlwidth=640, format="json", formatversion=2))
        norm = {x["to"]: x["from"] for x in d["query"].get("normalized", [])}
        for p in d["query"]["pages"]:
            if "imageinfo" not in p:
                continue
            ii = p["imageinfo"][0]
            md = ii.get("extmetadata", {})
            name = p["title"][5:]
            lic[norm.get(p["title"], p["title"])[5:]] = dict(
                license=re.sub("<[^>]+>", "", md.get("LicenseShortName", {}).get("value", "")),
                artist=re.sub("<[^>]+>", "", md.get("Artist", {}).get("value", "")).strip(),
                credit=re.sub("<[^>]+>", "", md.get("Credit", {}).get("value", "")).strip()[:200],
                url=ii.get("thumburl") or ii.get("url"), full=ii.get("url"),
                page=ii.get("descriptionurl"), w=ii.get("thumbwidth"), h=ii.get("thumbheight"),
                description=re.sub("<[^>]+>", "", md.get("ImageDescription", {}).get("value", "")).strip()[:300])
    for n in nodes.values():
        f = n.get("image")
        L = lic.get(f) if f else None
        n["img"] = None
        if L and re.search(r"public domain|^pd|cc0", L["license"], re.I):
            n["img"] = dict(url=L["url"], page=L["page"], license=L["license"],
                            artist=L["artist"] or "Unknown", w=L["w"], h=L["h"], file=f,
                            description=L["description"])

    # ---- allegiance for nodes not covered by categories: short description words
    POL_SIDE = {"Classical Athens": "athens", "Delian League": "athens", "Sparta": "sparta",
                "Peloponnesian League": "sparta", "Achaemenid Empire": "persia"}
    for n in nodes.values():
        if n["type"] == "polity":
            n["side"] = POL_SIDE.get(n["title"])
        elif n["type"] == "person" and not n.get("side"):
            d = (n["desc"] or "").lower()
            if re.search(r"\bathenian\b", d):
                n["side"] = "athens"
            elif re.search(r"\b(spartan|lacedaemonian)\b", d):
                n["side"] = "sparta"
            elif re.search(r"\b(persian|achaemenid|satrap)\b", d):
                n["side"] = "persia"
            if n.get("side"):
                n["side_src"] = "Wikipedia short description"

    # ---- campaign phases, as grouped in Template:Campaignbox Peloponnesian War
    box, _ = wiki.wikitext("Template:Campaignbox Peloponnesian War")
    phase = None
    phases = collections.OrderedDict()
    for line in box.splitlines():
        m = re.match(r"^'{3}(.+?)'{3}\s*$", line.strip())
        if m:
            phase = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", m.group(1)).strip()
            continue
        for lm in re.finditer(r"\[\[([^\]|#]+)", line):
            nd = node_for(lm.group(1).replace("_", " ").strip())
            if nd and phase:
                nd["phase"] = phase
                if nd.get("start") is not None:
                    ph = phases.setdefault(phase, [nd["start"], nd.get("end") or nd["start"]])
                    ph[0] = min(ph[0], nd["start"])
                    ph[1] = max(ph[1], nd.get("end") or nd["start"])
    phase_list = [dict(name=k, start=v[0], end=v[1]) for k, v in phases.items()]

    # ---- derived allegiance, recorded with its provenance
    id2node = {n["id"]: n for n in nodes.values()}
    for n in nodes.values():
        if n.get("side") and not n.get("side_src"):
            n["side_src"] = "Wikipedia category" if n["type"] == "person" else "principal belligerent"
    ev_sides = collections.defaultdict(lambda: collections.defaultdict(set))
    for e in E.values():
        ev = id2node.get(e["target"])
        if e["type"] == "fought" and ev and ev.get("start") is not None and WAR[0] <= ev["start"] <= WAR[1]:
            ev_sides[e["target"]][e["side"]].add(e["source"])
    anchors = {i: n["side"] for i, n in id2node.items() if n["type"] == "polity" and n.get("side") in ("athens", "sparta")}
    flip = {"athens": "sparta", "sparta": "athens"}

    def verdict(votes):
        top = votes.most_common(2)
        if top and (len(top) == 1 or top[0][1] > top[1][1]):
            return top[0][0]
        return None

    for n in nodes.values():
        if n["type"] != "polity" or n.get("side"):
            continue
        votes = collections.Counter()
        for sides in ev_sides.values():
            for sd, ps in sides.items():
                if n["id"] not in ps:
                    continue
                for p in ps:
                    if p in anchors:
                        votes[anchors[p]] += 1
        s = verdict(votes)
        if s:
            n["side"] = s
            n["side_src"] = "fought alongside it in Wikipedia battle infoboxes, 431\u2013404 BC"
    for n in nodes.values():
        if n["type"] != "person" or n.get("side"):
            continue
        votes = collections.Counter()
        for e in E.values():
            if e["type"] == "commanded" and e["source"] == n["id"]:
                for p in ev_sides[e["target"]].get(e["side"], ()):
                    s = id2node[p].get("side")
                    if s:
                        votes[s] += 1
        s = verdict(votes)
        if s:
            n["side"] = s
            n["side_src"] = "side commanded on in Wikipedia battle infoboxes"

    # ---- pruning: keep the web about major actors
    drop = set()
    for n in nodes.values():
        if n["type"] == "polity" and n.get("side_src") != "principal belligerent" \
                and n.get("battles", 0) < 2 and len(pol_mentions[n["id"]]) < 6:
            drop.add(n["id"])
        if n["type"] == "work" and not (-431 <= (n.get("start") or 0) <= -399):
            drop.add(n["id"])
    while True:
        deg = collections.Counter()
        for e in E.values():
            if e["source"] in drop or e["target"] in drop:
                continue
            deg[e["source"]] += 1
            deg[e["target"]] += 1
        more = {n["id"] for n in nodes.values() if n["id"] not in drop and
                (deg[n["id"]] == 0 or (n["type"] == "work" and deg[n["id"]] < 2))}
        if not more:
            break
        drop |= more
    print("pruned", len(drop), sorted(drop))
    for t in [t for t, n in nodes.items() if n["id"] in drop]:
        del nodes[t]

    # ---- the war itself (intro panel + timeline band)
    war = meta("Peloponnesian War")
    war_d = event_dates(war["ib"], war["desc"], war["title"], war["lead"])

    # ---- assemble
    out_nodes = []
    for n in nodes.values():
        lead = n["lead"]
        paras = []
        for line in lead.split("\n"):
            line = line.strip()
            if not line:
                continue
            if paras and not re.search(r"[.!?\"\u201d)]$", paras[-1]):
                paras[-1] += " " + line
            else:
                paras.append(line)
        paras = [clean_lead(p) for p in paras]
        bio = trim(paras[0], 900) if paras else ""
        o = dict(id=n["id"], type=n["type"], title=n["title"], desc=n["desc"], bio=bio,
                 lead=trim(" ".join(paras[:3]), 1600), story=n.get("story"),
                 story_section=n.get("story_section"), dyk=n.get("dyk"),
                 url=wiki_url(n["title"]), revid=n["revid"], seed=n["seed"],
                 img=n.get("img"), side=n.get("side"), side_src=n.get("side_src"),
                 phase=n.get("phase"))
        for k in ("birth", "death", "birth_approx", "death_approx", "start", "end", "approx",
                  "result", "location", "battles"):
            if k in n:
                o[k] = n[k]
        out_nodes.append(o)
    ids = {n["id"] for n in out_nodes}
    out_edges = [e for e in E.values() if e["source"] in ids and e["target"] in ids]
    graph = dict(
        nodes=out_nodes, edges=out_edges,
        war=dict(title=war["title"], desc=war["desc"], lead=trim(war["lead"].split("\n")[0], 1200),
                 start=war_d["start"], end=war_d["end"], url=wiki_url(war["title"]),
                 revid=war["revid"], phases=phase_list),
    )
    json.dump(graph, open(os.path.join(OUT, "graph.raw.json"), "w"), indent=1, ensure_ascii=False)
    c = collections.Counter(n["type"] for n in out_nodes)
    ce = collections.Counter(e["type"] for e in out_edges)
    print("nodes", dict(c), "edges", dict(ce))


if __name__ == "__main__":
    main()
