-- 随机互动阶段 3+4：看图学词与经确认的近况记忆。
-- 仅新增表和列，历史卡片与既有互动不受影响。

ALTER TABLE app.interactions ADD COLUMN word jsonb;
ALTER TABLE app.interactions ADD COLUMN memory_id uuid;
ALTER TABLE app.interactions ADD COLUMN memory_version integer;
ALTER TABLE app.interactions ADD COLUMN is_revisit boolean NOT NULL DEFAULT false;
ALTER TABLE app.interactions ADD COLUMN last_activity timestamptz NOT NULL DEFAULT now();

ALTER TABLE app.turns ADD COLUMN word jsonb;

CREATE UNIQUE INDEX interactions_id_owner_unique ON app.interactions (id, owner);
CREATE UNIQUE INDEX turns_id_owner_unique ON app.turns (id, owner);

-- 短期图片引用：绑定会话与轮次版本，识别完成或到期后删除。
CREATE TABLE app.images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL REFERENCES app.sessions (owner),
  interaction_id uuid NOT NULL,
  version integer NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL,
  data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT images_interaction_owner_fk FOREIGN KEY (interaction_id, owner) REFERENCES app.interactions (id, owner)
);
CREATE INDEX images_owner_expires_idx ON app.images (owner, expires_at);

-- 候选摘要：绑定来源轮次，同一来源轮次最多一条。
CREATE TABLE app.memory_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL REFERENCES app.sessions (owner),
  interaction_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  kind text NOT NULL,
  topic text NOT NULL,
  text text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT memory_candidates_turn_unique UNIQUE (turn_id),
  CONSTRAINT memory_candidates_turn_owner_fk FOREIGN KEY (turn_id, owner) REFERENCES app.turns (id, owner)
);

-- 已确认记忆：candidate_id 唯一，删除后旧确认无法重建。
CREATE TABLE app.memories (
  id uuid PRIMARY KEY,
  owner text NOT NULL REFERENCES app.sessions (owner),
  candidate_id uuid NOT NULL,
  kind text NOT NULL,
  topic text NOT NULL,
  text text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_prompted_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  CONSTRAINT memories_candidate_unique UNIQUE (candidate_id)
);
CREATE INDEX memories_owner_kind_expires_idx ON app.memories (owner, kind, expires_at);

-- 更正版次凭据：同版次并发编辑只有一条成功。
CREATE TABLE app.memory_revisions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES app.memories (id) ON DELETE CASCADE,
  version integer NOT NULL,
  text text NOT NULL
);

-- 轮次对记忆版本的依赖：更正或删除后，依赖旧版本的轮次退出后续上下文。
CREATE TABLE app.turn_memories (
  turn_id uuid NOT NULL REFERENCES app.turns (id) ON DELETE CASCADE,
  memory_id uuid NOT NULL,
  version integer NOT NULL,
  PRIMARY KEY (turn_id, memory_id)
);

-- 删除凭据：只存编号与归属，让本人重复删除幂等，未知编号仍按缺失处理。
CREATE TABLE app.memory_deletions (
  id uuid PRIMARY KEY,
  owner text NOT NULL REFERENCES app.sessions (owner),
  deleted_at timestamptz NOT NULL DEFAULT now()
);