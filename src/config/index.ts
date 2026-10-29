import dotenv from 'dotenv'
dotenv.config()

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // PostgreSQL connection
  database: {
    url: process.env.DATABASE_URL ?? '',
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  },

  // API Keys (stored securely, used to validate pharmacy registration)
  apiKeys: {
    // In production, these would be stored in a secure vault
    masterKey: process.env.MASTER_API_KEY ?? 'pharmacy-master-key-change-me',
  },

  // Rate limiting
  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW ?? '60000', 10), // 1 minute
  },

  // CORS
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
}