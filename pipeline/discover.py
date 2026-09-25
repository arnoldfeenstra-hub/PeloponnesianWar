"""Stage 1: decide which Wikipedia articles become nodes.

Seeds come from Wikipedia's own curation: the Peloponnesian War categories
and the campaign navbox. Candidates are articles linked from >= N seed pages,
classified by their infobox template and Wikipedia short description.
"""
import collections
import json
import re

import mwparserfromhell as mw

import wiki

PEOPLE_CATS = ["Category:People of the Peloponnesian War",
               "Category:Athenians of the Peloponnesian War",
               "Category:Spartans of the Peloponnesian War"]
EVENT_CATS = ["Category:Battles of the Peloponnesian War",
              "Category:Naval battles of the Peloponnesian War"]
WAR_CAT = "Category:Peloponnesian War"


def links_in(text):
    out = []
    for l in mw.parse(text).filter_wikilinks():
        t = str(l.title).split("#")[0].strip()
        if not t or ":" in t:
            continue
        out.append(t[0].upper() + t[1:])
    return out


def infobox_name(text):
    for tp in mw.parse(text).filter_templates(recursive=False):
        n = str(tp.name).strip().lower()
        if n.startswith("infobox"):
            return n
    return ""


def classify(title, ib, desc):
    d = (desc or "").lower()
    t = title.lower()
    if re.search(r"military conflict|historical event|treaty|civil conflict", ib) or \
            re.match(r"(battle|siege|peace|treaty|sack|revolt|trial|mutilation|affair|congress)\b", t) or \
            re.search(r"\b(coup|revolt|expedition|debate|decree|campaign|plague|massacre)\b", t):
        return "event"
    if re.search(r"infobox (play|book|written work|literary)", ib) or \
            re.search(r"\b(play|comedy|tragedy|book|dialogue|speech|oration)\b", d):
        return "work"
    if re.search(r"person|officeholder|military person|royalty|philosopher|writer|monarch|noble|scientist|pharaoh", ib) or \
            re.search(r"\b(general|statesman|politician|playwright|dramatist|philosopher|historian|king|queen|admiral|orator|poet|satrap|navarch|sophist|commander|tyrant|courtesan|priestess|sculptor|physician|ruler|emperor|oligarch|strategos|writer|prince|nobleman|soldier|athenian|spartan|macedonian|persian)\b", d) and not re.search(r"\b(city|region|island|league|dynasty|empire|war|battle)\b", d):
        return "person"
    if re.search(r"former country|country|settlement|ancient site|greek city|polity|military unit", ib) or \
            re.search(r"\b(city-state|polis|league|empire|kingdom|confederacy|city|ancient greek state)\b", d):
        return "polity"
    return None


def main():
    people = set()
    for c in PEOPLE_CATS:
        people.update(wiki.category_members(c))
    events = set()
    for c in EVENT_CATS:
        events.update(wiki.category_members(c))
    box, _ = wiki.wikitext("Template:Campaignbox Peloponnesian War")
    campaign = links_in(box)
    events.update(campaign)
    misc = wiki.category_members(WAR_CAT)
    seeds = sorted(people | events | set(misc) | {"Peloponnesian War", "History of the Peloponnesian War"})

    texts = wiki.batch_pages(seeds, "revisions", rvprop="content", rvslots="main")
    counts = collections.Counter()
    for t, p in texts.items():
        if not p or "revisions" not in p:
            continue
        for l in set(links_in(p["revisions"][0]["slots"]["main"]["content"])):
            counts[l] += 1
    cands = [l for l, n in counts.items() if n >= 3 and l not in seeds]
    info = wiki.batch_pages(seeds + cands, "revisions|pageprops", rvprop="content", rvslots="main")
    rows = []
    for t in seeds + cands:
        p = info.get(t)
        if not p or "revisions" not in p:
            continue
        txt = p["revisions"][0]["slots"]["main"]["content"]
        desc = p.get("pageprops", {}).get("wikibase-shortdesc", "")
        ib = infobox_name(txt)
        kind = classify(p["title"], ib, desc)
        if t in people:
            kind = "person"
        elif t in events and kind != "person":
            kind = "event"
        rows.append(dict(req=t, title=p["title"], seed=t in seeds, links=counts.get(t, 0),
                         infobox=ib, desc=desc, kind=kind))
    json.dump(rows, open("candidates.json", "w"), indent=1)
    for r in sorted(rows, key=lambda r: (r["kind"] or "~", -r["links"])):
        print(f'{str(r["kind"]):7} {"S" if r["seed"] else " "} {r["links"]:3} {r["title"][:45]:45} | {r["infobox"][:28]:28} | {r["desc"][:60]}')


if __name__ == "__main__":
    main()
