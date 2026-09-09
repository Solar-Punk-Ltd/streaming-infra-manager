/**
 * Finding, restarting and reading one container of one deployment.
 *
 * Unit test, no Docker daemon and no database. `pnpm test` in manager/.
 *
 * The one that matters most is the label match. A host runs a dozen
 * deployments and each of them has an `srs`, so matching on the service label
 * alone is eleven chances to restart somebody else's stream, and matching on
 * the project alone restarts whichever container of this deployment came back
 * first. The fake daemon deliberately ignores the filters it is handed, which
 * is what an older daemon does with a filter key it does not know.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
} from '../../src/domain/composeLabels.js';
import {
  ContainerControl,
  type ContainerControlLimits,
  MAX_CONFIG_BYTES,
} from '../../src/domain/ContainerControl.js';
import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import {
  fakeDocker,
  frame,
  openStream,
  RUNNING_AFTER_TWO_RESTARTS,
  type FakeContainer,
} from '../support/fakeDocker.js';

/** Docker's per-write header: the stream, three zero bytes, and the length. */
const FRAME_HEADER_BYTES = 8;

describe('published port inventory', () => {
  it('retains ports owned by paused containers', async () => {
    const docker = fakeDocker([{ id: 'paused', labels: labels('outside', 'web') }]);
    const handle = docker.getContainer('paused');
    docker.getContainer = () => ({ ...handle, inspect: async () => ({
      Id: 'paused', RestartCount: 0, State: { Status: 'paused', StartedAt: '2026-09-07T10:00:00Z' },
      Config: { Labels: labels('outside', 'web') },
      HostConfig: { NetworkMode: 'bridge' },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '10012' }] } },
    }) });
    const snapshot = await new ContainerControl(new EventBus(), docker).publishedPorts();
    assert.deepEqual(snapshot.bindings.map(binding => [binding.project, binding.protocol, binding.port]), [['outside', 'tcp', 10012]]);
  });
});

describe('daemon identity verification', () => {
  it('reads the current local identity again after the socket is replaced', async () => {
    const docker = fakeDocker([]);
    let id = 'first-daemon';
    docker.info = async () => ({ ID: id });
    const control = new ContainerControl(new EventBus(), docker);
    assert.equal(await control.daemonId(), 'first-daemon');
    id = 'replacement-daemon';
    assert.equal(await control.daemonId(), 'replacement-daemon');
  });

  it('does not report an old verification when Docker stops answering', async () => {
    const docker = fakeDocker([]);
    const control = new ContainerControl(new EventBus(), docker);
    await control.daemonId();
    docker.info = async () => { throw new Error('offline'); };
    await assert.rejects(control.daemonId());
  });
});

function labels(project: string, service: string): Record<string, string> {
  return {
    [COMPOSE_PROJECT_LABEL]: project,
    [COMPOSE_SERVICE_LABEL]: service,
  };
}

const HOST_CONTAINERS: FakeContainer[] = [
  { id: 'other-srs', labels: labels('stream2', 'srs') },
  { id: 'own-uploader', labels: labels('stream1', 'stream-uploader') },
  {
    id: 'own-srs',
    labels: labels('stream1', 'srs'),
    logBytes: Buffer.concat([
      frame('2026-09-06T10:00:00Z srs.conf generated from template\n'),
      frame('2026-09-06T10:00:01Z listening on 10080\n', 2),
    ]),
    execBytes: frame('listen 1935;\nhls_fragment 1.5;\n'),
  },
];

function controlOver(
  containers: FakeContainer[] = HOST_CONTAINERS,
  limits: Partial<ContainerControlLimits> = {},
): {
  control: ContainerControl;
  docker: ReturnType<typeof fakeDocker>;
  seen: ManagerEvent[];
} {
  const docker = fakeDocker(containers);
  const events = new EventBus();
  const seen: ManagerEvent[] = [];
  events.subscribe((event) => seen.push(event));
  return { control: new ContainerControl(events, docker, limits), docker, seen };
}

