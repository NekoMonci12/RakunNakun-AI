// deployCommands.js

const { REST, Routes } = require('discord.js');
require('dotenv').config();

class CommandDeployer {
  /**
   * @param {Array} commands - Array of command definitions (JSON).
   * @param {string} clientId - Your Discord application client ID.
   * @param {string} token - Your Discord bot token.
   */
  constructor(commands, clientId, token) {
    this.commands = commands;
    this.clientId = clientId;
    this.token = token;
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  async deploy() {
    try {
      console.log('Started refreshing application (/) commands.');
      await this.rest.put(
        Routes.applicationCommands(this.clientId),
        { body: this.commands }
      );
      console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
      console.error('Error deploying commands:', error);
    }
  }
}

module.exports = CommandDeployer;
