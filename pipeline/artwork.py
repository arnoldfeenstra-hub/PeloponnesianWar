"""Generate decorative illustrations for nodes without a public-domain image.

Artwork is decoration, never a source of fact: prompts contain only the node's
Wikipedia title and short description, and the app labels every image
"AI illustration" and names the model that made it.

Providers (used together, round-robin, each falling back to the others when
it errors or runs out of free quota):
  cloudflare   FLUX.1-schnell on Cloudflare Workers AI
               needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
  huggingface  FLUX.1-schnell on Hugging Face Inference Providers
               needs HF_TOKEN
  openai       gpt-image-1 (ChatGPT Image), needs OPENAI_API_KEY

    python3 pipeline/artwork.py [--limit N] [--only id,id] [--all] [--providers cloudflare,huggingface]

Writes public/art/<id>.jpg and data/artwork.json (loaded into Postgres by the build).
Credentials are read from the environment and never printed.
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import zlib

import requests

ROOT = os.path.join(os.path.dirname(__file__), "..")
STYLE = ("Editorial illustration in the manner of an ancient Greek red-figure vase painting: "
         "terracotta figures with fine black line work on a deep black ground, a thin meander border, "
         "restrained, elegant, no text, no letters, no modern objects. Subject: ")


def prompt_for(n):
    kind = {"person": "a portrait of", "event": "a scene of", "work": "an evocation of the ancient work",
            "polity": "an emblematic view of"}[n["type"]]
    desc = f", {n['desc']}" if n.get("desc") else ""
    return f"{STYLE}{kind} {n['title']}{desc}."


class QuotaOrAuth(Exception):
    """The provider cannot serve more requests now (auth, quota, or rate limit)."""


def cloudflare(prompt, seed):
    acct, tok = os.environ.get("CLOUDFLARE_ACCOUNT_ID"), os.environ.get("CLOUDFLARE_API_TOKEN")
    r = requests.post(f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/black-forest-labs/flux-1-schnell",
                      headers={"Authorization": f"Bearer {tok}"},
                      json={"prompt": prompt, "steps": 8, "seed": seed}, timeout=120)
    if r.status_code in (401, 403, 429):
        raise QuotaOrAuth(f"cloudflare {r.status_code}")
    r.raise_for_status()
    img = r.json().get("result", {}).get("image")
    if not img:
        raise RuntimeError("cloudflare: no image in response")
    return base64.b64decode(img)


def huggingface(prompt, seed):
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    r = requests.post("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell",
                      headers={"Authorization": f"Bearer {tok}", "Accept": "image/jpeg"},
                      json={"inputs": prompt, "parameters": {"seed": seed, "num_inference_steps": 4,
                                                             "width": 768, "height": 768}}, timeout=180)
    if r.status_code in (401, 402, 403, 429):
        raise QuotaOrAuth(f"huggingface {r.status_code}")
    if r.status_code == 503:  # model warming up
        time.sleep(20)
        raise RuntimeError("huggingface: model loading")
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image/"):
        raise RuntimeError("huggingface: non-image response")
    return r.content


def openai(prompt, seed):
    r = requests.post("https://api.openai.com/v1/images/generations",
                      headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY')}"},
                      json={"model": os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1"), "prompt": prompt,
                            "size": "1024x1024", "quality": "medium", "n": 1}, timeout=180)
    if r.status_code in (401, 403, 429):
        raise QuotaOrAuth(f"openai {r.status_code}")
    r.raise_for_status()
    return base64.b64decode(r.json()["data"][0]["b64_json"])


PROVIDERS = {
    "cloudflare": (cloudflare, "FLUX.1-schnell via Cloudflare Workers AI",
                   lambda: os.environ.get("CLOUDFLARE_ACCOUNT_ID") and os.environ.get("CLOUDFLARE_API_TOKEN")),
    "huggingface": (huggingface, "FLUX.1-schnell via Hugging Face",
                    lambda: os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")),
    "openai": (openai, "ChatGPT Image (gpt-image-1)", lambda: os.environ.get("OPENAI_API_KEY")),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="also illustrate nodes that have a public-domain image")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated node ids")
    ap.add_argument("--providers", default="cloudflare,huggingface,openai")
    args = ap.parse_args()
    try:
        from PIL import Image
    except ImportError:
        sys.exit("pip install pillow")

    active = [p for p in args.providers.split(",") if p in PROVIDERS and PROVIDERS[p][2]()]
    if not active:
        sys.exit("no image provider credentials set (CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN, HF_TOKEN, or OPENAI_API_KEY)")
    print("providers:", ", ".join(active))

    g = json.load(open(os.path.join(ROOT, "data", "graph.raw.json")))
    out_path = os.path.join(ROOT, "data", "artwork.json")
    done = {a["node_id"]: a for a in json.load(open(out_path))} if os.path.exists(out_path) else {}
    os.makedirs(os.path.join(ROOT, "public", "art"), exist_ok=True)
    only = set(filter(None, args.only.split(",")))
    todo = [n for n in g["nodes"] if n["id"] not in done and (n["id"] in only if only else (args.all or not n.get("img")))]
    todo.sort(key=lambda n: (n["type"] == "polity", n["id"]))
    if args.limit:
        todo = todo[: args.limit]

    exhausted = set()
    turn = 0
    for i, n in enumerate(todo):
        prompt = prompt_for(n)
        seed = zlib.crc32(n["id"].encode()) % 2**31
        data = None
        for attempt in range(len(active) * 2):
            live = [p for p in active if p not in exhausted]
            if not live:
                break
            name = live[turn % len(live)]
            turn += 1
            fn, label, _ = PROVIDERS[name]
            try:
                data = fn(prompt, seed)
                break
            except QuotaOrAuth as e:
                print(f"  {e}: switching provider")
                exhausted.add(name)
            except Exception as e:  # transient: try the next provider
                print(f"  {name} failed on {n['id']}: {str(e)[:120]}")
                time.sleep(2)
        if data is None:
            if not [p for p in active if p not in exhausted]:
                print("all providers exhausted for now; rerun later to continue")
                break
            continue
        im = Image.open(io.BytesIO(data)).convert("RGB").resize((640, 640))
        im.save(os.path.join(ROOT, "public", "art", f"{n['id']}.jpg"), quality=82, optimize=True)
        done[n["id"]] = dict(node_id=n["id"], url=f"/art/{n['id']}.jpg", model=label, prompt=prompt)
        json.dump(list(done.values()), open(out_path, "w"), indent=1)
        print(f"[{i + 1}/{len(todo)}] {n['id']} ({name})")
    print(f"artwork: {len(done)} images in data/artwork.json")


if __name__ == "__main__":
    main()