describe('ContainerControl.find', () => {
  it('matches on both compose labels, never on one', async () => {
    const { control, docker } = controlOver();

    await control.restart('stream1', 'srs');

    assert.deepEqual(docker.restarted, [{ id: 'own-srs', timeoutSeconds: 10 }]);
    // And the daemon was asked for both labels, so a healthy one filters for us.
    assert.deepEqual(docker.listCalls[0]?.filters, {
      label: [
        `${COMPOSE_PROJECT_LABEL}=stream1`,
        `${COMPOSE_SERVICE_LABEL}=srs`,
      ],
    });
  });

  it('says what to do when nothing of that service is up', async () => {
    const { control } = controlOver([
      { id: 'other-srs', labels: labels('stream2', 'srs') },
    ]);

    await assert.rejects(
      () => control.restart('stream1', 'srs'),
      /No srs container is running for stream1\. Start the deployment/,
    );
  });
});

describe('ContainerControl.restart', () => {
  it('publishes the restart, so it lands in the activity list', async () => {
    const { control, seen } = controlOver();

    await control.restart('stream1', 'stream-uploader');

    assert.deepEqual(seen, [
      {
        type: 'engine.restarted',
        profile: 'stream1',
        service: 'stream-uploader',
      },
    ]);
  });

  it('refuses a service that is not restartable on its own', async () => {
    const { control, docker } = controlOver();

    await assert.rejects(
      () => control.restart('stream1', 'client'),
      /client cannot be restarted on its own\. Pick one of srs, ome, stream-uploader, bee-uploader/,
    );
    assert.deepEqual(docker.restarted, [], 'nothing may be touched');
  });

  it('refuses before it asks the daemon anything', async () => {
    const { control, docker } = controlOver();
    await assert.rejects(() => control.restart('stream1', 'made-up'));
    assert.deepEqual(docker.listCalls, []);
  });

  it('refuses a second restart of the same container right after the first', async () => {
    // A container reads as down for the seconds it takes to come back, which is
    // exactly when the button gets pressed again.
    const { control, docker } = controlOver();

    await control.restart('stream1', 'srs');
    await assert.rejects(
      () => control.restart('stream1', 'srs'),
      /srs on stream1 was restarted a moment ago\. Wait a few seconds, then try again\./,
    );

    assert.equal(docker.restarted.length, 1, 'the second one touched nothing');
  });

  it('lets the same container be restarted again once the cooldown is over', async () => {
    const { control, docker } = controlOver(HOST_CONTAINERS, {
      restartCooldownMs: 20,
    });

    await control.restart('stream1', 'srs');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await control.restart('stream1', 'srs');

    assert.equal(docker.restarted.length, 2);
  });

  it('holds no other container up while one is cooling down', async () => {
    // The guard is per deployment and service: two operators restarting two
    // different streams are not in each other's way.
    const { control, docker } = controlOver();

    await control.restart('stream1', 'srs');
    await control.restart('stream1', 'stream-uploader');

    assert.deepEqual(
      docker.restarted.map((entry) => entry.id),
      ['own-srs', 'own-uploader'],
    );
  });
});

