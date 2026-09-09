/**
 * Same singleton-Logger pattern used in swarm-hls-stream/stream-uploader so
 * log output across the project is uniform.
 */
export class Logger {
  private static instance: Logger;
  private everythingToStandardError = false;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Sends every level to standard error from here on.
   *
   * A command of the manager's command line writes one machine-read line on
   * standard output and nothing else, because the deploy that runs it reads
   * exactly that line. Anything logged while the command works, a migration
   * saying which file it applied for instance, would otherwise land in the
   * middle of it.
   */
  public writeEverythingToStandardError(): void {
    this.everythingToStandardError = true;
  }

  private formatMessage(level: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${args
      .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
      .join(' ')}`;
  }

  private write(level: string, at: (message: string) => void, args: unknown[]): void {
    const message = this.formatMessage(level, ...args);
    if (this.everythingToStandardError) console.error(message);
    else at(message);
  }

  log(...args: unknown[]): void {
    this.write('log', (message) => console.log(message), args);
  }

  info(...args: unknown[]): void {
    this.write('info', (message) => console.info(message), args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', (message) => console.warn(message), args);
  }

  error(...args: unknown[]): void {
    this.write('error', (message) => console.error(message), args);
  }

  debug(...args: unknown[]): void {
    this.write('debug', (message) => console.debug(message), args);
  }
}
