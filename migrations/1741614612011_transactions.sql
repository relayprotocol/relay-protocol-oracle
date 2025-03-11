-- Up Migration

CREATE TABLE "transactions" (
  "chain_id" BIGINT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "block" BIGINT NOT NULL,
  "timestamp" INT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_pk"
  PRIMARY KEY ("chain_id", "transaction_id");

CREATE INDEX "transactions_created_at_index"
  ON "transactions" ("created_at");

CREATE INDEX "transactions_updated_at_index"
  ON "transactions" ("updated_at");

CREATE TABLE "transaction_entries" (
  "chain_id" BIGINT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "entry_id" TEXT NOT NULL,
  "owner_address" TEXT NOT NULL,
  "currency_address" TEXT NOT NULL,
  "balance_diff" NUMERIC(78, 0) NOT NULL,
  "commitment_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "transaction_entries"
  ADD CONSTRAINT "transaction_entries_pk"
  PRIMARY KEY ("chain_id", "transaction_id", "entry_id");

CREATE INDEX "transaction_entries_created_at_index"
  ON "transaction_entries" ("created_at");

CREATE INDEX "transaction_entries_updated_at_index"
  ON "transaction_entries" ("updated_at");

-- Down Migration