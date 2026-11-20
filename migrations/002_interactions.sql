-- 随机互动阶段 1+2：互动一对一表与轮次子表。
-- 仅新增表和约束，历史推荐卡片不受影响，可继续展示和反馈。
CREATE TABLE app.interactions (
  id uuid PRIMARY KEY REFERENCES app.recommendations (id),
  owner text NOT NULL REFERENCES app.sessions (owner),
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  mode text NOT NULL,
  topic text NOT NULL,
  state text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_replacement boolean NOT NULL DEFAULT false,
  scene text,
  energy text NOT NULL,
  budget integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interactions_owner_request_unique UNIQUE (owner, request_id)
);
CREATE INDEX interactions_owner_created_idx ON app.interactions (owner, created_at);

CREATE TABLE app.turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_id uuid NOT NULL REFERENCES app.interactions (id),
  owner text NOT NULL REFERENCES app.sessions (owner),
  request_id uuid NOT NULL,
  version integer NOT NULL,
  user_text text NOT NULL,
  reply_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turns_interaction_request_unique UNIQUE (interaction_id, request_id),
  CONSTRAINT turns_interaction_version_unique UNIQUE (interaction_id, version)
);