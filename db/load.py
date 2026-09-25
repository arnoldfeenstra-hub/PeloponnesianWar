"""Load data/graph.raw.json into Postgres (Neon). Reads DATABASE_URL from the
environment or .env.local; the connection string is never printed."""
import json
import os
import sys

import psycopg2
from psycopg2.extras import execute_values

ROOT = os.path.join(os.path.dirname(__file__), "..")


def dsn():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    p = os.path.join(ROOT, ".env.local")
    if os.path.exists(p):
        for line in open(p):
            k, _, v = line.strip().partition("=")
            if k in ("DATABASE_URL", "POSTGRES_URL", "NEON_DATABASE_URL") and v:
                return v.strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not set (env or .env.local)")


def main():
    g = json.load(open(os.path.join(ROOT, "data", "graph.raw.json")))
    conn = psycopg2.connect(dsn())
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS edges, images, artwork, meta, nodes CASCADE")
    cur.execute(open(os.path.join(os.path.dirname(__file__), "schema.sql")).read())
    cur.execute("TRUNCATE edges, images, nodes, meta RESTART IDENTITY CASCADE")
    rows = []
    for n in g["nodes"]:
        rows.append((n["id"], n["type"], n["title"], n.get("desc"), n.get("bio"), n.get("lead"),
                     n.get("story"), n.get("story_section"), n.get("dyk"), n.get("side"), n.get("side_src"),
                     n.get("birth"), n.get("death"), n.get("birth_approx"), n.get("death_approx"),
                     n.get("start"), n.get("end"), n.get("approx"), n.get("result"),
                     n.get("location"), n["url"], n["revid"], n.get("seed", False), n.get("phase")))
    execute_values(cur, """INSERT INTO nodes (id,type,title,short_desc,bio,lead,story,story_section,
        dyk,side,side_src,birth,death,birth_approx,death_approx,year_start,year_end,year_approx,result,
        location,wiki_url,wiki_revid,seed,phase) VALUES %s""", rows)
    imgs = [(n["id"], n["img"]["url"], n["img"].get("thumb"), n["img"].get("source"), n["img"]["page"],
             n["img"].get("file"), n["img"]["license"],
             n["img"].get("artist"), n["img"].get("description"), n["img"].get("w"), n["img"].get("h"))
            for n in g["nodes"] if n.get("img")]
    if imgs:
        execute_values(cur, """INSERT INTO images (node_id,url,thumb,source_url,commons_page,file,license,artist,
            description,width,height) VALUES %s""", imgs)
    art_path = os.path.join(ROOT, "data", "artwork.json")
    ids = {n["id"] for n in g["nodes"]}
    art = [(a["node_id"], a["url"], a["model"], a["prompt"])
           for a in (json.load(open(art_path)) if os.path.exists(art_path) else []) if a["node_id"] in ids]
    if art:
        execute_values(cur, """INSERT INTO artwork (node_id,url,model,prompt) VALUES %s
            ON CONFLICT (node_id) DO UPDATE SET url=EXCLUDED.url, model=EXCLUDED.model,
            prompt=EXCLUDED.prompt""", art)
    execute_values(cur, """INSERT INTO edges (source,target,type,side,flags,weight,evidence,
        evidence_url,section) VALUES %s""",
                   [(e["source"], e["target"], e["type"], e.get("side"), e.get("flags") or None,
                     e.get("weight", 1), e.get("evidence"), e.get("evidence_url"), e.get("section"))
                    for e in g["edges"]])
    cur.execute("INSERT INTO meta (key,value) VALUES ('war',%s),('built',%s)",
                (json.dumps(g["war"]), json.dumps(g.get("built", {}))))
    conn.commit()
    cur.execute("SELECT type,count(*) FROM nodes GROUP BY 1 ORDER BY 1")
    print("nodes", cur.fetchall())
    cur.execute("SELECT type,count(*) FROM edges GROUP BY 1 ORDER BY 1")
    print("edges", cur.fetchall())


if __name__ == "__main__":
    main()
