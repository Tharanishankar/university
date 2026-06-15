export function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...data };
  console.log(JSON.stringify(entry));
}

export const logger = {
  info: (msg, data) => log('INFO', msg, data),
  warn: (msg, data) => log('WARN', msg, data),
  error: (msg, data) => log('ERROR', msg, data),
  success: (msg, data) => log('SUCCESS', msg, data),
  debug: (msg, data) => {
    if (process.env.LOG_LEVEL === 'debug') {
      log('DEBUG', msg, data);
    }
  },
};
