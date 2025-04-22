const { Pool } = require('pg');
const winston = require('winston');

// Configure logger for database operations
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/app.log' }),
    new winston.transports.Console()
  ]
});

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false // Enable SSL only for Render
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    logger.error(`Database connection error: ${err.message}, Host: ${pool.options.host}, Database: ${pool.options.database}`);
    process.exit(1); // Exit process on connection failure
  }
  logger.info('Connected to PostgreSQL database');
  release(); // Release client back to pool
});

// Export pool for use in other modules
module.exports = pool;