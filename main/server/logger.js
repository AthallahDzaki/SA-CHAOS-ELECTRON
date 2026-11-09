import { GeneralConfig } from './shared.js';
import fs from 'fs';
import path from 'path';

const MAX_LOGS = 500;
export const logHistory = [];
let logFileInitialized = false;

function captureLog(type, args) {
  if (!GeneralConfig?.General?.VerboseLog) return;
  
  const timestamp = new Date().toISOString();
  const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  
  logHistory.push({ timestamp, type, message });
  
  if (logHistory.length > MAX_LOGS) {
    logHistory.shift();
  }

  if (GeneralConfig?.General?.LogToFile) {
    try {
      const logPath = path.join(process.cwd(), 'data', 'latest.log');
      if (!logFileInitialized) {
        if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        logFileInitialized = true;
      }
      fs.appendFileSync(logPath, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`);
    } catch (e) {
      // Ignore
    }
  }
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalInfo = console.info;

console.log = function (...args) {
  captureLog('log', args);
  originalLog.apply(console, args);
};

console.warn = function (...args) {
  captureLog('warn', args);
  originalWarn.apply(console, args);
};

console.error = function (...args) {
  captureLog('error', args);
  originalError.apply(console, args);
};

console.info = function (...args) {
  captureLog('info', args);
  originalInfo.apply(console, args);
};
