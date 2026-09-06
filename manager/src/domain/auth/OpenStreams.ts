/** Ends one open stream. How that is done is the route's business. */
export type CloseStream = () => void;

interface OpenStream {
  tokenHash: string;
  userId: number;
  close: CloseStream;
}

/**
 * The event streams that are open right now, and the session behind each one.
 *
 * A stream is checked for a session once, when it opens, and then lives as
 * long as its socket. Nothing on the request path runs again to notice that
 * the session has been revoked, so whatever revokes one ends its streams
 * through here.
 */
export class OpenStreams {
  private streams = new Set<OpenStream>();

  /** Returns the call that takes the stream out again once it has ended. */
  open(tokenHash: string, userId: number, close: CloseStream): () => void {
    const stream: OpenStream = { tokenHash, userId, close };
    this.streams.add(stream);

    return () => {
      this.streams.delete(stream);
    };
  }

  closeSession(tokenHash: string): number {
    return this.closeWhere((stream) => stream.tokenHash === tokenHash);
  }

  /** Every stream of a user's, apart from the one session named to keep. */
  closeUser(userId: number, keepTokenHash?: string): number {
    return this.closeWhere(
      (stream) =>
        stream.userId === userId && stream.tokenHash !== keepTokenHash,
    );
  }

  closeAll(): number {
    return this.closeWhere(() => true);
  }

  /** One entry per session holding a stream open, for the expiry check. */
  openTokenHashes(): string[] {
    return [...new Set([...this.streams].map((stream) => stream.tokenHash))];
  }

  private closeWhere(matches: (stream: OpenStream) => boolean): number {
    let closed = 0;
    for (const stream of [...this.streams]) {
      if (!matches(stream)) continue;

      this.streams.delete(stream);
      stream.close();
      closed += 1;
    }
    return closed;
  }
}
