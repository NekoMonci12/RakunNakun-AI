// index.js

require('dotenv').config();
const settings = require('./settings.json');
const emojis = require('./emoji.json');
const express = require('express');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Database           = require('./database');
const CommandDeployer    = require('./deploy-commands');
const HybridCacheManager = require('./hybridCacheManager');
const MessageSplitter    = require('./messageSplitter');
const { MessageFlags } = require('discord-api-types/v10');
const MongoCacheManager = require('./mongoCacheManager');

// ——— MongoDB Instances ———
const cacheManager = new MongoCacheManager(
  process.env.MONGO_URL,
  process.env.MONGO_DB_NAME
);

// ——— Logging Helpers ———
const logInfo  = (msg, ...args) => console.log(`[INFO]  ${msg}`, ...args);
const logDebug = (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args);
const logError = (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args);

// ——— Globals / Defaults ———
const defaultModelId   = process.env.OPENAI_DEFAULT_MODEL;
const defaultPersona   = 'You are a helpful assistant.';
const defaultApiUrl    = process.env.OPENAI_BASE_URL;
const MIN_TOKEN_THRESH = 1000;
const freeTokens       = 50000;

// ——— Discord Variable ———
const discord_clientid = process.env.CLIENT_ID
const discord_invite   = `https://discord.com/oauth2/authorize?client_id=${discord_clientid}`;

// ——— Init Shared Resources ———
const db           = new Database();
const cache        = new HybridCacheManager(
  process.env.MONGO_URL, 
  process.env.MONGO_DB_NAME
);
const splitter     = new MessageSplitter(2000);

