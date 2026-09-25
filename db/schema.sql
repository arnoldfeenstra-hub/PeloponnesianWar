-- Peloponnesian War knowledge graph. Every text field is verbatim Wikipedia
-- (CC BY-SA 4.0) and carries the article URL + revision id it came from.
CREATE TABLE IF NOT EXISTS nodes (
  id            text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('person','event','polity','work')),
  title         text NOT NULL,
  short_desc    text,
  bio           text,          -- first paragraph of the article lead
  lead          text,          -- up to three lead paragraphs
  story         text,          -- one paragraph from a body section
  story_section text,
  dyk           text,          -- Wikipedia "Did you know" hook, from the talk page
  side          text,          -- athens | sparta | persia | null
  side_src      text,          -- provenance of `side`
  phase         text,          -- campaign phase from the war's navbox
  birth         int, death int, birth_approx boolean, death_approx boolean,
  year_start    int, year_end int, year_approx boolean,   -- negative = BC
  result        text, location text,
  wiki_url      text NOT NULL,
  wiki_revid    bigint NOT NULL,
  seed          boolean DEFAULT false
);

CREATE TABLE IF NOT EXISTS images (
  node_id     text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  url         text NOT NULL,           -- self-hosted copy (public/img)
  thumb       text,
  source_url  text,                    -- original Commons file URL
  commons_page text NOT NULL,
  file        text,
  license     text NOT NULL,
  artist      text,
  description text,
  width int, height int
);

-- Generated illustrations (ChatGPT Image). Decorative only, never a source of fact.
CREATE TABLE IF NOT EXISTS artwork (
  node_id    text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  url        text NOT NULL,
  model      text NOT NULL,
  prompt     text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS edges (
  id           serial PRIMARY KEY,
  source       text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target       text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('commanded','fought','wrote','allegiance','mentions')),
  side         text,
  flags        text[],
  weight       int DEFAULT 1,
  evidence     text,
  evidence_url text,
  section      text,
  UNIQUE (source, target, type)
);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS edges_target ON edges(target);

CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
