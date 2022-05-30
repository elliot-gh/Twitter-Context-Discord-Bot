import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SlashCommandBuilder } from "@discordjs/builders";
import { CommandInteraction, Intents, MessageEmbed, MessagePayload } from "discord.js";
import LRUCache from "lru-cache";
import { TwitterApi } from "twitter-api-v2";
import { BotInterface } from "../../BotInterface";
import { readYamlConfig } from "../../ConfigUtils";
import { TwitterConfig } from "./TwitterConfig";

type ContextData = {
    quotes: ContextTweet[];
    replies: ContextTweet[];
}

type ContextTweet = {
    id: string,
    username: string
}

export class TwitterContextBot implements BotInterface {
    intents: number[];
    slashCommands: [SlashCommandBuilder];

    private static readonly TWITTER_REGEX = /((https:\/\/twitter\.com)|(https:\/\/mobile\.twitter\.com)|(http:\/\/twitter\.com)|(http:\/\/mobile\.twitter\.com))(\/.+)(\/status\/)([0-9]+)/g;
    private static readonly CMD_OPT_URL = "url";
    private static readonly CMD_OPT_DEPTH = "depth";
    private twitterClient!: TwitterApi;
    private idToContextCache!: LRUCache<string, ContextData>;
    private usernameCache!: LRUCache<string, string>;
    private slashContext: SlashCommandBuilder;
    private config!: TwitterConfig;

    constructor() {
        this.intents = [Intents.FLAGS.GUILDS];
        this.slashContext = new SlashCommandBuilder()
            .setName("twittercontext")
            .setDescription("Posts additional context for your Tweet URL (such as RTs, replies).")
            .addStringOption(option =>
                option
                    .setName(TwitterContextBot.CMD_OPT_URL)
                    .setDescription("The URL of the Tweet.")
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option
                    .setName(TwitterContextBot.CMD_OPT_DEPTH)
                    .setDescription("The max depth to post. Note that there might be a max to prevent spamming.")
                    .setRequired(false)
                    .setMinValue(1)
            ) as SlashCommandBuilder;
        this.slashCommands = [this.slashContext];
    }

    async processSlashCommand(interaction: CommandInteraction): Promise<void> {
        if (interaction.commandName !== this.slashContext.name) {
            return;
        }

        console.log(`[TwitterContextBot] got interaction: ${interaction}`);
        try {
            await interaction.deferReply();
            await this.handleMessage(interaction, 0);
        } catch (error) {
            console.error(`[TwitterContextBot] Uncaught exception in processSlashCommand(): ${error}`);
        }
    }

    async handleMessage(interaction: CommandInteraction, currentDepth: number) {
        if (currentDepth === this.config.maxDepth) {
            return;
        }

        const url = interaction.options.getString(TwitterContextBot.CMD_OPT_URL, true);
        const matches = url.match(TwitterContextBot.TWITTER_REGEX);
        if (matches === null) {
            await this.sendErrorMessage(interaction, "Did not get a Twitter URL.");
            return;
        }

        const id = matches[8];
        console.log(`Handling Tweet ID: ${id}`);
        const contextObj = await this.getContextTweets(id);
        const discordReplies = [];

        for (const quoteObj of contextObj.quotes) {
            const quoteUrl = `https://twitter.com/${quoteObj.username}/status/${quoteObj.id}`;
            const payload = MessagePayload.create(
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

        for (const replyObj of contextObj.replies) {
            const replyUrl = `https://twitter.com/${replyObj.username}/status/${replyObj.id}`;
            const payload = MessagePayload.create(
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
                for (const result of resultArray) {
                    if (result.status === 'fulfilled') {
                        this.handleMessage(result.value, currentDepth + 1);
                    } else {
                        console.error(`Error while processing: ${result.reason}`);
                    }
                }
            });

        currentUrlCount++;
    }

    async getContextTweets(id: string): Promise<ContextData> {
        const cacheObj = this.idToContextCache.get(id);
        if (cacheObj !== undefined) {
            return cacheObj;
        }

        const contextObj: ContextData = {
            quotes: [],
            replies: []
        };

        const tweet = await this.twitterClient.v2.singleTweet(id, { expansions: ["referenced_tweets.id", "author_id"] });
        if ("errors" in tweet) {
            throw `[TwitterContextBot] Error while calling singleTweet Twitter API: ${JSON.stringify(tweet)}`;
        }

        if (!("referenced_tweets" in tweet.data) || tweet.includes === undefined ||
            tweet.includes.tweets === undefined || tweet.data.referenced_tweets === undefined) {
            return contextObj;
        }

        const idToAuthorId: { [id: string]: string } = {};


        for (const inclTweet of tweet.includes.tweets) {
            if (inclTweet.author_id === undefined) {
                continue;
            }

            idToAuthorId[inclTweet.id] = inclTweet.author_id;
        }

        for (const refTweet of tweet.data.referenced_tweets) {
            const tweetId = refTweet.id;
            const authorId = idToAuthorId[tweetId];
            let username = this.usernameCache.get(authorId);
            if (username === undefined) {
                const user = await this.twitterClient.v2.user(authorId);
                if ("errors" in user) {
                    throw `[TwitterContextBot] Error while calling singleTweet Twitter API: ${JSON.stringify(user)}`;
                }
                username = user.data.username;
                this.usernameCache.set(authorId, username);
            }

            if (refTweet.type === "quoted") {
                contextObj.quotes.push({
                    id: tweetId,
                    username: username
                });
            } else if (refTweet.type === "replied_to") {
                contextObj.replies.push({
                    id: tweetId,
                    username: username
                });
            } else {
                throw `[TwitterContextBot] Unknown type ${refTweet.type}`;
            }
        }

        this.idToContextCache.set(id, contextObj);
        return contextObj;
    }

    async init(): Promise<string | null> {
        const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.yaml");
        try {
            this.config = await readYamlConfig<TwitterConfig>(configPath);
            this.usernameCache = new LRUCache({
                max: this.config.quoteCache.maxKeys,
                ttl: this.config.quoteCache.ttl * 1000
            });
            this.idToContextCache = new LRUCache<string, ContextData>({
                max: this.config.quoteCache.maxKeys,
                ttl: this.config.quoteCache.ttl * 1000
            });
            this.twitterClient = new TwitterApi(this.config.twitterBearerToken);
        } catch (error) {
            const errMsg = `[TwitterContextBot] Unable to read config: ${error}`;
            console.error(errMsg);
            return errMsg;
        }

        return null;
    }

    /**
     * Replies to the interaction with an error message. Tries to figure out what to print.
     * @param interaction The discord.js CommandInteraction
     * @param error The error. Could be typeof Error, string, or null.
     */
    async sendErrorMessage(interaction: CommandInteraction, error: unknown = null): Promise<void> {
        let description = "";
        if (error instanceof Error) {
            description = error.message;
        } else if (typeof error === "string") {
            description = error;
        }

        await interaction.reply({ embeds: [
            new MessageEmbed()
                .setTitle("Error")
                .setDescription(description)
                .setColor(0xFF0000)
        ]});
    }
}
