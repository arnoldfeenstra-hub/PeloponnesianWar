"""Generate decorative illustrations with ChatGPT Image (OpenAI Images API).

Artwork is decoration, never a source of fact: prompts contain only the node's
Wikipedia title and short description, and the app labels every image
"AI illustration". Nodes that already have a public-domain Commons image are
skipped unless --all is passed.

    OPENAI_API_KEY=... python3 pipeline/artwork.py [--all] [--limit N]

Writes public/art/<id>.jpg and data/artwork.json (loaded by db/load.py).
"""
import argparse
import base64
import io
import json
import os
import sys
import time

import requests

ROOT = os.path.join(os.path.dirname(__file__), "..")
MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1")
STYLE = ("Editorial illustration in the manner of an ancient Greek red-figure vase painting: "
         "terracotta figures with fine black line work on a deep black ground, a thin meander border, "
         "restrained, elegant, no text, no letters, no modern objects. Subject: ")


def prompt_for(n):
    kind = {"person": "a portrait of", "event": "a scene of", "work": "an evocation of the ancient work",
            "polity": "an emblematic view of"}[n["type"]]
    desc = f", {n['desc']}" if n.get("desc") else ""
    return f"{STYLE}{kind} {n['title']}{desc}."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        sys.exit("OPENAI_API_KEY not set")
    try:
        from PIL import Image
    except ImportError:
        sys.exit("pip install pillow")
    g = json.load(open(os.path.join(ROOT, "data", "graph.raw.json")))
    out_path = os.path.join(ROOT, "data", "artwork.json")
    done = {a["node_id"]: a for a in json.load(open(out_path))} if os.path.exists(out_path) else {}
    os.makedirs(os.path.join(ROOT, "public", "art"), exist_ok=True)
    todo = [n for n in g["nodes"] if (args.all or not n.get("img")) and n["id"] not in done]
    todo.sort(key=lambda n: (n["type"] == "polity", n["id"]))
    if args.limit:
        todo = todo[: args.limit]
    for i, n in enumerate(todo):
        prompt = prompt_for(n)
        for attempt in range(4):
            r = requests.post("https://api.openai.com/v1/images/generations",
                              headers={"Authorization": f"Bearer {key}"},
                              json={"model": MODEL, "prompt": prompt, "size": "1024x1024",
                                    "quality": "medium", "n": 1}, timeout=180)
            if r.status_code == 200:
                break
            time.sleep(5 * (attempt + 1))
        else:
            print("failed", n["id"], r.status_code, r.text[:200])
            continue
        b64 = r.json()["data"][0]["b64_json"]
        im = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB").resize((640, 640))
        im.save(os.path.join(ROOT, "public", "art", f"{n['id']}.jpg"), quality=82, optimize=True)
        done[n["id"]] = dict(node_id=n["id"], url=f"/art/{n['id']}.jpg", model=MODEL, prompt=prompt)
        json.dump(list(done.values()), open(out_path, "w"), indent=1)
        print(f"[{i + 1}/{len(todo)}] {n['id']}")


if __name__ == "__main__":
    main()
