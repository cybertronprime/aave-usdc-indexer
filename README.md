# Aave USDC Position Monitor

A lightweight indexer service that monitors aUSDC positions on Aave, tracking health factors and liquidation risks. The service monitors positions specifically interacting with the aUSDC contract, providing real-time updates and alerts for positions at risk of liquidation.

## Features

- 🔍 Monitors aUSDC positions specifically
- ⚡ Real-time event monitoring for:
  - Deposits
  - Borrows
  - Repayments
  - Withdrawals
  - Liquidation calls
- 📊 Tracks key metrics:
  - Health Factor (HF)
  - Total Collateral in USD
  - Total Debt in USD
  - Loan-to-Value (LTV) ratio
- ⚠️ Alerts for positions with HF < 1.05
- 🕒 30-second periodic updates
- 📱 REST API endpoints for data access

## Prerequisites

- Node.js >= 14
- PostgreSQL >= 12
- Infura API key (or other Ethereum node provider)

## Installation

1. Clone the repository:
```bash
git clone 
cd aave-usdc-indexer
```

2. Install dependencies:
```bash
npm install
```

3. Set up PostgreSQL database:
```sql
CREATE USER aave_user WITH PASSWORD 'your_password';
CREATE DATABASE aave_indexer;
GRANT ALL PRIVILEGES ON DATABASE aave_indexer TO aave_user;

\c aave_indexer

CREATE TABLE account_positions (
    wallet_address VARCHAR(42) PRIMARY KEY,
    health_factor NUMERIC(78, 18),
    total_collateral_usd NUMERIC(78, 18),
    total_debt_usd NUMERIC(78, 18),
    ltv NUMERIC(78, 18),
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    needs_notification BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_health_factor ON account_positions(health_factor);
CREATE INDEX idx_last_updated ON account_positions(last_updated);
```

4. Create .env file:
```env
INFURA_URL=https://mainnet.infura.io/v3/your-key
DB_CONNECTION_STRING=postgresql://aave_user:your_password@localhost:5432/aave_indexer
CHAINLINK_ETH_USD_FEED=0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
CHECK_INTERVAL_SEC=30
ALERT_THRESHOLD=1.05
BLOCK_RANGE=10000
PORT=3000
```

## Usage

1. Start the service:
```bash
npm start
```

2. Available API Endpoints:

- GET `/positions` - List all monitored positions
- GET `/risky-positions` - List positions with HF < 1.05
- GET `/position/:address` - Get specific position details

Example API Response:
```json
{
    "wallet_address": "0x123...",
    "health_factor": "1.2",
    "total_collateral_usd": "500.00",
    "total_debt_usd": "400.00",
    "ltv": "0.75",
    "last_updated": "2024-01-12T12:00:00Z",
    "needs_notification": false
}
```

## Monitoring

The service provides console outputs for:
- Position updates every 30 seconds
- Real-time event monitoring
- Alerts for positions with HF < 1.05
- Error logging

Example alert:
```
⚠️ ALERT: Account 0x123...
    Health Factor: 0.95
    Total Collateral: $500.00
    Total Debt: $400.00
    Action Required!
```

## Contract Addresses

- aUSDC: 0xBcca60bB61934080951369a648Fb03DF4F96263C
- Lending Pool: 0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9
- ETH/USD Price Feed: 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419

## Architecture

1. **Event Monitoring**:
   - Listens to aUSDC-specific events from Aave
   - Updates position data in real-time

2. **Periodic Updates**:
   - Checks all positions every 30 seconds
   - Updates metrics and risk factors

3. **Database**:
   - PostgreSQL for persistent storage
   - Indexed queries for efficient data retrieval

4. **Price Feeds**:
   - Uses Chainlink ETH/USD price feed
   - Converts collateral values to USD

## Error Handling

- Automatic reconnection for WebSocket disconnects
- Batch processing with rate limiting
- Comprehensive error logging
- Fallback HTTP provider

## Performance Considerations

- Batch processing of historical events
- Indexed database queries
- Efficient event filtering
- Rate limiting for API calls
