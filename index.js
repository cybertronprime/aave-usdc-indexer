require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const ethers = require('ethers');
const cron = require('node-cron');

// Constants
const CONTRACTS = {
    LENDING_POOL: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    AUSDC: '0xBcca60bB61934080951369a648Fb03DF4F96263C',
};

// ABIs
const LENDING_POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function getReservesList() external view returns (address[])",
    "function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
    "event Deposit(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referral)",
    "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 interestRateMode, uint256 borrowRate, uint16 indexed referral)",
    "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount)",
    "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
    "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"
];

const CHAINLINK_ABI = [
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

const ATOKEN_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Database setup
const pool = new Pool({
    connectionString: process.env.DB_CONNECTION_STRING
});

// Ethereum provider setup with WebSocket and fallback
let provider;
let lendingPool;
let ethUsdPriceFeed;

function setupProviderAndContracts() {
    try {
        // Try WebSocket first
        const wsProvider = new ethers.providers.WebSocketProvider(
            process.env.INFURA_WS_URL || process.env.INFURA_URL.replace('https', 'wss')
        );
        
        wsProvider.on('error', (error) => {
            console.error('WebSocket error:', error);
            setupFallbackProvider();
        });

        provider = wsProvider;
    } catch (error) {
        console.log('Falling back to HTTP provider');
        setupFallbackProvider();
    }

    // Set up contracts
    lendingPool = new ethers.Contract(CONTRACTS.LENDING_POOL, LENDING_POOL_ABI, provider);
    ethUsdPriceFeed = new ethers.Contract(process.env.CHAINLINK_ETH_USD_FEED, CHAINLINK_ABI, provider);
}

function setupFallbackProvider() {
    provider = new ethers.providers.JsonRpcProvider(process.env.INFURA_URL);
}

// Initial setup
setupProviderAndContracts();

// Helper function to format numbers
function formatNumber(num) {
    return new Intl.NumberFormat('en-US', { 
        minimumFractionDigits: 2,
        maximumFractionDigits: 2 
    }).format(num);
}

async function getETHPrice() {
    try {
        const { answer } = await ethUsdPriceFeed.latestRoundData();
        const price = ethers.utils.formatUnits(answer, 8);
        console.log(`Current ETH price: $${formatNumber(price)}`);
        return price;
    } catch (error) {
        console.error('Error fetching ETH price:', error);
        throw error;
    }
}

async function updateAccountData(userAddress) {
    try {
        console.log(`\nUpdating data for account: ${userAddress}`);
        const ethPrice = await getETHPrice();
        const userData = await lendingPool.getUserAccountData(userAddress);

        // Handle infinite health factor for accounts with no debt
        let healthFactor;
        if (userData.totalDebtETH.isZero()) {
            healthFactor = 100; // Use a high but reasonable number for accounts with no debt
        } else {
            healthFactor = parseFloat(ethers.utils.formatUnits(userData.healthFactor, 18));
            // Cap health factor at a reasonable maximum
            healthFactor = Math.min(healthFactor, 100);
        }

        const totalCollateralUSD = parseFloat(ethers.utils.formatEther(userData.totalCollateralETH)) * parseFloat(ethPrice);
        const totalDebtUSD = parseFloat(ethers.utils.formatEther(userData.totalDebtETH)) * parseFloat(ethPrice);
        const ltv = parseFloat(ethers.utils.formatUnits(userData.ltv, 4));

        // Log the raw values for debugging
        console.log('Raw values:', {
            healthFactorRaw: ethers.utils.formatUnits(userData.healthFactor, 18),
            totalCollateralETH: ethers.utils.formatEther(userData.totalCollateralETH),
            totalDebtETH: ethers.utils.formatEther(userData.totalDebtETH),
            ltv: ethers.utils.formatUnits(userData.ltv, 4)
        });

        console.log(`Account Data:
            Health Factor: ${formatNumber(healthFactor)}
            Total Collateral (USD): $${formatNumber(totalCollateralUSD)}
            Total Debt (USD): $${formatNumber(totalDebtUSD)}
            LTV: ${formatNumber(ltv)}%`);

        // Only store if the account has any activity
        if (totalCollateralUSD > 0 || totalDebtUSD > 0) {
            // Update database
            await pool.query(
                `INSERT INTO account_positions 
                 (wallet_address, health_factor, total_collateral_usd, total_debt_usd, ltv, last_updated, needs_notification)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
                 ON CONFLICT (wallet_address) 
                 DO UPDATE SET 
                    health_factor = $2,
                    total_collateral_usd = $3,
                    total_debt_usd = $4,
                    ltv = $5,
                    last_updated = CURRENT_TIMESTAMP,
                    needs_notification = $6`,
                [
                    userAddress, 
                    healthFactor, 
                    totalCollateralUSD, 
                    totalDebtUSD, 
                    ltv,
                    healthFactor < parseFloat(process.env.ALERT_THRESHOLD)
                ]
            );

            // Alert for risky positions
            if (healthFactor < parseFloat(process.env.ALERT_THRESHOLD)) {
                console.log(`ALERT: Account ${userAddress}
                    Health Factor: ${formatNumber(healthFactor)}
                    Total Collateral: $${formatNumber(totalCollateralUSD)}
                    Total Debt: $${formatNumber(totalDebtUSD)}
                    Action Required!`);
            }
        } else {
            console.log('Skipping storage - Account has no activity');
        }
    } catch (error) {
        console.error(`Error updating account data for ${userAddress}:`, error);
    }
}

async function fetchHistoricalEvents() {
    try {
        console.log('\nFetching historical events...');
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = latestBlock - parseInt(process.env.BLOCK_RANGE || '10000');
        console.log(`Scanning blocks ${fromBlock} to ${latestBlock}`);

        const events = ['Deposit', 'Borrow', 'Repay', 'Withdraw', 'LiquidationCall'];
        const uniqueAddresses = new Set();

        // Get aUSDC holders
        const aUsdcContract = new ethers.Contract(CONTRACTS.AUSDC, ATOKEN_ABI, provider);
        const transferFilter = aUsdcContract.filters.Transfer();
        const transfers = await aUsdcContract.queryFilter(transferFilter, fromBlock, latestBlock);
        
        console.log(`Found ${transfers.length} aUSDC transfer events`);
        transfers.forEach(transfer => {
            if (transfer.args.from !== ethers.constants.AddressZero) uniqueAddresses.add(transfer.args.from);
            if (transfer.args.to !== ethers.constants.AddressZero) uniqueAddresses.add(transfer.args.to);
        });

        // Get addresses from lending pool events
        for (const eventName of events) {
            console.log(`Fetching ${eventName} events...`);
            const filter = lendingPool.filters[eventName]();
            const logs = await lendingPool.queryFilter(filter, fromBlock, latestBlock);
            console.log(`Found ${logs.length} ${eventName} events`);
            
            for (const log of logs) {
                if (log.args && log.args.reserve && 
                    log.args.reserve.toLowerCase() === CONTRACTS.AUSDC.toLowerCase()) {
                    if (log.args.user) uniqueAddresses.add(log.args.user);
                    if (log.args.onBehalfOf) uniqueAddresses.add(log.args.onBehalfOf);
                    if (log.args.repayer) uniqueAddresses.add(log.args.repayer);
                }
            }
        }

        const addresses = Array.from(uniqueAddresses);
        console.log(`\nFound ${addresses.length} unique addresses with aUSDC activity`);
        
        // Process addresses in batches to avoid rate limiting
        const batchSize = 10;
        for (let i = 0; i < addresses.length; i += batchSize) {
            const batch = addresses.slice(i, i + batchSize);
            await Promise.all(batch.map(address => updateAccountData(address)));
            if (i + batchSize < addresses.length) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay between batches
            }
        }
    } catch (error) {
        console.error('Error in fetchHistoricalEvents:', error);
    }
}

