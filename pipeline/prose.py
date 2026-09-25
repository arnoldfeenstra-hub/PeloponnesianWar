"""Render article wikitext into plain paragraphs with link positions.

Replaces a per-page HTML fetch: the batch wikitext we already hold is enough.
Output: [(section, paragraph_text, sentences, [(link_target, sentence_idx)])]
"""
import re

import mwparserfromhell as mw
from mwparserfromhell.nodes import Comment, ExternalLink, Heading, HTMLEntity, Tag, Template, Text, Wikilink

KEEP_LAST = {"lang", "transl", "transliteration", "nowrap", "nobr", "small", "abbr", "linktext",
             "em", "strong", "sic", "var", "smallcaps", "sc", "lang-grc", "grc", "polytonic",
             "literal translation", "lit", "gloss", "noitalic", "not a typo", "proper name"}
STOP = re.compile(r"^(see also|references|notes|further reading|external links|sources|bibliography|"
                  r"citations|footnotes|works cited|primary sources|secondary sources|ancient sources|"
                  r"modern sources|in popular culture|gallery|family tree|editions|translations)$", re.I)
ABBR = re.compile(r"\b(c|ca|fl|St|Mt|i\.e|e\.g|cf|vol|pp?|ed|Jr|Sr|Dr|Mr|Mrs|no|approx)\.$", re.I)


def tmpl(t, out, links):
    name = str(t.name).strip().lower().replace("_", " ")
    pos = [p for p in t.params if not p.showkey]
    val = lambda i: str(pos[i].value).strip() if len(pos) > i else ""
    if name in ("circa", "c.", "c", "ca"):
        out.append("c. " + val(0))
    elif name in ("bce", "bc"):
        out.append(val(0) + " BC")
    elif name in ("nbsp", "snd", "spaced ndash", "ndash", "mdash", "spnd", "'", "'s", "thinsp"):
        out.append({"nbsp": " ", "thinsp": " ", "snd": " – ", "spaced ndash": " – ", "spnd": " – ",
                    "ndash": "–", "mdash": "—", "'": "'", "'s": "'s"}[name])
    elif name == "convert":
        out.append(f"{val(0)} {val(1)}")
    elif name in KEEP_LAST or name.startswith("lang-") or name.startswith("lang|"):
        if pos:
            render(pos[-1].value, out, links)
    elif name in ("floruit", "fl.", "fl"):
        out.append("fl. " + val(0))
    elif name in ("lang-grc", "grc-transl"):
        out.append(val(0))
    # everything else (citations, notes, infoboxes, maintenance) is dropped


def render(code, out, links):
    for node in code.nodes:
        if isinstance(node, Text):
            out.append(str(node.value))
        elif isinstance(node, Wikilink):
            title = str(node.title).strip()
            if re.match(r"^(file|image|category|media|wikt|s):", title, re.I) or title.startswith(":"):
                continue
            start = sum(len(x) for x in out)
            if node.text is not None:
                render(node.text, out, [])
            else:
                out.append(title.split("#")[0] if not title.startswith("#") else title[1:])
            t = title.split("#")[0].strip().replace("_", " ")
            if t:
                links.append((t[0].upper() + t[1:], start, sum(len(x) for x in out)))
        elif isinstance(node, Template):
            tmpl(node, out, links)
        elif isinstance(node, Tag):
            tag = str(node.tag).lower()
            if tag in ("ref", "references", "gallery", "table", "math", "timeline", "score", "div", "blockquote") or node.wiki_markup in ("{|",):
                continue
            if tag == "br":
                out.append(" ")
            elif node.contents is not None:
                render(node.contents, out, links)
        elif isinstance(node, ExternalLink):
            if node.title is not None:
                render(node.title, out, [])
        elif isinstance(node, HTMLEntity):
            out.append(node.normalize())
        elif isinstance(node, Comment):
            pass


def sentences_with_offsets(text):
    spans, start = [], 0
    for m in re.finditer(r"(?:(?<=[.!?])|(?<=[.!?][\"”')]))\s+(?=[A-Z\"“(])", text):
        chunk = text[start:m.start()]
        if ABBR.search(chunk) or re.search(r"\b[A-Z]\.$", chunk):
            continue
        spans.append((start, m.start()))
        start = m.end()
    spans.append((start, len(text)))
    return spans


def paragraphs(wikitext):
    code = mw.parse(wikitext)
    section = "Lead"
    top = "Lead"
    out = []
    buf = []
    for node in code.nodes:
        if isinstance(node, Heading):
            section = str(node.title).strip()
            section = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", section).strip()
            if node.level == 2:
                top = section
            out.append((None, None))
            continue
        if STOP.match(top) or STOP.match(section):
            continue
        out.append((section, node))
    # group consecutive nodes of the same section into blocks split on blank lines
    result = []
    cur_sec, cur_nodes = None, []

    def flush():
        if not cur_nodes:
            return
        texts, links = [], []
        render(mw.wikicode.Wikicode(cur_nodes), texts, links)
        raw = "".join(texts)
        # split into paragraphs on blank lines, keeping link offsets
        pos = 0
        for para in re.split(r"(\n\s*\n)", raw):
            p_start, p_end = pos, pos + len(para)
            pos = p_end
            lines = [l for l in para.split("\n")]
            if not para.strip() or re.match(r"^\s*[*#:;|!{]", para) or para.strip().startswith("__"):
                continue
            # drop list/indent lines inside the paragraph
            if any(re.match(r"^\s*[*#:;]", l) for l in lines):
                continue
            text = re.sub(r"\s+", " ", para).strip()
            text = re.sub(r"\(\s*[,;]+\s*", "(", text)
            text = re.sub(r"\(\s*[,;]?\s*\)", "", text)
            text = re.sub(r"\s+([,.;:])", r"\1", text).replace("( ", "(").replace(" )", ")")
            if len(text) < 60 or text.startswith("{{") or text.startswith("|"):
                continue
            spans = sentences_with_offsets(text)
            sents = [text[a:b].strip() for a, b in spans]
            plinks = []
            for tgt, a, b in links:
                if a >= p_start and b <= p_end:
                    anchor = re.sub(r"\s+", " ", raw[a:b]).strip()
                    idx = next((i for i, s in enumerate(sents) if anchor and anchor in s), None)
                    plinks.append((tgt, idx))
            result.append((cur_sec, text, sents, plinks))

    for sec, node in out:
        if sec is None:
            flush(); cur_sec, cur_nodes = None, []
            continue
        if sec != cur_sec:
            flush(); cur_sec, cur_nodes = sec, []
        cur_nodes.append(node)
    flush()
    return result
