"""Polite, cached client for the Wikipedia / Wikimedia Commons APIs.

Every fact in the dataset flows through this module, so every response is
cached on disk (pipeline/.cache) and can be re-audited later.
"""
import hashlib
import json
import os
import time
import urllib.parse

import requests

UA = ("PeloponnesianWarGraph/1.0 "
      "(https://github.com/arnoldfeenstra-hub/PeloponnesianWar; educational data-viz)")
CACHE = os.path.join(os.path.dirname(__file__), ".cache")
os.makedirs(CACHE, exist_ok=True)

_session = requests.Session()
_session.headers["User-Agent"] = UA
_last = [0.0]


def _get(url, params=None):
    key = hashlib.sha1((url + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    delay = 2.0
    for _ in range(14):
        wait = 0.6 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        r = _session.get(url, params=params, timeout=30)
        if r.status_code == 200:
            data = r.json()
            with open(path, "w") as f:
                json.dump(data, f)
            return data
        if r.status_code == 404:
            return None
        ra = r.headers.get("retry-after")
        time.sleep(max(delay, float(ra) if ra and ra.isdigit() else 0))
        delay = min(delay * 2, 60)
    raise RuntimeError(f"failed {url} {params} -> {r.status_code}")


API = "https://en.wikipedia.org/w/api.php"
COMMONS = "https://commons.wikimedia.org/w/api.php"


def api(**params):
    params.update(format="json", formatversion=2)
    return _get(API, params)


def summary(title):
    t = urllib.parse.quote(title.replace(" ", "_"), safe="")
    return _get(f"https://en.wikipedia.org/api/rest_v1/page/summary/{t}")


def wikitext(title):
    d = api(action="query", titles=title, prop="revisions", rvprop="content",
            rvslots="main", redirects=1)
    p = d["query"]["pages"][0]
    if "revisions" not in p:
        return None, title
    return p["revisions"][0]["slots"]["main"]["content"], p["title"]


def plaintext(title):
    d = api(action="query", titles=title, prop="extracts", explaintext=1,
            exsectionformat="wiki", redirects=1)
    p = d["query"]["pages"][0]
    return p.get("extract", "")


def category_members(cat, ns=0):
    out, cont = [], {}
    while True:
        d = api(action="query", list="categorymembers", cmtitle=cat, cmlimit="max",
                cmnamespace=ns, **cont)
        out += [m["title"] for m in d["query"]["categorymembers"]]
        if "continue" not in d:
            return out
        cont = {"cmcontinue": d["continue"]["cmcontinue"]}


def page_info(titles):
    """Batch: canonical title, short description, pageid, lead image file."""
    res = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        d = api(action="query", titles="|".join(chunk), prop="pageprops|info",
                redirects=1)
        redirect = {r["from"]: r["to"] for r in d["query"].get("redirects", [])}
        norm = {n["from"]: n["to"] for n in d["query"].get("normalized", [])}
        pages = {p["title"]: p for p in d["query"]["pages"]}
        for t in chunk:
            c = norm.get(t, t)
            c = redirect.get(c, c)
            res[t] = pages.get(c)
    return res


def commons_imageinfo(filename):
    d = _get(COMMONS, dict(action="query", titles="File:" + filename, prop="imageinfo",
                           iiprop="url|extmetadata|size", iiurlwidth=640,
                           format="json", formatversion=2))
    p = d["query"]["pages"][0]
    if "imageinfo" not in p:
        return None
    return p["imageinfo"][0]


def batch_pages(titles, props, per=50, **extra):
    """Query many titles at once; returns {requested_title: page dict}."""
    res = {}
    for i in range(0, len(titles), per):
        chunk = titles[i:i + per]
        cont = {}
        merged = {}
        while True:
            d = api(action="query", titles="|".join(chunk), prop=props, redirects=1,
                    **extra, **cont)
            q = d["query"]
            redirect = {r["from"]: r["to"] for r in q.get("redirects", [])}
            norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
            for p in q["pages"]:
                m = merged.setdefault(p["title"], {})
                for k, v in p.items():
                    if isinstance(v, list) and isinstance(m.get(k), list):
                        m[k] += v
                    elif k not in m:
                        m[k] = v
            if "continue" not in d:
                break
            cont = {k: v for k, v in d["continue"].items()}
        for t in chunk:
            c = norm.get(t, t)
            c = redirect.get(c, c)
            res[t] = merged.get(c)
    return res


def _get_text(url):
    """Cached GET returning text (for Parsoid HTML)."""
    key = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE, key + ".html")
    if os.path.exists(path):
        with open(path) as f:
            return f.read()
    delay = 2.0
    for _ in range(14):
        wait = 0.6 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        r = _session.get(url, timeout=30)
        if r.status_code == 200:
            with open(path, "w") as f:
                f.write(r.text)
            return r.text
        if r.status_code == 404:
            return None
        ra = r.headers.get("retry-after")
        time.sleep(max(delay, float(ra) if ra and ra.isdigit() else 0))
        delay = min(delay * 2, 60)
    raise RuntimeError(f"failed {url} -> {r.status_code}")


def get_bytes(url):
    """Cached binary GET (Commons thumbnails)."""
    key = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE, key + ".bin")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    delay = 2.0
    for _ in range(10):
        wait = 0.6 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        r = _session.get(url, timeout=60)
        if r.status_code == 200:
            with open(path, "wb") as f:
                f.write(r.content)
            return r.content
        if r.status_code == 404:
            return None
        ra = r.headers.get("retry-after")
        time.sleep(max(delay, float(ra) if ra and ra.isdigit() else 0))
        delay = min(delay * 2, 60)
    return None