describe('ContainerControl.logs', () => {
  it('demultiplexes the frames docker wraps each write in', async () => {
    const { control } = controlOver();

    const text = await control.logs('stream1', 'srs', 200);

    assert.equal(
      text,
      '2026-09-06T10:00:00Z srs.conf generated from template\n' +
        '2026-09-06T10:00:01Z listening on 10080',
    );
  });

  it('asks for both streams with timestamps, and follows them', async () => {
    // Followed, so the answer arrives in pieces the byte bound can stop. Asked
    // for whole, the daemon assembles it in memory before any cap applies.
    const { control, docker } = controlOver();

    await control.logs('stream1', 'srs', 200);

    assert.deepEqual(docker.logOptions[0], {
      stdout: true,
      stderr: true,
      follow: true,
      timestamps: true,
      tail: 200,
    });
  });

  it('caps what it asks the daemon for at 2000 lines', async () => {
    const { control, docker } = controlOver();

    await control.logs('stream1', 'srs', 50_000);

    assert.equal(docker.logOptions[0]?.tail, 2000);
  });

  it('caps what it hands back at 2000 lines as well', async () => {
    // The daemon is asked for 2000, but a single line can be split across many
    // frames and a hand-run container may ignore `tail` entirely, so the cap is
    // applied to the answer too.
    const { control } = controlOver([
      {
        id: 'own-srs',
        labels: labels('stream1', 'srs'),
        logBytes: frame(
          Array.from({ length: 3000 }, (_value, i) => `line ${i}`).join('\n'),
        ),
      },
    ]);

    const text = await control.logs('stream1', 'srs', 2000);

    assert.equal(text.split('\n').length, 2000);
    assert.equal(text.split('\n')[0], 'line 1000');
  });

  it('caps a log whose lines end in a newline at 2000 as well', async () => {
    // The trailing newline splits into an empty last element. Counted as a
    // line it pushed the oldest real one out and put a blank at the end.
    const { control } = controlOver([
      {
        id: 'own-srs',
        labels: labels('stream1', 'srs'),
        logBytes: frame(
          Array.from({ length: 3000 }, (_value, i) => `line ${i}\n`).join(''),
        ),
      },
    ]);

    const lines = (await control.logs('stream1', 'srs', 2000)).split('\n');

    assert.equal(lines.length, 2000);
    assert.equal(lines[0], 'line 1000');
    assert.equal(lines[1999], 'line 2999');
  });

  it('reads a container with a TTY, which frames nothing', async () => {
    const { control } = controlOver([
      {
        id: 'own-srs',
        labels: labels('stream1', 'srs'),
        logBytes: Buffer.from('plain terminal output\n', 'utf8'),
      },
    ]);

    assert.equal(await control.logs('stream1', 'srs'), 'plain terminal output');
  });
});

describe('ContainerControl.logs: when a followed read stops', () => {
  // A followed stream never ends on its own, and the line count is no bound on
  // bytes: one line has no length limit. Three stops, all three tested against
  // bounds shortened so the test does not have to wait out the real ones.
  const SHORT_BOUNDS = { maxBytes: 64, idleMs: 40, totalMs: 250 };

  function controlOverStream(
    open: () => NodeJS.ReadableStream,
    log: ContainerControlLimits['log'] = SHORT_BOUNDS,
  ) {
    return controlOver(
      [{ id: 'own-srs', labels: labels('stream1', 'srs'), logStream: open }],
      { log },
    );
  }

  it('stops at the byte cap, however much more was sent', async () => {
    const feed = openStream();
    const { control } = controlOverStream(() => feed.stream);
    feed.write('x'.repeat(4096));

    const text = await control.logs('stream1', 'srs', 2000);

    assert.equal(Buffer.byteLength(text), 64);
    assert.equal(feed.stream.destroyed, true, 'and the stream is closed');
  });

  it('stops once the tail has arrived and nothing follows it', async () => {
    // What every ordinary read does: the daemon sends the tail, then holds the
    // connection open for lines the container has not written yet.
    const feed = openStream();
    const { control } = controlOverStream(() => feed.stream);
    feed.write('one\ntwo\n');

    const started = Date.now();
    const text = await control.logs('stream1', 'srs', 2000);

    assert.equal(text, 'one\ntwo');
    assert.ok(
      Date.now() - started < 200,
      'the idle gap ends it, not the total bound',
    );
    assert.equal(feed.stream.destroyed, true);
  });

  it('stops at the total bound when lines keep arriving', async () => {
    // A container logging continuously never leaves an idle gap, so without the
    // total bound the request would stay open for as long as it keeps talking.
    const feed = openStream();
    const ticking = setInterval(() => feed.write('still going\n'), 10);
    // Room to spare on bytes, so it is the total bound that ends this one.
    const { control } = controlOverStream(() => feed.stream, {
      ...SHORT_BOUNDS,
      maxBytes: 1024 * 1024,
    });

    try {
      const started = Date.now();
      const text = await control.logs('stream1', 'srs', 2000);
      const took = Date.now() - started;

      assert.ok(text.startsWith('still going'), 'with what arrived kept');
      assert.ok(took >= 250, `stopped after ${took} ms, not before the bound`);
      assert.ok(took < 2000, `stopped after ${took} ms, not never`);
      assert.equal(feed.stream.destroyed, true);
    } finally {
      clearInterval(ticking);
    }
  });
});

