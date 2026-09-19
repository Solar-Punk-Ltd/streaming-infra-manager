import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService, type SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { CredentialRepository } from '../../src/domain/auth/CredentialRepository.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import { verifyPassword } from '../../src/domain/auth/passwordHash.js';
import { InMemoryCredentialRepository } from '../support/InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from '../support/InMemorySessionRepository.js';
import { InMemoryUserRepository } from '../support/InMemoryUserRepository.js';

const OLD_PASSWORD = 'a-long-current-password';
const FIRST_PASSWORD = 'a-long-winning-password';
const SECOND_PASSWORD = 'a-long-losing-password';

function signal() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

function session(user: { id: number; username: string; isAdmin: boolean }): SessionInfo {
  return {
    user,
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

class OrderedCredentialRepository implements CredentialRepository {
  readonly entered = [signal(), signal()];
  readonly release = [signal(), signal()];
  private calls = 0;

  constructor(private readonly inner: CredentialRepository) {}

  admitSession(...args: Parameters<CredentialRepository['admitSession']>): Promise<boolean> {
    return this.inner.admitSession(...args);
  }

  async changePassword(...args: Parameters<CredentialRepository['changePassword']>): Promise<boolean> {
    const call = this.calls++;
    this.entered[call]!.resolve();
    await this.release[call]!.promise;
    return this.inner.changePassword(...args);
  }
}

describe('password verification and credential writes', () => {
  it('does not admit an old-password login after that password was replaced', async () => {
    const users = new InMemoryUserRepository();
    const sessions = new InMemorySessionRepository(users);
    const credentials = new InMemoryCredentialRepository(users, sessions);
    const auth = new AuthService(users, sessions, credentials, new OpenStreams());
    const added = await auth.addUser('owner', OLD_PASSWORD);
    const checked = signal();
    const resume = signal();
    const deleteExpired = sessions.deleteExpired.bind(sessions);
    sessions.deleteExpired = async (...args) => {
      checked.resolve();
      await resume.promise;
      return deleteExpired(...args);
    };

    const staleLogin = auth.signIn({
      username: added.username,
      password: OLD_PASSWORD,
      ip: '127.0.0.1',
      userAgent: 'test',
    });
    await checked.promise;
    await auth.changePassword(session({ id: added.id, username: added.username, isAdmin: true }), OLD_PASSWORD, FIRST_PASSWORD);
    resume.resolve();

    await assert.rejects(staleLogin);
    assert.equal(sessions.size(), 0);
  });

  it('does not let a later password change overwrite the winner with stale verification', async () => {
    const users = new InMemoryUserRepository();
    const sessions = new InMemorySessionRepository(users);
    const inner = new InMemoryCredentialRepository(users, sessions);
    const credentials = new OrderedCredentialRepository(inner);
    const auth = new AuthService(users, sessions, credentials, new OpenStreams());
    const added = await auth.addUser('owner', OLD_PASSWORD);
    const current = session({ id: added.id, username: added.username, isAdmin: true });

    const winner = auth.changePassword(current, OLD_PASSWORD, FIRST_PASSWORD);
    await credentials.entered[0]!.promise;
    const stale = auth.changePassword(current, OLD_PASSWORD, SECOND_PASSWORD);
    await credentials.entered[1]!.promise;
    credentials.release[0]!.resolve();
    await winner;
    credentials.release[1]!.resolve();

    await assert.rejects(stale);
    const stored = await users.findById(added.id);
    assert.ok(stored);
    assert.equal(await verifyPassword(FIRST_PASSWORD, stored.password_hash), true);
    assert.equal(await verifyPassword(SECOND_PASSWORD, stored.password_hash), false);
  });
});
