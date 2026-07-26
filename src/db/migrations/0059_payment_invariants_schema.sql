DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'receipt';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'thanks_token';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE verb_type ADD VALUE IF NOT EXISTS 'refund';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE wallet_transaction_type ADD VALUE IF NOT EXISTS 'connect_payout';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE capital_entry_settlement_status AS ENUM ('pending', 'cleared');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS capital_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  source_entry_id uuid,
  source_transaction_id uuid REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL,
  remaining_cents integer NOT NULL,
  settlement_status capital_entry_settlement_status NOT NULL DEFAULT 'cleared',
  available_on timestamptz,
  source_type text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capital_entries_wallet_id_idx
  ON capital_entries(wallet_id);
CREATE INDEX IF NOT EXISTS capital_entries_source_entry_id_idx
  ON capital_entries(source_entry_id);
CREATE INDEX IF NOT EXISTS capital_entries_source_transaction_id_idx
  ON capital_entries(source_transaction_id);
CREATE INDEX IF NOT EXISTS capital_entries_settlement_status_idx
  ON capital_entries(settlement_status);
CREATE INDEX IF NOT EXISTS capital_entries_available_on_idx
  ON capital_entries(available_on);
CREATE INDEX IF NOT EXISTS capital_entries_created_at_idx
  ON capital_entries(created_at);
