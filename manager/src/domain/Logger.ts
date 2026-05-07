/**
 * Same singleton-Logger pattern used in swarm-hls-stream/stream-uploader so
 * log output across the project is uniform.
 */
export class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ')}`;
  }

  log(...args: unknown[]): void {
    console.log(this.formatMessage('log', ...args));
  }

  info(...args: unknown[]): void {
    console.info(this.formatMessage('info', ...args));
  }

  warn(...args: unknown[]): void {
    console.warn(this.formatMessage('warn', ...args));
  }

  error(...args: unknown[]): void {
    console.error(this.formatMessage('error', ...args));
  }

  debug(...args: unknown[]): void {
    console.debug(this.formatMessage('debug', ...args));
  }
}
