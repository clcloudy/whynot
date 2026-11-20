ALTER TABLE app.turns ADD COLUMN IF NOT EXISTS image_ref uuid;
ALTER TABLE app.turns ADD COLUMN recall boolean NOT NULL DEFAULT false;
ALTER TABLE app.turns ADD COLUMN payload_hash text;
UPDATE app.turns SET payload_hash = encode(sha256(convert_to(
  version::text || chr(31) || user_text || chr(31) || coalesce(image_ref::text, ''), 'UTF8'
)), 'hex');
ALTER TABLE app.turns ALTER COLUMN payload_hash SET NOT NULL;
ALTER TABLE app.interactions ADD COLUMN pending_image_id uuid;
ALTER TABLE app.interactions ADD COLUMN opening_seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE app.memories ADD COLUMN candidate_interaction_id uuid;
ALTER TABLE app.memories ADD COLUMN candidate_version integer;
UPDATE app.memories AS m
SET candidate_interaction_id = c.interaction_id, candidate_version = c.version
FROM app.memory_candidates AS c
WHERE c.id = m.candidate_id AND c.owner = m.owner;

-- A previously interrupted save may have left a turn ahead of the interaction.
-- Remove it so the original request can be retried at the current version.
ALTER TABLE app.memory_candidates DROP CONSTRAINT memory_candidates_turn_owner_fk;
ALTER TABLE app.memory_candidates ADD CONSTRAINT memory_candidates_turn_owner_fk
  FOREIGN KEY (turn_id, owner) REFERENCES app.turns (id, owner) ON DELETE CASCADE;
ALTER TABLE app.turns ADD CONSTRAINT turns_interaction_owner_fk
  FOREIGN KEY (interaction_id, owner) REFERENCES app.interactions (id, owner);
DELETE FROM app.turns AS t USING app.interactions AS i
WHERE t.interaction_id = i.id AND t.version >= i.version;

UPDATE app.interactions AS i
SET pending_image_id = (
  SELECT img.id FROM app.images AS img
  WHERE img.interaction_id = i.id AND img.owner = i.owner AND img.version < i.version
  ORDER BY img.version DESC, img.created_at DESC, img.id LIMIT 1
)
WHERE i.mode = 'photo' AND i.state = 'awaiting_image' AND i.version > 1;

-- Earlier revisit turns did not consistently record indirect dependencies.
INSERT INTO app.turn_memories (turn_id, memory_id, version)
SELECT t.id, i.memory_id, i.memory_version
FROM app.turns AS t JOIN app.interactions AS i ON i.id = t.interaction_id
WHERE i.is_revisit AND i.memory_id IS NOT NULL AND i.memory_version IS NOT NULL
ON CONFLICT DO NOTHING;

-- Edits no longer need a second copy of previous memory text.
DELETE FROM app.memory_revisions;
CREATE INDEX interactions_activity_idx ON app.interactions (last_activity)
  WHERE state IN ('open', 'awaiting_image');
CREATE INDEX interactions_opening_history_idx ON app.interactions (owner, created_at DESC, opening_seq DESC);
CREATE INDEX images_expiry_idx ON app.images (expires_at);
CREATE INDEX memory_candidates_expiry_idx ON app.memory_candidates (expires_at);
CREATE INDEX memories_expiry_idx ON app.memories (expires_at);

CREATE FUNCTION app.redact_invalid_memory_turns(p_owner text, p_now timestamptz)
RETURNS void LANGUAGE sql SET search_path = pg_catalog AS $$
  WITH invalid_turns AS (
    SELECT t.id
    FROM app.turns AS t
    WHERE t.owner = p_owner AND EXISTS (
      SELECT 1 FROM app.turn_memories AS d
      WHERE d.turn_id = t.id AND NOT EXISTS (
        SELECT 1 FROM app.memories AS m
        WHERE m.id = d.memory_id AND m.owner = p_owner
          AND m.version = d.version AND m.expires_at > p_now
      )
    )
  ), redacted AS (
    UPDATE app.turns AS t SET user_text = '', reply_text = ''
    FROM invalid_turns AS i WHERE t.id = i.id AND t.reply_text <> ''
    RETURNING t.id
  )
  DELETE FROM app.memory_candidates AS c USING redacted AS r WHERE c.turn_id = r.id;
$$;

CREATE FUNCTION app.clear_interaction(p_owner text, p_id uuid, p_state text)
RETURNS void LANGUAGE sql SET search_path = pg_catalog AS $$
  UPDATE app.interactions SET state = p_state, word = NULL, pending_image_id = NULL,
    memory_id = NULL, memory_version = NULL
  WHERE id = p_id AND owner = p_owner;
  DELETE FROM app.images WHERE interaction_id = p_id AND owner = p_owner;
  DELETE FROM app.turns WHERE interaction_id = p_id AND owner = p_owner;
$$;

-- Run from an independent scheduler. The owner lock also protects HTTP
-- commits, so expiry and memory invalidation cannot race a committed reply.
CREATE FUNCTION app.purge_expired(p_now timestamptz DEFAULT statement_timestamp())
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  expired_owner text;
  expired_id uuid;
BEGIN
  FOR expired_owner IN
    SELECT s.owner FROM app.sessions AS s JOIN (
      SELECT owner FROM app.interactions WHERE state IN ('open', 'awaiting_image')
        AND last_activity <= p_now - interval '24 hours'
      UNION SELECT owner FROM app.images WHERE expires_at <= p_now AND data <> ''
      UNION SELECT owner FROM app.memory_candidates WHERE expires_at <= p_now AND text <> ''
      UNION SELECT owner FROM app.memories WHERE expires_at <= p_now
    ) AS due ON s.owner = due.owner
    ORDER BY s.owner FOR UPDATE OF s SKIP LOCKED
  LOOP
    FOR expired_id IN
      SELECT id FROM app.interactions WHERE owner = expired_owner
        AND state IN ('open', 'awaiting_image') AND last_activity <= p_now - interval '24 hours'
    LOOP
      PERFORM app.clear_interaction(expired_owner, expired_id, 'expired');
    END LOOP;
    UPDATE app.images SET data = '' WHERE owner = expired_owner AND expires_at <= p_now AND data <> '';
    UPDATE app.memory_candidates SET text = ''
      WHERE owner = expired_owner AND expires_at <= p_now AND text <> '';
    PERFORM app.redact_invalid_memory_turns(expired_owner, p_now);
    DELETE FROM app.memories WHERE owner = expired_owner AND expires_at <= p_now;
  END LOOP;
END;
$$;

SELECT app.redact_invalid_memory_turns(revisits.owner, statement_timestamp())
FROM (
  SELECT DISTINCT t.owner FROM app.turns AS t JOIN app.turn_memories AS d ON d.turn_id = t.id
) AS revisits;

REVOKE ALL ON FUNCTION app.redact_invalid_memory_turns(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.clear_interaction(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_expired(timestamptz) FROM PUBLIC;
