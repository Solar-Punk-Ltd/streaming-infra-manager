import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishedBindings } from '../../src/domain/ports/publishedPorts.js';
import { TargetDocker } from '../../src/domain/ports/TargetDocker.js';

const container = {
  id: 'a'.repeat(64), project: 'stage', service: 'srs',
  ports: {
    '1935/tcp': [{ HostIp: '0.0.0.0', HostPort: '10012' }, { HostIp: '::', HostPort: '10012' }],
    '10080/udp': [{ HostIp: '0.0.0.0', HostPort: '10011' }],
    '80/tcp': null,
  },
};

describe('published port observations', () => {
  it('reads public ports with transport, owner and service, deduplicating interface bindings', () => {
    assert.deepEqual(publishedBindings(container), [
      { containerId: container.id, project: 'stage', service: 'srs', port: 10012, protocol: 'tcp' },
      { containerId: container.id, project: 'stage', service: 'srs', port: 10011, protocol: 'udp' },
    ]);
  });

  it('keeps unlabelled container ownership and rejects malformed bound ports', () => {
    assert.equal(publishedBindings({ ...container, project: null, service: null })[0]!.project, null);
    for (const HostPort of ['', '0', '65536', 'garbage']) {
      assert.throws(() => publishedBindings({ ...container, ports: { '80/tcp': [{ HostPort }] } }));
    }
  });

  it('reads selected fields and daemon identity through one remote SSH command', async () => {
    const commands: string[] = [];
    const docker = new TargetDocker({ daemonId: async () => 'local' }, async (_file, args) => {
      commands.push(args.at(-1)!);
      return `"remote"\n${JSON.stringify(container)}\n"remote"\n`;
    });
    const snapshot = await docker.publishedPorts('edge');
    assert.equal(snapshot.daemonId, 'remote');
    assert.equal(snapshot.bindings.length, 2);
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /docker inspect --format/);
    assert.doesNotMatch(commands[0]!, /\.Config\.Env/);
  });

  it('refuses a port scan whose daemon identity changes before it finishes', async () => {
    const docker = new TargetDocker({ daemonId: async () => 'local' }, async () => '"before"\n"after"\n');
    await assert.rejects(docker.publishedPorts('edge'));
  });
});
