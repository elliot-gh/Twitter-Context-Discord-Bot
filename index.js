/*
 * File name: index.js
 * Description: Main file for this bot.
 */

require('dotenv').config();
const { Client, Intents } = require('discord.js');
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS |
    Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS |
    Intents.FLAGS.GUILD_MESSAGES
  ]
});
const util = require('util');

const botPaths = [
  './twitter_quote_bot.js'
];

const bots = [];

// console strings
const CON_LOGGED_IN = '\n----------\n' +
                      'Logged in as:\n' +
                      '%s#%s\n' + // username, discriminator
                      '%s\n' + // id
                      '----------\n';

// error strings
const ERR_DISCORD_TOKEN_NOT_SET = 'DISCORD_TOKEN was not set!';

const errorHandler = (err) => {
  console.error(`Uncaught exception or promise: ${err}`);
};

process.on('uncaughtException', errorHandler);
process.on('unhandledRejection', errorHandler);

// login with token from .env
if (process.env.DISCORD_TOKEN === undefined || process.env.DISCORD_TOKEN === '') {
  throw new Error(ERR_DISCORD_TOKEN_NOT_SET);
}

client.login(process.env.DISCORD_TOKEN);

// log the logged in account
client.on('ready', () => {
  console.log(util.format(CON_LOGGED_IN, client.user.username, client.user.discriminator, client.user.id));

  for (let path of botPaths) {
    let bot = require(path)(client);
    bots.push(bot);
  }
});
