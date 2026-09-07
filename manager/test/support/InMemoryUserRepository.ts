import type {
  UserDeletion,
  UserRepository,
  UserRow,
} from '../../src/domain/auth/UserRepository.js';

/**
 * The users table without Postgres, for the tests.
 *
 * Rows go in and come out as copies, so a test holding one cannot change what
 * the repository stores.
 */
export class InMemoryUserRepository implements UserRepository {
  private rows: UserRow[] = [];
  private nextId = 1;
  private lookups = 0;

  async count(): Promise<number> {
    return this.rows.length;
  }

  async list(): Promise<UserRow[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async findById(id: number): Promise<UserRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? { ...row } : null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    this.lookups += 1;
    const row = this.rows.find((candidate) => candidate.username === username);
    return row ? { ...row } : null;
  }

  async insert(
    username: string,
    passwordHash: string,
    isAdmin: boolean,
  ): Promise<UserRow | null> {
    if (this.rows.some((row) => row.username === username)) return null;

    const row: UserRow = {
      id: this.nextId++,
      username,
      password_hash: passwordHash,
      created_at: new Date(),
      last_login_at: null,
      is_admin: isAdmin,
    };
    this.rows = [...this.rows, row];
    return { ...row };
  }

  /** Half of a password change, which InMemoryCredentialRepository pairs up. */
  setPasswordHash(id: number, passwordHash: string): void {
    this.rows = this.rows.map((row) =>
      row.id === id ? { ...row, password_hash: passwordHash } : row,
    );
  }

  async markSignedIn(id: number, at: Date): Promise<void> {
    this.rows = this.rows.map((row) =>
      row.id === id ? { ...row, last_login_at: at } : row,
    );
  }

  async deleteUnlessLast(id: number): Promise<UserDeletion> {
    const target = this.rows.find((row) => row.id === id);
    if (!target) return 'missing';
    if (this.rows.length <= 1) return 'last';
    if (target.is_admin && this.rows.filter((row) => row.is_admin).length <= 1) {
      return 'last_admin';
    }

    this.rows = this.rows.filter((row) => row.id !== id);
    return 'deleted';
  }

  /**
   * Test-only view. Signing in looks the username up and then hashes the
   * password with no branch in between, so this counts the attempts that got
   * as far as paying for a scrypt.
   */
  usernameLookups(): number {
    return this.lookups;
  }
}
