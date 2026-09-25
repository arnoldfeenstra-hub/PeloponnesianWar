# The Peloponnesian War: a web of people & events

**Live:** https://peloponnesian-war-fean.vercel.app. It runs on Vercel, and the data lives in the Neon project `peloponnesian-war`.

An explorable knowledge graph of the Peloponnesian War (431–404 BC). It has three views:

- **Graph**: a force-directed web on canvas. Athens pulls left, Sparta right and Persia below; dated nodes settle top to bottom by year.
  - Click a node to focus its neighbourhood; double-click to expand outward.
  - Hover for a poster card; search (`/`) flies you to any node.
  - "The web as of" replays the war year by year.
- **Timeline**: events, works and every figure's lifespan on a scrubbable year axis. Select a figure to see their career.
- **Six degrees**: the shortest documented chain between any two figures. It is animated across the graph, and every hop shows its Wikipedia evidence.

## Data: Wikipedia only

No fact in this project is written by AI. `pipeline/` pulls everything from the Wikipedia and Wikimedia Commons APIs, and caches each response in `pipeline/.cache`.

| Stage | What it does |
|---|---|
| `discover.py` | Takes seeds from Wikipedia's own curation: the *People / Athenians / Spartans of the Peloponnesian War* categories, the *(Naval) battles of the Peloponnesian War* categories, and the war's campaign navbox. |
| `build.py` | Fetches wikitext, leads, talk pages ("Did you know" hooks) and Commons licences. It derives the entities and edges described below. |
| `images.py` | Self-hosts the public-domain / CC0 Commons images, using Commons' standard thumbnail size. |
| `artwork.py` | Optional. Generates decorative illustrations with ChatGPT Image (needs `OPENAI_API_KEY`). Prompts use only each node's Wikipedia title and short description, and the app labels the output "AI illustration". |

What `build.py` derives:

- **Nodes.** Figures are the category members, plus linked figures whose Wikipedia-stated lifespans overlap the war. Events are the categories and navbox, plus linked events dated 446–399 BC. Polities are combatants named in battle infoboxes. Works are plays and histories by included figures, dated 431–399 BC.
- **Edges.** `commanded` and `fought` come from battle infoboxes, including the KIA, captured and executed markers. `wrote` comes from work infoboxes. `allegiance` comes from categories and infoboxes. `mentions` means one article links another in prose, and the linking sentence is kept as evidence.
- **Dates.** Parsed from infoboxes, short descriptions and lead parentheticals.

## Storage: Neon Postgres

`db/schema.sql` defines the tables `nodes`, `edges`, `images`, `artwork` and `meta`. Every text row carries its Wikipedia URL and revision id.

```sh
npm run data:fetch            # Wikipedia -> data/graph.raw.json (+ public/img)
npm run db:load               # -> Postgres (DATABASE_URL from env or .env.local)
npm run db:export             # Postgres -> public/graph.json (static snapshot)
```

The app reads `/api/graph`, a Vercel function that queries Neon through `lib/graphQuery.ts`. If that fails, it falls back to the snapshot exported from the same query. The connection string is read from `DATABASE_URL` and is never logged.

## Develop, deploy, QA

```sh
npm install
npm run dev                   # http://localhost:5173
npm run build && npm run preview
git push                      # Vercel (Git-connected) builds: seed Neon -> export snapshot -> vite
BASE_URL=https://<deployment> npm run qa   # Playwright screenshots + checks
```

## Licences and attribution

- **Text:** Wikipedia contributors, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Attribution is required, so each card links its article and revision.
- **Images:** Wikimedia Commons, public domain / CC0, with the author and file credited on each card.
- **Illustrations:** generated with ChatGPT Image. They are decorative and not historical evidence.
