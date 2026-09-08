import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VerifiedDeployTargets } from '../../src/domain/ports/VerifiedDeployTargets.js';
import { TargetDocker, type ReadOnlyCommand } from '../../src/domain/ports/TargetDocker.js';
import { TargetNotVerifiedError } from '../../src/domain/errors/index.js';
import { InMemoryDeployTargets } from '../support/InMemoryDeployTargets.js';

describe('deploy target verification', () => {
  it('persists the identity and verification time, and aliases share a namespace', async () => {
    const repo = new InMemoryDeployTargets();
    const calls: string[] = [];
    const targets = new VerifiedDeployTargets(repo, {
      daemonId: async (alias) => { calls.push(alias); return 'daemon-1'; },
    });

    for (const alias of [null, 'localhost', 'edge', 'admin@edge']) {
      assert.equal(await targets.daemonIdFor(alias), 'daemon-1');
    }
    assert.deepEqual(calls, ['localhost', 'edge', 'admin@edge']);
    const rows = await targets.list();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.daemonId === 'daemon-1' && row.verifiedAt instanceof Date));
  });

  it('records a failed verification without raw command output and refuses allocation', async () => {
    const repo = new InMemoryDeployTargets();
    const targets = new VerifiedDeployTargets(repo, {
      daemonId: async () => { throw new Error('sensitive subprocess diagnostics'); },
    });
    await assert.rejects(targets.daemonIdFor('edge'), TargetNotVerifiedError);
    const row = (await targets.list())[0]!;
    assert.equal(row.daemonId, null);
    assert.equal(row.verifiedAt, null);
    assert.doesNotMatch(row.lastError!, /sensitive/);
  });

  it('invalidates a cached verification when an on-demand check fails', async () => {
    const repo = new InMemoryDeployTargets();
    let reachable = true;
    const targets = new VerifiedDeployTargets(repo, {
      daemonId: async () => {
        if (!reachable) throw new Error('offline');
        return 'daemon-1';
      },
    });
    await targets.daemonIdFor('edge');
    reachable = false;
    await assert.rejects(targets.verify('edge'), TargetNotVerifiedError);
    await assert.rejects(targets.daemonIdFor('edge'), TargetNotVerifiedError);
    assert.equal((await targets.list())[0]!.verifiedAt, null);
  });

  it('does not silently move an existing alias to another daemon', async () => {
    const repo = new InMemoryDeployTargets();
    let id = 'daemon-1';
    const targets = new VerifiedDeployTargets(repo, { daemonId: async () => id });
    await targets.daemonIdFor('edge');
    id = 'daemon-2';
    await assert.rejects(targets.verify('edge'), /different daemon/);
    const row = (await targets.list())[0]!;
    assert.equal(row.daemonId, 'daemon-1');
    assert.equal(row.verifiedAt, null);
    await assert.rejects(targets.daemonIdFor('edge'), TargetNotVerifiedError);
  });
});

describe('the read-only target probe', () => {
  it('reads remote containers and their daemon identity in one SSH session', async () => {
    const calls: string[] = [];
    const id = 'a'.repeat(64);
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async (file) => {
      calls.push(file);
      return `"remote-id"\n${id} srs\n"remote-id"\n`;
    });
    const snapshot = await docker.snapshot('stage', 'edge');
    assert.deepEqual(calls, ['ssh']);
    assert.equal(snapshot.daemonId, 'remote-id');
    assert.deepEqual(snapshot.containers, new Map([['srs', [id]]]));
  });

  it('refuses a snapshot if the daemon changed during the observation', async () => {
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async () => '"before"\n"after"\n');
    await assert.rejects(docker.snapshot('stage', 'edge'));
  });

  it('rejects malformed remote container rows instead of treating them as absent', async () => {
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async () => '"id"\nunreadable\n"id"\n');
    await assert.rejects(docker.snapshot('stage', 'edge'));
  });
  it('uses the local socket only for localhost, and ssh for every other alias including 127.0.0.1', async () => {
    const commands: { file: string; args: readonly string[] }[] = [];
    const run: ReadOnlyCommand = async (file, args) => {
      commands.push({ file, args });
      return '"remote-id"\n';
    };
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, run);
    assert.equal(await docker.daemonId('localhost'), 'local-id');
    for (const alias of ['edge', 'user@edge', '127.0.0.1']) {
      assert.equal(await docker.daemonId(alias), 'remote-id');
      const command = commands.at(-1)!;
      assert.equal(command.file, 'ssh');
      assert.ok(command.args.includes(alias));
      assert.equal(command.args.at(-1), "docker info --format '{{json .ID}}'");
      assert.ok(command.args.includes('BatchMode=yes'));
      assert.ok(command.args.includes('StrictHostKeyChecking=yes'));
    }
    assert.equal(commands.length, 3);
  });

  it('rejects command-shaped aliases before starting any process', async () => {
    let calls = 0;
    const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async () => {
      calls += 1;
      return '"id"';
    });
    for (const alias of ['-oProxyCommand=bad', 'edge;bad', 'edge\nother']) {
      await assert.rejects(docker.daemonId(alias), TargetNotVerifiedError);
    }
    assert.equal(calls, 0);
  });

  it('rejects an empty, malformed or non-string daemon identity', async () => {
    for (const answer of ['""', '{}', 'null', 'not json']) {
      const docker = new TargetDocker({ daemonId: async () => 'local-id' }, async () => answer);
      await assert.rejects(docker.daemonId('edge'));
    }
  });
});
