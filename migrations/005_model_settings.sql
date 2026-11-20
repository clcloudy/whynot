CREATE TABLE app.model_settings (
  owner text PRIMARY KEY REFERENCES app.sessions (owner) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 512),
  api_key text NOT NULL CHECK (char_length(api_key) BETWEEN 1 AND 1024),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 128),
  image_enabled boolean NOT NULL DEFAULT false
);
