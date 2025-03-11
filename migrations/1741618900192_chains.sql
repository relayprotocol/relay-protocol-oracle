-- Up Migration

CREATE TABLE "chains" (
  "id" BIGINT NOT NULL,
  "name" TEXT NOT NULL,
  "http_rpc_url" TEXT NOT NULL,
  "ws_rpc_url" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "chains"
  ADD CONSTRAINT "chains_pk"
  PRIMARY KEY ("id");

CREATE INDEX "chains_created_at_index"
  ON "chains" ("created_at");

CREATE INDEX "chains_updated_at_index"
  ON "chains" ("updated_at");

-- Down Migration