-- init.sql
CREATE TABLE IF NOT EXISTS account_positions (
    wallet_address VARCHAR(42) PRIMARY KEY,
     health_factor NUMERIC(78, 18),
    total_collateral_usd DECIMAL(20, 8),
    total_debt_usd DECIMAL(20, 8),
    ltv DECIMAL(20, 8),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    needs_notification BOOLEAN DEFAULT FALSE
);

-- Index for quick health factor queries
CREATE INDEX IF NOT EXISTS idx_health_factor ON account_positions(health_factor);
CREATE INDEX IF NOT EXISTS idx_last_updated ON account_positions(last_updated);