describe('ContainerControl: a daemon that does not answer', () => {
  // Not a daemon that refuses, which fails at once and says so, but one that
  // accepts the call and goes quiet. Every one of these calls is answering an
  // HTTP request, so without a bound the request waits until the browser gives
  // up and the operator learns nothing.
  const SOON: Partial<ContainerControlLimits> = { dockerTimeoutMs: 30 };
  const NOT_IN_TIME =
    /The Docker daemon did not answer in time\. Try again in a moment\./;

  it('gives up on a listing that never comes back', async () => {
    const docker = fakeDocker(HOST_CONTAINERS, true);
    const control = new ContainerControl(new EventBus(), docker, SOON);

    await assert.rejects(() => control.logs('stream1', 'srs'), NOT_IN_TIME);
  });

  it('gives up on a restart the daemon accepted and never finished', async () => {
    const docker = fakeDocker([
      { id: 'own-srs', labels: labels('stream1', 'srs'), stalls: true },
    ]);
    const control = new ContainerControl(new EventBus(), docker, SOON);

    await assert.rejects(() => control.restart('stream1', 'srs'), NOT_IN_TIME);
  });

  it('leaves the container restartable, since nothing was confirmed', async () => {
    // The cooldown follows a restart that landed. This one did not.
    const docker = fakeDocker([
      { id: 'own-srs', labels: labels('stream1', 'srs'), stalls: true },
    ]);
    const control = new ContainerControl(new EventBus(), docker, SOON);

    await assert.rejects(() => control.restart('stream1', 'srs'), NOT_IN_TIME);
    await assert.rejects(() => control.restart('stream1', 'srs'), NOT_IN_TIME);
  });
});

describe('ContainerControl.effectiveConfig', () => {
  it('cats the config the entrypoint generated, and demultiplexes it', async () => {
    const { control, docker } = controlOver();

    const config = await control.effectiveConfig('stream1', 'srs');

    assert.deepEqual(docker.execCommands, [
      ['cat', '/usr/local/srs/conf/srs.conf'],
    ]);
    assert.equal(config, 'listen 1935;\nhls_fragment 1.5;\n');
  });

  it('truncates a config larger than the cap instead of failing', async () => {
    // `cat` reads whatever is at that path, and the entrypoint is not the only
    // thing that could have written there. An answer the browser cannot render
    // is worse than a truncated one, and an error is worse than both.
    const { control } = controlOver([
      {
        id: 'own-srs',
        labels: labels('stream1', 'srs'),
        execBytes: frame('x'.repeat(MAX_CONFIG_BYTES + 4096)),
      },
    ]);

    const config = await control.effectiveConfig('stream1', 'srs');

    // The cap counts the bytes read off the socket, eight of which are the
    // frame header the demultiplexer then strips.
    assert.equal(Buffer.byteLength(config), MAX_CONFIG_BYTES - FRAME_HEADER_BYTES);
  });

  it('reads the other engine from its own path', async () => {
    const { control, docker } = controlOver([
      {
        id: 'own-ome',
        labels: labels('stream1', 'ome'),
        execBytes: frame('<Server version="8" />\n'),
      },
    ]);

    await control.effectiveConfig('stream1', 'ome');

    assert.deepEqual(docker.execCommands, [
      ['cat', '/opt/ovenmediaengine/bin/origin_conf/Server.xml'],
    ]);
  });
});

describe('ContainerControl.inspect', () => {
  it('reads the restart count from beside State, where Docker puts it', async () => {
    // A container that died on its config file and was brought back by its
    // restart policy is `running` again with a count above zero. Read from
    // under `State`, where Docker never puts it, the count is always zero, and
    // the watch after a config change is blind to the one thing it looks for.
    const { control } = controlOver([
      { id: 'other-srs', labels: labels('stream2', 'srs') },
      {
        id: 'own-srs',
        labels: labels('stream1', 'srs'),
        inspectAnswer: RUNNING_AFTER_TWO_RESTARTS,
      },
    ]);

    const state = await control.inspect('stream1', 'srs');

    assert.deepEqual(state, {
      id: 'own-srs',
      status: 'running',
      restartCount: 2,
      startedAt: '2026-09-07T10:00:09.000000000Z',
    });
  });

  it('answers null when the deployment has no container of that service', async () => {
    const { control } = controlOver([
      { id: 'other-srs', labels: labels('stream2', 'srs') },
    ]);

    assert.equal(await control.inspect('stream1', 'srs'), null);
  });
});
