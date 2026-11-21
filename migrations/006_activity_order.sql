ALTER TABLE app.recommendations ADD COLUMN recommendation_seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX recommendations_owner_scene_recent_idx
  ON app.recommendations (owner, scene, created_at DESC, recommendation_seq DESC);
