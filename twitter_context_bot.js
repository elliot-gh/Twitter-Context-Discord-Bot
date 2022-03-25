const { MessagePayload } = require('discord.js');
const LRU = require('lru-cache');
const { TwitterApi } = require('twitter-api-v2');

module.exports = function(discordClient) {
    const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
    const MAX_QUOTE_DEPTH = parseInt(process.env.MAX_QUOTE_DEPTH);
    const MAX_URLS_PER_MSG = parseInt(process.env.MAX_URLS_PER_MSG);
    const QUOTE_CACHE_TTL = parseInt(process.env.QUOTE_CACHE_TTL);
    const QUOTE_CACHE_MAX_KEYS = parseInt(process.env.QUOTE_CACHE_MAX_KEYS);
    const TWITTER_REGEX = /((https:\/\/twitter\.com)|(https:\/\/mobile\.twitter\.com)|(http:\/\/twitter\.com)|(http:\/\/mobile\.twitter\.com))(\/.+)(\/status\/)([0-9]+)/g;
    const TWITTER_TYPE_QUOTE = 'quoted';
    const TWITTER_TYPE_REPLY = 'replied_to';
    const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);
    const idToContextCache = new LRU({
        max: QUOTE_CACHE_MAX_KEYS,
        ttl: QUOTE_CACHE_TTL * 1000,
    });
    const usernameCache = new LRU({
        max: QUOTE_CACHE_MAX_KEYS,
        ttl: QUOTE_CACHE_TTL * 1000,
    });

    const ContextTweet = class {
        constructor(id, username) {
            this.id = id;
            this.username = username;
        }
    };

    const getContextTweets = async function(id) {
        let cacheObj = idToContextCache.get(id);
        if (cacheObj !== undefined) {
            return cacheObj;
        }

        let contextObj = {
            quotes: [],
            replies: []
        };

        const tweet = await twitterClient.v2.singleTweet(id, { expansions: ['referenced_tweets.id', 'author_id'] });
        if ('errors' in tweet) {
            throw `Error while calling singleTweet Twitter API: ${JSON.stringify(tweet)}`;
        }

        if (!('referenced_tweets' in tweet.data)) {
            return contextObj;
        }

        let idToAuthorId = {};
        for (let inclTweet of tweet.includes.tweets) {
            idToAuthorId[inclTweet.id] = inclTweet.author_id;
        }

        for (let refTweet of tweet.data.referenced_tweets) {
            let tweetId = refTweet.id;
            let authorId = idToAuthorId[tweetId];
            let username = usernameCache.get(authorId);
            if (username === undefined) {
                const user = await twitterClient.v2.user(authorId);
                if ('errors' in user) {
                    throw `Error while calling singleTweet Twitter API: ${JSON.stringify(user)}`;
                }
                username = user.data.username;
                usernameCache.set(authorId, username);
            }

            if (refTweet.type === TWITTER_TYPE_QUOTE) {
                contextObj.quotes.push(new ContextTweet(tweetId, username));
            } else if (refTweet.type === TWITTER_TYPE_REPLY) {
                contextObj.replies.push(new ContextTweet(tweetId, username));
            } else {
                throw `Unknown type ${tweet.type}`;
            }
        }

        idToContextCache.set(id, contextObj);
        return contextObj;
    };

    const handleMessage = async function(message, currentDepth) {
        if (currentDepth === MAX_QUOTE_DEPTH) {
            return;
        }

        let content = message.content;
        let twitterMatches = content.matchAll(TWITTER_REGEX);
        let currentUrlCount = 0;
        for (const match of twitterMatches) {
            if (currentUrlCount === MAX_URLS_PER_MSG) {
                break;
            }

            let id = match[8];
            console.log(`Handling Tweet ID: ${id}`);
            let contextObj = await getContextTweets(id);

            let discordReplies = [];

            for (let quoteObj of contextObj.quotes) {
                let quoteUrl = `https://twitter.com/${quoteObj.username}/status/${quoteObj.id}`;
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

                discordReplies.push(message.reply(payload));
            }

            for (let replyObj of contextObj.replies) {
                let replyUrl = `https://twitter.com/${replyObj.username}/status/${replyObj.id}`;
                let payload = MessagePayload.create(
                    message,
                    {
                        content: `Found Tweet reply: ${replyUrl}`,
                        allowedMentions: {
                            repliedUser: false
                        },
                        reply: {
                            messageReference: message,
                            failIfNotExists: false
                        }
                });

                discordReplies.push(message.reply(payload));
            }

            Promise.allSettled(discordReplies)
                .then((resultArray) => {
                    for (let result of resultArray) {
                        if (result.status === 'fulfilled') {
                            handleMessage(result.value, currentDepth + 1);
                        } else {
                            console.error(`Error while processing: ${result.reason}`);
                        }
                    }
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