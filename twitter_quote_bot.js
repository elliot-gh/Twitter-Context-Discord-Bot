const { MessagePayload } = require('discord.js');
const NodeCache = require('node-cache');
const { TwitterApi } = require('twitter-api-v2');

module.exports = function(discordClient) {
    const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
    const MAX_QUOTE_DEPTH = parseInt(process.env.MAX_QUOTE_DEPTH);
    const MAX_URLS_PER_MSG = parseInt(process.env.MAX_URLS_PER_MSG);
    const QUOTE_CACHE_TTL = parseInt(process.env.QUOTE_CACHE_TTL);
    const QUOTE_CACHE_MAX_KEYS = parseInt(process.env.QUOTE_CACHE_MAX_KEYS);
    const TWITTER_REGEX = /((https:\/\/twitter\.com)|(https:\/\/mobile\.twitter\.com)|(http:\/\/twitter\.com)|(http:\/\/mobile\.twitter\.com))(\/.+)(\/status\/)([0-9]+)/g;
    const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);
    const quoteIdCache = new NodeCache({
        stdTTL: QUOTE_CACHE_TTL,
        maxKeys: QUOTE_CACHE_MAX_KEYS
    });
    const authorCache = new NodeCache({
        stdTTL: QUOTE_CACHE_TTL,
        maxKeys: QUOTE_CACHE_MAX_KEYS
    });

    const getQuotedTweet = async function(id) {
        let quoteId = quoteIdCache.get(id);
        let authorId;
        if (quoteId === undefined) {
            const tweet = await twitterClient.v2.singleTweet(id, { expansions: ['referenced_tweets.id', 'author_id'] });
            if ('errors' in tweet) {
                throw `Error while calling singleTweet Twitter API: ${JSON.stringify(tweet)}`;
            }

            quoteId = null;
            if ('referenced_tweets' in tweet.data) {
                quoteId = tweet.includes.tweets[0].id;
                authorId = tweet.includes.tweets[0].author_id;
            } else {
                return null;
            }

            quoteIdCache.set(id, quoteId);
        }

        let quoteObj = null;
        let quoteAuthor;
        if (quoteId !== null) {
            quoteAuthor = authorCache.get(quoteId);
            if (quoteAuthor === undefined) {
                const user = await twitterClient.v2.user(authorId);
                if ('errors' in user) {
                    throw `Error while calling singleTweet Twitter API: ${JSON.stringify(user)}`;
                }

                quoteAuthor = user.data.username;
                authorCache.set(quoteId, quoteAuthor);
            }

            quoteObj = {
                quoteId: quoteId,
                quoteAuthor: quoteAuthor
            };
        }

        return quoteObj;
    };

    const handleMessage = async function(message, currentDepth) {
        if (MAX_QUOTE_DEPTH !== -1 && currentDepth >= MAX_QUOTE_DEPTH) {
            return;
        }

        let content = message.content;
        let twitterMatches = content.matchAll(TWITTER_REGEX);
        let currentUrlCount = 0;
        for (const match of twitterMatches) {
            if (MAX_URLS_PER_MSG !== -1 && currentUrlCount >= MAX_URLS_PER_MSG) {
                break;
            }

            let id = match[8];
            console.log(`Handling Tweet ID: ${id}`);
            getQuotedTweet(id)
                .then((quoteObj) => {
                    if (quoteObj === null) {
                        return null;
                    }

                    let quoteUrl = `https://twitter.com/${quoteObj.quoteAuthor}/status/${quoteObj.quoteId}`;
                    let payload = MessagePayload.create(
                        message,
                        {
                            content: `Found quoted Tweet: ${quoteUrl}`,
                            allowedMentions: {
                                repliedUser: false
                            },
                            reply: {
                                messageReference: message,
                                failIfNotExists: false
                            }
                        });
                    return message.reply(payload);
                })
                .then((msgReply) => {
                    if (msgReply !== null) {
                        handleMessage(msgReply, currentDepth + 1);
                    }
                })
                .catch((error) => {
                    console.error(`Error while getting quoted tweet details: ${error}`);
                });

            currentUrlCount++;
        }
    };

    discordClient.on('messageCreate', async (msg) => {
        // ignore self
        if (msg.author.id === discordClient.user.id) {
            return;
        }

        handleMessage(msg, 0);
    });
};