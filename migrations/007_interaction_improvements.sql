ALTER TABLE app.memories ADD COLUMN topic_id text;
ALTER TABLE app.memory_candidates ADD COLUMN topic_id text;
CREATE INDEX memories_owner_topic_idx ON app.memories (owner, topic_id, expires_at);

INSERT INTO app.turn_memories (turn_id, memory_id, version)
SELECT c.turn_id, m.id, 1 FROM app.memories m
JOIN app.memory_candidates c ON c.id = m.candidate_id AND c.owner = m.owner
ON CONFLICT DO NOTHING;
SELECT app.redact_invalid_memory_turns(owner, statement_timestamp())
FROM (SELECT DISTINCT owner FROM app.memories) AS owners;

CREATE TABLE app.interaction_requests (
  owner text NOT NULL REFERENCES app.sessions (owner),
  scope text NOT NULL,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  claim_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner, scope, request_id)
);
CREATE INDEX interaction_requests_expiry_idx ON app.interaction_requests (expires_at);