function setupEventListeners() {
    const events = ['Deposit', 'Borrow', 'Repay', 'Withdraw', 'LiquidationCall'];
    
    events.forEach(eventName => {
        lendingPool.on(eventName, async (...args) => {
            try {
                const eventObj = args[args.length - 1];
                if (eventObj.args && eventObj.args.reserve && 
                    eventObj.args.reserve.toLowerCase() === CONTRACTS.AUSDC.toLowerCase()) {
                    const userAddress = eventObj.args.user || eventObj.args.onBehalfOf || eventObj.args.repayer;
                    if (userAddress) {
                        console.log(`\nEvent ${eventName} detected for user ${userAddress}`);
                        await updateAccountData(userAddress);
                    }
                }
            } catch (error) {
                console.error(`Error processing ${eventName} event:`, error);
            }
        });
    });

    // Monitor aUSDC transfers
    const aUsdcContract = new ethers.Contract(CONTRACTS.AUSDC, ATOKEN_ABI, provider);
    aUsdcContract.on('Transfer', async (from, to) => {
        if (from !== ethers.constants.AddressZero) await updateAccountData(from);
        if (to !== ethers.constants.AddressZero) await updateAccountData(to);
    });
}

// API Setup
const app = express();
app.use(express.json());

app.get('/positions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM account_positions ORDER BY health_factor ASC');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/risky-positions', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM account_positions WHERE health_factor < $1 ORDER BY health_factor ASC',
            [process.env.ALERT_THRESHOLD]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/position/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const result = await pool.query(
            'SELECT * FROM account_positions WHERE wallet_address = $1',
            [address.toLowerCase()]
        );
        if (result.rows.length === 0) {
            await updateAccountData(address);
            const updatedResult = await pool.query(
                'SELECT * FROM account_positions WHERE wallet_address = $1',
                [address.toLowerCase()]
            );
            res.json(updatedResult.rows[0] || { error: 'Address not found' });
        } else {
            res.json(result.rows[0]);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Periodic update job (every 30 seconds)
setInterval(async () => {
    console.log('\nRunning periodic update...');
    try {
        const result = await pool.query('SELECT wallet_address FROM account_positions');
        for (const row of result.rows) {
            await updateAccountData(row.wallet_address);
        }
    } catch (error) {
        console.error('Error in periodic update:', error);
    }
}, parseInt(process.env.CHECK_INTERVAL_SEC || '30') * 1000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    
    try {
        // Test database connection
        await pool.query('SELECT NOW()');
        console.log('Database connection successful');
        
        // Initial setup
        await fetchHistoricalEvents();
        
        // Setup real-time event listeners
        setupEventListeners();
        console.log('Event listeners set up');
        
        console.log('Starting periodic updates...');
    } catch (error) {
        console.error('Error during startup:', error);
        process.exit(1);
    }
});