(async () => {
  // 1️⃣ Database tables
  await db.init();
  logInfo('Database initialized.');

  // 2️⃣ Deploy Discord Slash Commands
  const commands = [
    new SlashCommandBuilder()
      .setName('chat')
      .setDescription(`Chat with the ${settings.instanceName}`)
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
      .addStringOption(o => o.setName('key').setDescription('API key to delete').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('invite')
      .setDescription(`Invite ${settings.instanceName} Into Your Server!`),

    new SlashCommandBuilder()
      .setName('debugmode')
      .setDescription('Toggle Debug Mode!'),
    
    new SlashCommandBuilder()
      .setName('setpersona')
      .setDescription('Change the persona for your server.')
      .addStringOption(option =>
        option.setName('persona')
          .setDescription('The new persona text')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('answer')
      .setDescription('Reply to a specific message by ID or reply to the last message.')
      .addStringOption(option =>
        option.setName('message_id')
          .setDescription('ID of the message to reply')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('info')
      .setDescription('Show bot info'),
  ].map(c => c.toJSON());
  
  await new CommandDeployer(commands, process.env.CLIENT_ID, process.env.DISCORD_TOKEN).deploy();
  logInfo('Slash commands deployed.');

  // 3️⃣ Start Discord Bot
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', () => logInfo(`Logged in as ${client.user.tag}`));
  
  client.on('guildCreate', async (guild) => {
    try {
      const guildId      = guild.id;
      const guildOwnerId = guild.ownerId;
      const usersRoleId  = null;               // or '' if you prefer
      const chatTokens   = freeTokens;                  // initial token balance
      const chatPersona  = defaultPersona;     // your defaultPersona variable
      const chatModels   = defaultModelId;     // your defaultModelId variable
      const status       = 1;                  // active
      const debug        = 0;                  // off by default

      const sql = `
        INSERT IGNORE INTO Guilds 
          (GUILD_ID, GUILD_OWNER_ID, GUILD_USERS_ID, CHAT_TOKENS, CHAT_PERSONA, CHAT_MODELS, STATUS, DEBUG)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY 
        UPDATE 
          GUILD_OWNER_ID = VALUES(GUILD_OWNER_ID),
          GUILD_USERS_ID  = VALUES(GUILD_USERS_ID),
          CHAT_PERSONA   = VALUES(CHAT_PERSONA),
          CHAT_MODELS     = VALUES(CHAT_MODELS),
          STATUS          = VALUES(STATUS),
          DEBUG           = VALUES(DEBUG)
      `;

      await db.pool.query(sql, [
        guildId,
        guildOwnerId,
        usersRoleId,
        chatTokens,
        chatPersona,
        chatModels,
        status,
        debug
      ]);

      logInfo(`Guild ${guildId} registered in database.`);
    } catch (err) {
      logError('Error registering new guild in database:', err);
    }
  });
  client.on('interactionCreate', async interaction => {
    const actualOwnerId = interaction.guild.ownerId;
    if (!interaction.isChatInputCommand()) return;
  
    const { commandName, guildId, user, options } = interaction;
  
    // Only run permission check for certain commands
    const commandsRequiringOwnership = ['generate-api', 'list-api', 'delete-api', 'setpersona', 'debugmode'];
    if (commandsRequiringOwnership.includes(commandName)) {
      const [guildRows] = await db.pool.query(
        'SELECT GUILD_OWNER_ID FROM Guilds WHERE GUILD_ID = ?',
        [guildId]
      );
      
      const dbOwnerId     = guildRows.length ? guildRows[0].GUILD_OWNER_ID : null;

      if (!guildRows.length || (dbOwnerId !== interaction.user.id && actualOwnerId !== interaction.user.id)) {
        return await interaction.reply({
          content: '❌ You do not have permission to use this command. Only the guild owner can use this command.',
          flags: MessageFlags.Ephemeral
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
        flags: MessageFlags.Ephemeral
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
          flags: MessageFlags.Ephemeral
        });
      }
  
      const keyList = rows.map(row => `• \`${row.API_KEY}\` → <@${row.USER_ID}>`).join('\n');
      await interaction.reply({
        content: `🔑 API keys for this guild:\n${keyList}`,
        flags: MessageFlags.Ephemeral
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
        flags: MessageFlags.Ephemeral
      });
    }
  
    // Handle /invite
    else if (commandName === 'invite') {
      await interaction.reply({
        content: `🔗 [Click here](${discord_invite}) to invite me to your server!`,
        flags: MessageFlags.Ephemeral
      });
    }

    // Handle /setpersona
    else if (commandName === 'setpersona') {
      const persona = options.getString('persona');
    
      try {
        // Defer reply (to avoid timeout)
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
    
        // Update the persona in database
        await db.pool.query(
          'UPDATE Guilds SET CHAT_PERSONA = ? WHERE GUILD_ID = ?',
          [persona, guildId]
        );
    
        logInfo(`Updated persona for guild ${guildId} to: ${persona}`);
    
        await interaction.editReply({
          content: `✅ Persona updated successfully to:\n\`\`\`\n${persona}\n\`\`\``,
        });
      } catch (err) {
        logError('Error while setting persona:', err);
        await interaction.editReply({
          content: `❌ Failed to update persona. Please try again later.`,
        });
      }
    }

    else if (commandName === 'debugmode') {
    // Check if user has permission (optional, similar to other commands)
    const [guildRows] = await db.pool.query(
      'SELECT GUILD_OWNER_ID FROM Guilds WHERE GUILD_ID = ?',
      [guildId]
    );

    // Toggle DEBUG value
    const [rows] = await db.pool.query(
      'SELECT DEBUG FROM Guilds WHERE GUILD_ID = ?',
      [guildId]
    );
    const currentDebug = rows.length ? rows[0].DEBUG : 0;
    const newDebug = currentDebug === 1 ? 0 : 1;

    await db.pool.query(
      'UPDATE Guilds SET DEBUG = ? WHERE GUILD_ID = ?',
      [newDebug, guildId]
    );

    await interaction.reply({
      content: `✅ Debug mode is now ${newDebug === 1 ? 'enabled' : 'disabled'}.`,
      flags: MessageFlags.Ephemeral
    });
  }

  else if (commandName === 'answer') {
    try {
      const messageId = options.getString('message_id');
      let targetMessage;

      if (messageId) {
        targetMessage = await interaction.channel.messages.fetch(messageId);
      } else {
        const messages = await interaction.channel.messages.fetch({ limit: 1 });
        targetMessage = messages.last();
      }

      if (!targetMessage || targetMessage.author.bot) {
        await interaction.reply({ content: 'No valid message to reply to.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (targetMessage.reference && targetMessage.reference.messageId) {

        const repliedToMessage = await interaction.channel.messages.fetch(targetMessage.reference.messageId);
        if (repliedToMessage && repliedToMessage.author.id !== interaction.user.id) {
          const messageContent = repliedToMessage.content;
          logInfo(`[/answer] replying to message: ${messageContent}`);

          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
          }

          const { reply } = await processMessage({
            message: messageContent,
            authKey: interaction.user.id,
            isDiscord: true,
            guildId: interaction.guildId,
            userId: interaction.user.id
          });

          if (reply) {
            await interaction.editReply(reply);
          } else {
            await interaction.editReply('❌ Failed to generate a reply.');
          }
          return;
        }
      }

      const messageContent = targetMessage.content;
      logInfo(`[/answer] replying to message: ${messageContent}`);

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }

      const { reply } = await processMessage({
        message: messageContent,
        authKey: interaction.user.id,
        isDiscord: true,
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

      if (reply) {
        await interaction.editReply(reply);
      } else {
        await interaction.editReply('❌ Failed to generate a reply.');
      }
    } catch (err) {
      logError('Error in /answer:', err);
      await interaction.reply({ content: 'Error processing answer.', flags: MessageFlags.Ephemeral });
    }
  }

  else if (commandName === 'info') {
    const usedMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const ping   = client.ws.ping;
    const guildCount = client.guilds.cache.size;
    const cacheCount = await cacheManager.getMongoCacheCount();
    const cpuUsage = process.cpuUsage();
    const cpuPercent = ((cpuUsage.user + cpuUsage.system) / (1000 * 1000 * 1000) * 100).toFixed(2); // approximate
    const uptimeSeconds = Math.floor(process.uptime());


    const embed  = {
      title: 'Bot Info',
      color: 0x00ff00,
      image: {
        url: settings.coverImage
      },
      fields: [
        {
          name: `${emojis.ping} Latency`,
          value: `${ping} ms`,
          inline: true
        },
        {
          name: `${emojis.cpu} CPU Usage`,
          value: `${cpuPercent}%`,
          inline: true
        },
        {
          name: `${emojis.ram} Memory Usage`,
          value: `${usedMB} MB`,
          inline: true
        },
        {
          name: `${emojis.gear} Joined Servers`,
          value: `${guildCount}`,
          inline: true
        },
        {
          name: `${emojis.cache} Cache Entries`,
          value: `${formatNumber(cacheCount)} Prompts`,
          inline: true
        },
        {
          name: `${emojis.calendar} Uptime`,
          value: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
          inline: true
        }
      ]
    };

    const buttonsRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel('GitHub Repo')
          .setStyle(ButtonStyle.Link)
          .setURL('https://github.com/NekoMonci12/RakunNakun-AI')
          .setEmoji(emojis.github),
        new ButtonBuilder()
          .setLabel('Discord Server')
          .setStyle(ButtonStyle.Link)
          .setURL('https://dsc.gg/yuemi')
          .setEmoji(emojis.logo)
      );
    
    await interaction.reply({
      embeds: [embed],
      components: [buttonsRow],
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
  if (currentTokens < MIN_TOKEN_THRESH) return { reply: 'Insufficient tokens' };

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
    const used = inT + outT;
    const remaining = Math.max(0, currentTokens - used);
    await db.pool.query(
      'INSERT INTO ChatLogs (GUILD_ID, GUILD_USERS_ID, MESSAGE_INPUT, MESSAGE_OUTPUT, CACHED) VALUES (?, ?, ?, ?, 1)',
      [guildId, userId, message, 'CACHED']
    );
    await db.pool.query(
      'UPDATE Guilds SET CHAT_TOKENS = ? WHERE GUILD_ID = ?',
      [remaining, guildId]
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
  const remaining = Math.max(0, currentTokens - tokensUsed);
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
    'UPDATE Guilds SET CHAT_TOKENS = ? WHERE GUILD_ID = ?',
    [remaining, guildId]
  );

  return { reply: finalReply, tokensUsed };
}

function formatNumber(num) {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1) + 'b';
  } else if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + 'm';
  } else if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'k';
  } else {
    return num.toString();
  }
}