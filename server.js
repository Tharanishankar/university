require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const express = require('express');
const cors = require('cors');

const analyzeRouter = require('./routes/analyze');
const universitiesRouter = require('./routes/universities');
const sessionRouter = require('./routes/session');
const ratesRouter = require('./routes/rates');
const dashboardRouter = require('./routes/dashboard');
const { updateFxRates } = require('./services/budgetScoring');

const app = express();

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL, // set this in Railway to your Vercel URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // curl / Postman / mobile
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (origin.endsWith('.vercel.app')) return callback(null, true); // Vercel preview deployments
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/analyze', analyzeRouter);
app.use('/api/universities', universitiesRouter);
app.use('/api/session', sessionRouter);
app.use('/api/rates', ratesRouter);
app.use('/api/dashboard', dashboardRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Dream Vantage backend running on port ${PORT}`);
  console.log('--- ENV CHECK ---');
  const required = {
    SUPABASE_URL:         process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY,
    PERPLEXITY_API_KEY:   process.env.PERPLEXITY_API_KEY,
    GEMINI_API_KEY:       process.env.GEMINI_API_KEY,
    OPEN_EXCHANGE_APP_ID: process.env.OPEN_EXCHANGE_APP_ID,
  };
  const optional = {
    CONTAINER_Q:          process.env.CONTAINER_Q,
    CONTAINER_M_ENABLED:  process.env.CONTAINER_M_ENABLED,
    FRONTEND_URL:         process.env.FRONTEND_URL,
  };
  Object.entries(required).forEach(([k, v]) =>
    console.log(`  ${v ? '✓' : '✗ MISSING'} ${k}`)
  );
  Object.entries(optional).forEach(([k, v]) =>
    console.log(`  ${v ? '✓' : '○ not set'} ${k} (optional)`)
  );
  console.log('-----------------');
  // Warm FX rates in background — non-blocking
  updateFxRates().catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error('Stack:', err.stack);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err.message);
  console.error('Stack:', err.stack);
});
