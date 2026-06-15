import dotenv from 'dotenv';
dotenv.config();

const SUPPORTED_COUNTRIES = ['Germany', 'United Kingdom', 'USA', 'India', 'Canada', 'Australia'];
const rawCountry = process.env.CRAWLER_COUNTRY || null;
const country = (rawCountry && SUPPORTED_COUNTRIES.includes(rawCountry))
  ? rawCountry
  : null;

export const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 2000,
  },
  perplexity: {
    apiKey: process.env.PERPLEXITY_API_KEY,
    model: 'sonar-pro',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
  },
  crawler: {
    country,
    delayMs: parseInt(process.env.CRAWLER_DELAY_MS) || 10000,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    validationStrict: process.env.VALIDATION_STRICT === 'true',
    testMode: process.argv.includes('--test'),
    testLimit: 3,
  },
};
