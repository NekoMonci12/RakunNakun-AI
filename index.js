// index.js

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const Database           = require('./database');
const CommandDeployer    = require('./deploy-commands');
const HybridCacheManager = require('./hybridCacheManager');
const MessageSplitter    = require('./messageSplitter');
const PastebinClient     = require('./pastebinClient');

// ——— Logging Helpers ———
const logInfo  = (msg, ...args) => console.log(`[INFO]  ${msg}`, ...args);
const logDebug = (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args);
const logError = (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args);

// ——— Globals / Defaults ———
const defaultModelId   = 'deepseek-chat';
const defaultPersona   = 'You are a helpful assistant.';
const defaultApiUrl    = process.env.OPENAI_BASE_URL;
const MIN_TOKEN_THRESH = 2000;

// ——— Init Shared Resources ———
const db           = new Database();
const cache        = new HybridCacheManager(
  { url: process.env.REDIS_URL }, 
  process.env.MONGO_URL, 
  process.env.MONGO_DB_NAME
);
const splitter     = new MessageSplitter(2000);
const pastebin     = new PastebinClient(process.env.PASTEBIN_DEV_KEY);

(async () => {
  // 1️⃣ Database tables
  await db.init();
  logInfo('Database initialized.');

  // 2️⃣ Deploy Discord Slash Commands
  const commands = [
    new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Chat with the RakunNakun')
      .addStringOption(o => o.setName('message').setDescription('Your question').setRequired(true)),
      
    new SlashCommandBuilder()
      .setName('generate-api')
      .setDescription('Generate a new API key for this guild'),
  
    new SlashCommandBuilder()
      .setName('list-api')
      .setDescription('List all API keys for this guild'),
  
    new SlashCommandBuilder()
      .setName('delete-api')
      .setDescription('Delete an API key')
      .addStringOption(o => o.setName('key').setDescription('API key to delete').setRequired(true))
  ].map(c => c.toJSON());
  
  await new CommandDeployer(commands, process.env.CLIENT_ID, process.env.DISCORD_TOKEN).deploy();
  logInfo('Slash commands deployed.');

  // 3️⃣ Start Discord Bot
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', () => logInfo(`Logged in as ${client.user.tag}`));
  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
  
    const { commandName, guildId, user, options } = interaction;
  
    // Only run permission check for certain commands
    const commandsRequiringOwnership = ['generate-api', 'list-api', 'delete-api'];
    if (commandsRequiringOwnership.includes(commandName)) {
      const [guildRows] = await db.pool.query(
        'SELECT GUILD_OWNER_ID FROM Guilds WHERE GUILD_ID = ?',
        [guildId]
      );
  
      if (!guildRows.length || guildRows[0].GUILD_OWNER_ID !== user.id) {
        return await interaction.reply({
          content: '❌ You do not have permission to use this command. Only the guild owner can use this command.',
          ephemeral: true
        });
      }
    }
  
    // Handle /chat
    if (commandName === 'chat') {
      const userMessage = options.getString('message');
      logInfo(`[/chat] ${user.tag}: ${userMessage}`);
  
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply();
        }
      } catch (err) {
        logError('Defer error:', err);
      }
  
      const { reply, tokensUsed } = await processMessage({
        message: userMessage,
        authKey: user.id,
        isDiscord: true,
        guildId,
        userId: user.id
      });
  
      if (reply) {
        const parts = splitter.split(reply);
        await interaction.editReply(parts.shift());
        for (const part of parts) await interaction.followUp(part);
      } else {
        await interaction.editReply('❌ Failed to get a response.');
      }
    }
  
    // Handle /generate-api
    else if (commandName === 'generate-api') {
      const apiKey = uuidv4();
      await db.pool.query(
        'INSERT INTO ApiKeys (API_KEY, GUILD_ID, USER_ID) VALUES (?, ?, ?)',
        [apiKey, guildId, user.id]
      );
  
      await interaction.reply({
        content: `✅ API key generated: \`${apiKey}\``,
        ephemeral: true
      });
    }
  
    // Handle /list-api
    else if (commandName === 'list-api') {
      const [rows] = await db.pool.query(
        'SELECT API_KEY, USER_ID FROM ApiKeys WHERE GUILD_ID = ?',
        [guildId]
      );
  
      if (!rows.length) {
        return await interaction.reply({
          content: 'ℹ️ No API keys found for this server.',
          ephemeral: true
        });
      }
  
      const keyList = rows.map(row => `• \`${row.API_KEY}\` → <@${row.USER_ID}>`).join('\n');
      await interaction.reply({
        content: `🔑 API keys for this guild:\n${keyList}`,
        ephemeral: true
      });
    }
  
    // Handle /delete-api
    else if (commandName === 'delete-api') {
      const apiKey = options.getString('key');
  
      const [rows] = await db.pool.query(
        'DELETE FROM ApiKeys WHERE API_KEY = ? AND GUILD_ID = ?',
        [apiKey, guildId]
      );
  
      await interaction.reply({
        content: '🗑️ API key deleted (if it existed).',
        ephemeral: true
      });
    }
  });
  
  client.login(process.env.DISCORD_TOKEN);

  // 4️⃣ Expose Express API
  const app = express();
  app.use(express.json());

  app.post('/process-message', async (req, res) => {
    const { message, apiKey: authKey } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }
    if (!authKey) {
      return res.status(400).json({ error: 'Missing API key' });
    }

    logInfo(`[/process-message] authKey=${authKey} message="${message}"`);

    try {
      const { reply, tokensUsed, error } = await processMessage({ message, authKey });
      if (error) return res.status(400).json({ error });
      return res.json({ reply, tokensUsed });
    } catch (err) {
      logError('Unhandled error in /process-message:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  const PORT = process.env.API_PORT || 3000;
  app.listen(PORT, () => logInfo(`API server listening on http://localhost:${PORT}`));
})();

// ——— Shared Discord Function ———
async function isGuildOwner(guildId, userId) {
  const [rows] = await db.pool.query(
    'SELECT GUILD_OWNER_ID FROM Guilds WHERE GUILD_ID = ?',
    [guildId]
  );
  if (!rows.length) return false;
  return rows[0].GUILD_OWNER_ID === userId;
}

// ——— Shared Processing Function ———
async function processMessage({
  message,
  authKey,
  isDiscord = false,  // if true, we return { reply, tokensUsed } else { reply, tokensUsed, error }
  guildId: overrideGuildId = null,
  userId:  overrideUserId  = null,
}) {
  // 1️⃣ Authenticate
  let guildId = overrideGuildId;
  if (!guildId) {
    const [apiKeyRows] = await db.pool.query('SELECT GUILD_ID FROM ApiKeys WHERE API_KEY = ?', [authKey]);
    if (!apiKeyRows.length) return { error: 'Invalid API key' };
    guildId = apiKeyRows[0].GUILD_ID;
  }
  const userId = overrideUserId || authKey;

  // 2️⃣ Load guild settings
  const [guildRows] = await db.pool.query(
    'SELECT CHAT_MODELS, CHAT_TOKENS, DEBUG, CHAT_PERSONA FROM Guilds WHERE GUILD_ID = ?',
    [guildId]
  );
  if (!guildRows.length) return { error: 'Guild not registered' };
  let { CHAT_MODELS, CHAT_TOKENS, DEBUG, CHAT_PERSONA } = guildRows[0];
  let currentTokens       = Number(CHAT_TOKENS) || 0;
  if (currentTokens < MIN_TOKEN_THRESH) return { error: 'Insufficient tokens' };

  let modelIdToUse        = CHAT_MODELS || defaultModelId;
  let personaToUse        = CHAT_PERSONA || defaultPersona;
  let debugMode           = DEBUG === 1;
  let finalReply          = null;

  // 3️⃣ Load model params
  let tokenInputFactor    = 0.6;
  let tokenOutputFactor   = 0.9;
  let tokenCachedInFactor = 0.6;
  let tokenCachedOutFactor= 0.9;
  let modelApiKey         = process.env.OPENAI_API_KEY;
  let modelBaseUrl        = defaultApiUrl;

  const [modelRows] = await db.pool.query(
    `SELECT TOKEN_INPUT, TOKEN_OUTPUT, TOKEN_CACHED_INPUT, TOKEN_CACHED_OUTPUT, API_KEY, API_URL
     FROM Models WHERE MODEL_ID = ?`, [modelIdToUse]
  );
  if (modelRows.length) {
    const m = modelRows[0];
    tokenInputFactor     = m.TOKEN_INPUT        ?? tokenInputFactor;
    tokenOutputFactor    = m.TOKEN_OUTPUT       ?? tokenOutputFactor;
    tokenCachedInFactor  = m.TOKEN_CACHED_INPUT ?? tokenCachedInFactor;
    tokenCachedOutFactor = m.TOKEN_CACHED_OUTPUT?? tokenCachedOutFactor;
    modelApiKey          = m.API_KEY            || modelApiKey;
    modelBaseUrl         = m.API_URL            || modelBaseUrl;
  }

  // 4️⃣ Cache lookup
  const cached = await cache.getCachedResult(message);
  if (cached) {
    const inT = Math.ceil(message.length * tokenCachedInFactor);
    const outT = Math.ceil(cached.length * tokenCachedOutFactor);
    await db.pool.query(
      'INSERT INTO ChatLogs (GUILD_ID, GUILD_USERS_ID, MESSAGE_INPUT, MESSAGE_OUTPUT, CACHED) VALUES (?, ?, ?, ?, 1)',
      [guildId, userId, message, 'CACHED']
    );
    await db.pool.query(
      'UPDATE Guilds SET CHAT_TOKENS = CHAT_TOKENS - ? WHERE GUILD_ID = ?',
      [inT + outT, guildId]
    );
    finalReply = cached;
    if (debugMode) {
      finalReply += `
------------------------------
**[DEBUG INFO]**
• Mode: CACHED
• Model ID: ${modelIdToUse}
• Input Tokens: ${inT}
• Output Tokens: ${outT}
• Total Tokens Used: ${inT + outT}`;
    }
    return { reply: finalReply, tokensUsed: inT + outT };
  }

  // 5️⃣ API call
  const apiRes = await axios.post(
    modelBaseUrl,
    {
      model: modelIdToUse,
      messages: [
        { role: 'system',  content: personaToUse },
        { role: 'user',    content: message }
      ],
      stream: false
    },
    {
      headers: {
        Authorization: `Bearer ${modelApiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const reply = apiRes.data.choices[0].message.content.trim();
  const inT   = Math.ceil(message.length * tokenInputFactor);
  const outT  = Math.ceil(reply.length * tokenOutputFactor);
  const tokensUsed = inT + outT;
  finalReply = reply;
  if (debugMode) {
    finalReply += `
------------------------------
**[DEBUG INFO]**
• Mode: REQUEST
• Model ID: ${modelIdToUse}
• Input Tokens: ${inT}
• Output Tokens: ${outT}
• Total Tokens Used: ${inT + outT}`;
  }

  // cache & log
  await cache.setCache(message, reply);
  await db.pool.query(
    'INSERT INTO ChatLogs (GUILD_ID, GUILD_USERS_ID, MESSAGE_INPUT, MESSAGE_OUTPUT, CACHED) VALUES (?, ?, ?, ?, 0)',
    [guildId, userId, message, 'COMING SOON']
  );
  await db.pool.query(
    'UPDATE Guilds SET CHAT_TOKENS = CHAT_TOKENS - ? WHERE GUILD_ID = ?',
    [tokensUsed, guildId]
  );

  return { reply: finalReply, tokensUsed };
}
