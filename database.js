// database.js

const mysql = require('mysql2/promise');
require('dotenv').config();

class Database {
  constructor() {
    this.pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'discord_bot',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }

  // Initializes the database by creating the Models and Guilds tables
  async init() {
    // SQL query to create the "Models" table with columns MODEL_ID, TOKEN_INPUT, TOKEN_OUTPUT, and API_KEY
    const createModelsQuery = `
      CREATE TABLE IF NOT EXISTS Models (
        MODEL_ID VARCHAR(255) NOT NULL PRIMARY KEY,
        TOKEN_INPUT DECIMAL(10,2),
        TOKEN_OUTPUT DECIMAL(10,2),
        TOKEN_CACHED_INPUT DECIMAL(10,2),
        TOKEN_CACHED_OUPUT DECIMAL(10,2),
        API_KEY VARCHAR(255),
        API_URL VARCHAR(255)
      );
    `;

    // SQL query to create the "Guilds" table with a foreign key on CHAT_MODELS referencing Models.MODEL_ID
    const createGuildsQuery = `
      CREATE TABLE IF NOT EXISTS Guilds (
        GUILD_ID VARCHAR(255) NOT NULL PRIMARY KEY,
        GUILD_OWNER_ID VARCHAR(255) NOT NULL,
        GUILD_USERS_ID TEXT,
        CHAT_TOKENS TEXT,
        CHAT_MODELS VARCHAR(255),
        CHAT_PERSONA TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
        STATUS TINYINT(1) DEFAULT 1,
        DEBUG TINYINT(1) DEFAULT 0,
        CONSTRAINT fk_chat_models FOREIGN KEY (CHAT_MODELS) REFERENCES Models(MODEL_ID)
          ON UPDATE CASCADE
          ON DELETE SET NULL
      );
    `;
    // Create ChatLogs table
    const createChatLogsQuery = `
      CREATE TABLE IF NOT EXISTS ChatLogs (
        GUILD_ID VARCHAR(255) NOT NULL,
        GUILD_USERS_ID TEXT,
        MESSAGE_INPUT TEXT NOT NULL,
        MESSAGE_OUTPUT TEXT NOT NULL,
        CACHED TINYINT(1) NOT NULL DEFAULT 0,
        TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    try {
      await this.pool.query(createModelsQuery);
      console.log('Models table is ready or already exists.');
      await this.pool.query(createGuildsQuery);
      console.log('Guilds table is ready or already exists.');
      await this.pool.query(createChatLogsQuery);
      console.log('ChatLogs table is ready or already exists.');
    } catch (error) {
      console.error('Error creating tables:', error);
    }
  }
}

module.exports = Database;
