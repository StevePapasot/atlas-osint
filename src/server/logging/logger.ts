import 'server-only';
import { redactObject } from '../security/redact';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.ATLAS_LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'warn' : 'info')) as Level;
  return ORDER[lvl] ?? ORDER.info;
}

export interface LogFields {
  investigationId?: string;
  jobId?: string;
  taskId?: string;
  provider?: string;
  operation?: string;
  status?: string;
  durationMs?: number;
  resultCount?: number;
  errorCategory?: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  if (ORDER[level] < threshold()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redactObject(fields) as Record<string, unknown>) : {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
  child(base: LogFields) {
    return {
      debug: (msg: string, f?: LogFields) => emit('debug', msg, { ...base, ...f }),
      info: (msg: string, f?: LogFields) => emit('info', msg, { ...base, ...f }),
      warn: (msg: string, f?: LogFields) => emit('warn', msg, { ...base, ...f }),
      error: (msg: string, f?: LogFields) => emit('error', msg, { ...base, ...f }),
    };
  },
};
