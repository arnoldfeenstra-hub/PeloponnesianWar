"""Self-host the public-domain Commons images (avoids hotlinking + rate limits).

For every node whose image passed the public-domain/CC0 filter in build.py,
download Commons' standard 500px thumbnail once and write:
  public/img/<id>.jpg     (<= 500px, panel + hover card)
  public/img/<id>-s.jpg   (128px square-ish crop source for graph nodes)
graph.raw.json is updated in place: img.url / img.thumb point at the copies,
img.source keeps the original Commons file URL for attribution.
"""
import io
import json
import os
import re

from PIL import Image

import wiki

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "public", "img")


def main():
    path = os.path.join(ROOT, "data", "graph.raw.json")
    g = json.load(open(path))
    os.makedirs(OUT, exist_ok=True)
    n_ok = 0
    for n in g["nodes"]:
        img = n.get("img")
        if not img:
            continue
        big = os.path.join(OUT, f"{n['id']}.jpg")
        small = os.path.join(OUT, f"{n['id']}-s.jpg")
        if not (os.path.exists(big) and os.path.exists(small)):
            src = img.get("source") or img["url"]
            src = src.split("?")[0]
            # Commons only serves its standard thumbnail steps; never upscale.
            w = img.get("w") or 500
            m = re.match(r"(https://upload\.wikimedia\.org/wikipedia/commons)/(?:thumb/)?([0-9a-f]/[0-9a-f]{2}/[^/]+)", src)
            cands = []
            if m:
                base, fpath = m.group(1), m.group(2)
                fname = fpath.split("/")[-1]
                cands = [f"{base}/thumb/{fpath}/{s}px-{fname}" for s in (500, 330, 250, 120) if s <= max(w, 120)]
                cands.append(f"{base}/{fpath}")
            else:
                cands = [src]
            data, url = None, cands[0]
            for url in cands:
                data = wiki.get_bytes(url, tries=int(os.environ.get("IMG_TRIES", "4")))
                if data:
                    break
            url = cands[0] if not data else url
            if not data:
                # Not self-hosted (yet): point at Commons' standard-size thumbnails,
                # which Wikimedia allows for direct use.
                img.setdefault("source", src)
                img["url"] = url
                img["thumb"] = re.sub(r"/(\d+)px-", "/120px-", url) if "/thumb/" in url and (img.get("w") or 0) >= 120 else url
                print("remote", n["id"])
                continue
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((500, 700))
            im.save(big, quality=84, optimize=True, progressive=True)
            im.thumbnail((128, 180))
            im.save(small, quality=82, optimize=True)
        img.setdefault("source", img["url"])
        img["url"] = f"/img/{n['id']}.jpg"
        img["thumb"] = f"/img/{n['id']}-s.jpg"
        n_ok += 1
    json.dump(g, open(path, "w"), indent=1, ensure_ascii=False)
    print("images", n_ok)


if __name__ == "__main__":
    main()
