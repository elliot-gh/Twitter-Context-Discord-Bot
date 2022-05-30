export type TwitterConfig = {
    twitterBearerToken: string
    defaultDepth: number,
    maxDepth: number,
    quoteCache: {
        ttl: number,
        maxKeys: number
    }
}
