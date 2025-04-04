const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const Database = require('./database');
const CommandDeployer = require('./deploy-commands');
const axios = require('axios');
const HybridCacheManager = require('./hybridCacheManager'); 
const MessageSplitter = require('./messageSplitter');
const PastebinClient = require('./pastebinClient');
require('dotenv').config();

// Simple logging helpers
const logInfo = (msg, ...args) => console.log(`[INFO] ${msg}`, ...args);
const logDebug = (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args);
const logError = (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args);

// Initialize PasteBin (pastebin method is left unchanged)
const pastebinClient = new PastebinClient(process.env.PASTEBIN_DEV_KEY);

async function safeDeferReply(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
  } catch (error) {
    logError("Error deferring reply:", error);
  }
}

(async () => {
  // Initialize database (create tables if needed)
  const db = new Database();
  await db.init();
  logInfo("Database initialization complete.");

  // Instantiate Hybrid Cache Manager and message splitter
  const redisOptions = { url: process.env.REDIS_URL || 'redis://localhost:6379' };
  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
  const dbName = process.env.MONGO_DB_NAME || 'discordCache';
  const cache = new HybridCacheManager(redisOptions, mongoUrl, dbName);
  const splitter = new MessageSplitter(2000);

  // Specify the default model ID and persona to use if none is set for a guild
  const defaultModelId = 'deepseek-chat';
  const defaultPersona = 'You are a helpful assistant.';
  const defaultApiUrl = process.env.OPENAI_BASE_URL;

  // --- Define Slash Command ---
  const commands = [
    new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Chat with the RakunNakun')
      .addStringOption(option =>
        option.setName('message')
              .setDescription('Your question to RakunNakun')
              .setRequired(true)
      )
  ].map(command => command.toJSON());

  // --- Deploy Commands using CommandDeployer class ---
  const deployer = new CommandDeployer(commands, process.env.CLIENT_ID, process.env.DISCORD_TOKEN);
  await deployer.deploy();
  logInfo("Slash commands deployed.");

  // Create a new Discord client with the required intents
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once('ready', () => {
    logInfo(`Logged in as ${client.user.tag}`);
  });

  // Listen for slash command interactions
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'chat') return;

    const userMessage = interaction.options.getString('message');
    logInfo(`Received message: "${userMessage}" from ${interaction.user.tag}`);

    // Set default factors and values
    let tokenInputFactor = 0.6;
    let tokenOutputFactor = 0.9;
    let tokenCachedInputFactor = 0.6;
    let tokenCachedOutputFactor = 0.9;
    let modelApiKey = process.env.OPENAI_API_KEY;
    let modelBaseUrl = process.env.OPENAI_BASE_URL;
    let modelIdToUse = defaultModelId;
    let personaToUse = defaultPersona;
    let requiredRoleId = null;
    let debugMode = false;
    let currentTokens = 0;
    let pasteUrl;
    
    try {
      // Fetch guild settings including model, token balance, persona, etc.
      if (interaction.guild && interaction.guild.id) {
        const [guildRows] = await db.pool.query(
          'SELECT CHAT_MODELS, GUILD_USERS_ID, GUILD_OWNER_ID, DEBUG, CHAT_TOKENS, CHAT_PERSONA FROM Guilds WHERE GUILD_ID = ?',
          [interaction.guild.id]
        );
        if (guildRows.length === 0) {
          logError("Guild not registered:", interaction.guild.id);
          await interaction.reply(`Your guild is not registered in our system. Please contact the guild owner <@${interaction.guild.ownerId}>.`);
          return;
        }
        currentTokens = Number(guildRows[0].CHAT_TOKENS) || 0;
        logDebug(`Current token balance: ${currentTokens}`);
        if (currentTokens < 2000) {
          logInfo(`Token balance (${currentTokens}) is below threshold for guild ${interaction.guild.id}.`);
          await interaction.reply("Insufficient tokens in your guild. Please recharge tokens.");
          return;
        }
        if (guildRows[0].CHAT_MODELS) {
          modelIdToUse = guildRows[0].CHAT_MODELS;
          logInfo(`Guild ${interaction.guild.id} is using model ${modelIdToUse}`);
        } else {
          logInfo(`Guild ${interaction.guild.id} has no custom model. Using default model.`);
        }
        if (guildRows[0].GUILD_USERS_ID) {
          requiredRoleId = guildRows[0].GUILD_USERS_ID;
        }
        if (guildRows[0].CHAT_PERSONA) {
          personaToUse = guildRows[0].CHAT_PERSONA;
        }
        if (guildRows[0].DEBUG && Number(guildRows[0].DEBUG) === 1) {
          debugMode = true;
          logDebug("Debug mode enabled for this guild.");
        }
      }
      
      // Check required role if defined.
      if (requiredRoleId && !interaction.member.roles.cache.has(requiredRoleId)) {
        logInfo(`User ${interaction.user.tag} lacks the required role (${requiredRoleId}).`);
        await interaction.reply("You don't have the required role to use this command.");
        return;
      }

      // Query the Models table for the model parameters using modelIdToUse
      const [modelRows] = await db.pool.query(
        'SELECT TOKEN_INPUT, TOKEN_OUTPUT, TOKEN_CACHED_INPUT, TOKEN_CACHED_OUTPUT, API_KEY, API_URL FROM Models WHERE MODEL_ID = ?',
        [modelIdToUse]
      );
      if (modelRows.length > 0) {
        tokenInputFactor = modelRows[0].TOKEN_INPUT || tokenInputFactor;
        tokenOutputFactor = modelRows[0].TOKEN_OUTPUT || tokenOutputFactor;
        tokenCachedInputFactor = modelRows[0].TOKEN_CACHED_INPUT || tokenInputFactor;
        tokenCachedOutputFactor = modelRows[0].TOKEN_CACHED_OUTPUT || tokenOutputFactor;
        if (modelRows[0].API_KEY) {
          modelApiKey = modelRows[0].API_KEY;
        }
        if (modelRows[0].API_URL) {
          modelBaseUrl = modelRows[0].API_URL;
        }
        if (debugMode) {
          logDebug("Model row:", modelRows[0]);
        }
      } else {
        logError(`No record found in Models for ${modelIdToUse}. Using default parameters.`);
      }
    } catch (error) {
      logError('Error fetching model parameters:', error);
    }

    // --- Helper Functions to Count Tokens using dynamic factors ---
    const calculateInputTokens = (text, factor = tokenInputFactor) => Math.ceil(text.length * factor);

    // Check cache before making an API call
    const cachedOutput = await cache.getCachedResult(userMessage);
    if (cachedOutput) {
      logDebug("Cache hit: Using cached result for input:", userMessage);
      const cachedInputTokens = Math.ceil(userMessage.length * tokenCachedInputFactor);
      const cachedOutputTokens = Math.ceil(cachedOutput.length * tokenCachedOutputFactor);
      let finalReply = cachedOutput;
      if (debugMode) {
        finalReply += `\n\n**Token Usage (Cached):**\n- Input Tokens: ${cachedInputTokens}\n- Output Tokens: ${cachedOutputTokens}`;
      }
      try {
        pasteUrl = await pastebinClient.createPaste(finalReply, '1M', 'Chat Log (Cached)');
        if (debugMode) {
          logInfo(`Chat logged on Pastebin: ${pasteUrl}`);
        }
      } catch (pasteError) {
        if (debugMode) {
          logError('Failed to create Pastebin paste:', pasteError);
        }
        pasteUrl = "FAILED ERROR CODE";
      }
      await db.pool.query(
        'INSERT INTO ChatLogs (GUILD_ID, GUILD_USERS_ID, MESSAGE_INPUT, MESSAGE_OUTPUT, CACHED) VALUES (?, ?, ?, ?, 1)',
        [interaction.guild.id, interaction.user.id, userMessage, pasteUrl]
      );
      const parts = splitter.split(finalReply);
      if (parts.length === 1) {
        await interaction.reply(parts[0]);
      } else {
        await interaction.reply(parts[0]);
        for (let i = 1; i < parts.length; i++) {
          await interaction.followUp(parts[i]);
        }
      }
      const tokensUsed = cachedInputTokens + cachedOutputTokens;
      await db.pool.query(
        'UPDATE Guilds SET CHAT_TOKENS = CHAT_TOKENS - ? WHERE GUILD_ID = ?',
        [tokensUsed, interaction.guild.id]
      );
      logInfo(`Deducted ${tokensUsed} tokens (cached). New balance: ${currentTokens - tokensUsed}`);
      return;
    } else {
      logDebug("Cache miss: No cached result for input:", userMessage);
    }

    // Defer reply to allow time for API processing
    await safeDeferReply(interaction);

    try {
      logDebug("Sending API request with model:", modelIdToUse);
            let axiosResponse;
      try {
        axiosResponse = await axios.post(
          modelBaseUrl,
          {
            model: modelIdToUse,
            messages: [
              { role: 'system', content: personaToUse },
              { role: 'user', content: userMessage }
            ],
            stream: false
          },
          {
            headers: {
              'Authorization': `Bearer ${modelApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (error) {
        if (
          error.response &&
          error.response.data &&
          error.response.data.error &&
          error.response.data.error.message &&
          error.response.data.error.message.includes('Service is too busy')
        ) {
          logInfo("Primary API is too busy. Falling back to default model and default API.");
          axiosResponse = await axios.post(
            defaultApiUrl,
            {
              model: defaultModelId,
              messages: [
                { role: 'system', content: personaToUse },
                { role: 'user', content: userMessage }
              ],
              stream: false
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
        } else {
          throw error;
        }
      }

      logDebug("API response received.");
      const reply = axiosResponse.data.choices[0].message.content.trim();
      const outputTokens = Math.ceil(reply.length * tokenOutputFactor);
      const apiInputTokens = calculateInputTokens(userMessage);
      await cache.setCache(userMessage, reply);
      logDebug("Caching API response for input:", userMessage);

      let finalReply = reply;
      if (debugMode) {
        finalReply += `\n\n**Token Usage:**\n- Model-ID: \`${modelIdToUse}\`\n- Input Tokens: ${apiInputTokens}\n- Output Tokens: ${outputTokens}`;
      }
      
      try {
        pasteUrl = await pastebinClient.createPaste(finalReply, '1M', 'Chat Log');
        if (debugMode) {
          logInfo(`Chat logged on Pastebin: ${pasteUrl}`);
        }
      } catch (pasteError) {
        if (debugMode) {
          logError('Failed to create Pastebin paste:', pasteError);
        }
        pasteUrl = "FAILED ERROR CODE";
      }
      
      await db.pool.query(
        'INSERT INTO ChatLogs (GUILD_ID, GUILD_USERS_ID, MESSAGE_INPUT, MESSAGE_OUTPUT, CACHED) VALUES (?, ?, ?, ?, 0)',
        [interaction.guild.id, interaction.user.id, userMessage, pasteUrl]
      );
      
      const parts = splitter.split(finalReply);
      if (parts.length === 1) {
        await interaction.editReply(parts[0]);
      } else {
        await interaction.editReply(parts[0]);
        for (let i = 1; i < parts.length; i++) {
          await interaction.followUp(parts[i]);
        }
      }

      const tokensUsed = apiInputTokens + outputTokens;
      await db.pool.query(
        'UPDATE Guilds SET CHAT_TOKENS = CHAT_TOKENS - ? WHERE GUILD_ID = ?',
        [tokensUsed, interaction.guild.id]
      );
      logInfo(`Deducted ${tokensUsed} tokens (API). New balance: ${currentTokens - tokensUsed}`);
    } catch (error) {
      logError('Error with API:', error.response ? error.response.data : error.message);
      await interaction.editReply('There was an error processing your request.');
    }
  });

  client.login(process.env.DISCORD_TOKEN);
})();
