// ============================================================================
// Logger - Structured logging with levels and formatting
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  timestamps?: boolean;
  colors?: boolean;
  output?: (entry: LogEntry) => void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private timestamps: boolean;
  private colors: boolean;
  private output: (entry: LogEntry) => void;
  private entries: LogEntry[] = [];

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.prefix = options.prefix ?? '';
    this.timestamps = options.timestamps ?? true;
    this.colors = options.colors ?? true;
    this.output = options.output ?? this.defaultOutput.bind(this);
  }

  /**
   * Create a child logger with a specific category
   */
  child(category: string): Logger {
    const child = new Logger({
      level: this.level,
      prefix: this.prefix ? `${this.prefix}:${category}` : category,
      timestamps: this.timestamps,
      colors: this.colors,
      output: this.output,
    });
    return child;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Check if a level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /**
   * Log methods
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Core log method
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category: this.prefix,
      message,
      data,
    };

    this.entries.push(entry);
    this.output(entry);
  }

  /**
   * Default console output
   */
  private defaultOutput(entry: LogEntry): void {
    const parts: string[] = [];

    // Timestamp
    if (this.timestamps) {
      const time = entry.timestamp.split('T')[1].replace('Z', '');
      parts.push(this.colors ? `${COLORS.dim}${time}${COLORS.reset}` : time);
    }

    // Level
    const levelColors: Record<LogLevel, string> = {
      debug: COLORS.gray,
      info: COLORS.blue,
      warn: COLORS.yellow,
      error: COLORS.red,
      silent: '',
    };
    const levelStr = entry.level.toUpperCase().padEnd(5);
    parts.push(this.colors ? `${levelColors[entry.level]}${levelStr}${COLORS.reset}` : levelStr);

    // Category
    if (entry.category) {
      parts.push(this.colors ? `${COLORS.cyan}[${entry.category}]${COLORS.reset}` : `[${entry.category}]`);
    }

    // Message
    parts.push(entry.message);

    // Data
    if (entry.data && Object.keys(entry.data).length > 0) {
      const dataStr = JSON.stringify(entry.data);
      parts.push(this.colors ? `${COLORS.dim}${dataStr}${COLORS.reset}` : dataStr);
    }

    console.log(parts.join(' '));
  }

  /**
   * Get all log entries
   */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Clear log entries
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Export logs as JSON
   */
  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

/**
 * Create a logger for a specific category
 */
export function createLogger(category: string, options?: LoggerOptions): Logger {
  return new Logger({ ...options, prefix: category });
}
