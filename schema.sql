CREATE TABLE app.sessions (
  owner text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL REFERENCES app.sessions (owner),
  scene text,
  energy text NOT NULL,
  budget integer NOT NULL,
  action text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  first_step text NOT NULL,
  detail text NOT NULL,
  minutes integer NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  preference text,
  completed boolean NOT NULL DEFAULT false
);
CREATE INDEX recommendations_owner_created_idx ON app.recommendations (owner, created_at);