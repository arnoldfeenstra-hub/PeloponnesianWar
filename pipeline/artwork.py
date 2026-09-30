"""Generate decorative illustrations for nodes without a public-domain image.

Artwork is decoration, never a source of fact: the only node-specific text in a
prompt is its Wikipedia title and short description (the rest is generic,
photorealistic period styling), and the app labels every image
"AI illustration" and names the model that made it.

Providers (used together, round-robin, each falling back to the others when
it errors or runs out of free quota):
  cloudflare   FLUX.1-schnell on Cloudflare Workers AI
               needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
  huggingface  FLUX.1-Krea-dev (photorealistic) on Hugging Face Inference Providers (fal)
               needs HF_TOKEN (or HFToken, or an hf_ token in KEY)
  openai       gpt-image-1 (ChatGPT Image), needs OPENAI_API_KEY

    python3 pipeline/artwork.py [--limit N] [--only id,id] [--all] [--redo] [--providers cloudflare,huggingface]

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
# Everything below except the node's title and short description is generic period
# styling, not a claim about the node.
PERIOD = ("Historically accurate reconstruction of the late 5th century BC: buildings intact, newly built "
          "and painted, never ruins; authentic classical Greek dress, arms and armour, never Roman. "
          "Natural light, subtle film grain, fine detail. No text, no letters, no modern objects.")
CAMERA = {
    "person": ("Documentary portrait photograph, full-frame camera, 85mm lens at f/2, soft side daylight, "
               "shallow depth of field; weathered skin with visible pores and wrinkles, real hair, "
               "wool or linen clothing, an out-of-focus period setting behind."),
    "battle": ("Cinematic war photograph, full-frame camera, 35mm lens, dust and haze, motion blur, sweat, "
               "mud and blood. Hoplites in hammered bronze Corinthian helmets that cover the face, linen "
               "cuirasses, bronze greaves, large round bronze-faced hoplon shields, long ash-wood spears."),
    "naval": ("Cinematic war photograph from water level, full-frame camera, 35mm lens, spray and haze: wooden "
              "triremes with bronze rams and three banks of oars, painted eyes on the bows, hoplites and archers "
              "on deck in bronze helmets."),
    "event": "Cinematic documentary photograph, full-frame camera, 35mm lens, natural light, real people in period dress.",
    "play": ("Photograph of an original performance in an open-air Greek theatre of wooden benches on a hillside, "
             "masked actors in costume, the chorus in the orchestra, audience in wool himatia, daylight."),
    "work": ("Photograph of a scholar's room: papyrus scrolls, a reed pen and ink, a wooden table, "
             "oil-lamp and daylight, shallow depth of field."),
    "polity": ("Wide landscape photograph, golden-hour light: its people, buildings and surrounding "
               "countryside as they were at the time."),
}


def prompt_for(n):
    desc = f", {n['desc']}" if n.get("desc") else ""
    subject, text = f"{n['title']}{desc}", f"{n['title']} {n.get('desc') or ''}".lower()
    t = n["type"]
    if t == "person":
        return f"A photorealistic portrait of {subject}, as a real person of ancient Greece. {CAMERA['person']} {PERIOD}"
    if t == "event":
        if any(w in text for w in ("naval", "sea battle", "fleet")):
            cam = CAMERA["naval"]
        elif any(w in text for w in ("battle", "siege", "war", "expedition", "campaign")):
            cam = CAMERA["battle"]
        else:
            cam = CAMERA["event"]
        return f"A photorealistic scene of {subject}, as it really happened. {cam} {PERIOD}"
    if t == "work":
        cam = CAMERA["play"] if any(w in text for w in ("play", "comedy", "tragedy", "drama", "satyr")) else CAMERA["work"]
        return f"A photorealistic evocation of the ancient work {subject}. {cam} {PERIOD}"
    return f"A photorealistic view of {subject}. {CAMERA['polity']} {PERIOD}"


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


def hf_token():
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HFToken") or os.environ.get("HUGGINGFACE_TOKEN")
    key = os.environ.get("KEY", "")
    return tok or (key if key.startswith("hf_") else None)


def huggingface(prompt, seed):
    # FLUX.1-Krea-dev (BFL's photorealism-tuned FLUX) served by fal through the Hugging Face router.
    r = requests.post("https://router.huggingface.co/fal-ai/fal-ai/flux/krea",
                      headers={"Authorization": f"Bearer {hf_token()}"},
                      json={"prompt": prompt, "seed": seed, "image_size": {"width": 1024, "height": 1024},
                            "num_inference_steps": 28, "guidance_scale": 4.5, "sync_mode": True},
                      timeout=300)
    if r.status_code in (401, 402, 403, 429):
        raise QuotaOrAuth(f"huggingface {r.status_code}")
    r.raise_for_status()
    url = (r.json().get("images") or [{}])[0].get("url", "")
    if url.startswith("data:"):
        return base64.b64decode(url.split(",", 1)[1])
    if not url:
        raise RuntimeError("huggingface: no image in response")
    return requests.get(url, timeout=120).content


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
    "huggingface": (huggingface, "FLUX.1-Krea-dev via Hugging Face",
                    hf_token),
    "openai": (openai, "ChatGPT Image (gpt-image-1)", lambda: os.environ.get("OPENAI_API_KEY")),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="also illustrate nodes that have a public-domain image")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated node ids")
    ap.add_argument("--redo", action="store_true", help="regenerate nodes that already have artwork")
    ap.add_argument("--providers", default="cloudflare,huggingface,openai")
    args = ap.parse_args()
    try:
        from PIL import Image
    except ImportError:
        sys.exit("pip install pillow")

    active = [p for p in args.providers.split(",") if p in PROVIDERS and PROVIDERS[p][2]()]
    if not active:
        sys.exit("no image provider credentials set (CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN, HF_TOKEN/HFToken/KEY, or OPENAI_API_KEY)")
    print("providers:", ", ".join(active))

    g = json.load(open(os.path.join(ROOT, "data", "graph.raw.json")))
    out_path = os.path.join(ROOT, "data", "artwork.json")
    done = {a["node_id"]: a for a in json.load(open(out_path))} if os.path.exists(out_path) else {}
    os.makedirs(os.path.join(ROOT, "public", "art"), exist_ok=True)
    only = set(filter(None, args.only.split(",")))
    todo = [n for n in g["nodes"] if (args.redo or n["id"] not in done) and (n["id"] in only if only else (args.all or not n.get("img")))]
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
        im = Image.open(io.BytesIO(data)).convert("RGB").resize((768, 768), Image.LANCZOS)
        im.save(os.path.join(ROOT, "public", "art", f"{n['id']}.jpg"), quality=86, optimize=True)
        done[n["id"]] = dict(node_id=n["id"], url=f"/art/{n['id']}.jpg", model=label, prompt=prompt)
        json.dump(list(done.values()), open(out_path, "w"), indent=1)
        print(f"[{i + 1}/{len(todo)}] {n['id']} ({name})")
    print(f"artwork: {len(done)} images in data/artwork.json")


if __name__ == "__main__":
    main()
