/**
 * The rules around holding several versions of the streaming stack.
 *
 * Unit test, no database, no Docker and no git. `pnpm test` in manager/.
 *
 * Four of these guard something that would be expensive to get wrong on the
 * host. Two builds at once would overwrite each other's image tags, because the
 * stack still names its images by service alone. Removing a version in use
 * would delete the checkout the running containers were deployed from. Removing
 * the bundled one would delete the manager's own submodule. And a branch name
 * reaches `git clone --branch`, where a leading dash is an option.
 */
import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import {
  BUILD_SCRIPT,
  STACK_REPO_URL,
  StackVersionService,
} from '../../src/domain/versions/StackVersionService.js';
import { repoRootFor, stagingDirFor } from '../../src/domain/versions/stackPaths.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { scratchVersionsRoot, V3_FIXTURE } from '../support/stackFixtures.js';

const COMMIT = 'be440d65e0e82bcf9000a8a0dde905dc215255d6';
const MOVED = 'c0ffee0000000000000000000000000000000000';

let repository: InMemoryStackVersionRepository;
let runner: FakeScriptSpawner;
let bus: EventBus;
let service: StackVersionService;
let events: string[];
/**
 * A throwaway copy of the v3 fixture, so a build reported as successful finds a
 * real checkout to read a contract out of. `v3` is therefore the only name a
 * build can succeed under here.
 */
let versionsRoot: string;

beforeEach(() => {
  versionsRoot = scratchVersionsRoot();
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  runner = new FakeScriptSpawner();
  bus = new EventBus();
  events = [];
  landed = 0;
  bus.subscribe((event) => events.push(event.type));
  service = new StackVersionService(repository, runner, bus, versionsRoot, { openReferences: async () => [], pendingShipmentBuildIds: async () => [] });
});

/** Waits until no version is building any more, which is when the outcome is recorded. */
/** How many builds the test has waited out, so the wait below knows how many announcements to expect. */
let landed = 0;

/**
 * Waits for a build to land: no row building, and the service's own
 * announcement of it seen. The row leaves `building` before the service
 * prunes and announces, so a wait on the row alone let a test read the
 * events a moment too early on a loaded laptop, and the suite runs its
 * files in parallel.
 */
const settled = async (): Promise<void> => {
  landed += 1;
  for (let tick = 0; tick < 2000; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rows = await repository.list();
    const announced = events.filter((event) => event === 'version.changed').length;
    if (!rows.some((row) => row.status === 'building') && announced >= landed) return;
  }
  throw new Error('a version is still building, or was never announced');
};

/**
 * What the build script leaves in the newest attempt's staging directory
 * when it succeeds: the built tree and the commit it was exported from.
 */
const built = (name: string, commit = COMMIT): void => {
  const staging = stagingDirFor(versionsRoot, name, runner.last.args[4] ?? '');
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${commit}\n`);
};

/** A built version, marked tested the way an operator marks one. */
const readyAndTested = async (name: string): Promise<number> => {
  await service.add(name, 'main-v3');
  built(name);
  runner.finish(0, 'built\n');
  await settled();

  const added = await repository.findByName(name);
  await service.setTested(added?.id ?? 0, true, added?.commitSha ?? null, added?.buildId ?? null);
  return added?.id ?? 0;
};

/** A rebuild the fake runner reports as successful, on the given commit. */
const rebuild = async (id: number, commit = COMMIT): Promise<void> => {
  await service.update(id);
  built('v3', commit);
  runner.finish(0, 'built\n');
  await settled();
};

describe('adding a version', () => {
  it('runs the build script with the clone, the staging directory, the ref, the fixed repository and the attempt', async () => {
    await service.add('v3', 'main-v3');

    assert.equal(runner.last.script, BUILD_SCRIPT);
    const attempt = runner.last.args[4] ?? '';
    assert.deepEqual(runner.last.args, [
      repoRootFor(versionsRoot, 'v3'),
      stagingDirFor(versionsRoot, 'v3', attempt),
      'main-v3',
      STACK_REPO_URL,
      attempt,
    ]);
  });

  it('lands ready with the commit the build exported and the contract it read', { timeout: 5000 }, async (context) => {
    await service.add('v3', 'main-v3');
    built('v3');
    const changed = new Promise<void>((resolve) => {
      const unsubscribe = bus.subscribe((event) => {
        if (event.type === 'version.changed') resolve();
      });
      context.after(unsubscribe);
    });
    runner.finish(0, 'cloning\nbuilt\n');
    await changed;

    const version = await repository.findByName('v3');
    assert.equal(version?.status, 'ready');
    assert.equal(version?.commitSha, COMMIT);
    assert.equal(version?.contract?.maxSlot, 99);
    assert.equal(events.includes('version.changed'), true);
  });

  it('still pins the commit when the build log is longer than the kept tail', async () => {
    await service.add('v3', 'main-v3');
    built('v3');
    // A real `pnpm install` prints tens of thousands of lines. The commit used
    // to be parsed out of this stream, of which only the last four kilobytes
    // are kept, so on every build that did any work it was already gone.
    runner.finish(0, `${'installing a package\n'.repeat(2000)}built\n`);
    await settled();

    const version = await repository.findByName('v3');
    assert.equal(version?.commitSha, COMMIT);
  });

  it('lands failed with the tail of the log when the build exits non-zero', async () => {
    await service.add('v3', 'main-v3');
    runner.finish(1, 'fatal: could not read from remote repository\n');
    await settled();

    const version = await repository.findByName('v3');
    assert.equal(version?.status, 'failed');
    assert.match(version?.lastError ?? '', /could not read from remote/);
  });

  it('lands failed when the script never starts, rather than staying building', async () => {
    await service.add('v3', 'main-v3');
    runner.last.emitter.emit('error', new Error('spawn bash ENOENT'));
    await settled();

    const version = await repository.findByName('v3');
    assert.equal(version?.status, 'failed');
    assert.match(version?.lastError ?? '', /ENOENT/);
  });

  it('refuses a name that is already taken', async () => {
    await assert.rejects(
      () => service.add('bundled', 'main-v2'),
      /already exists/,
    );
  });

  it('refuses a branch git would read as an option, before spawning anything', async () => {
    await assert.rejects(
      () => service.add('v3', '--upload-pack=touch /tmp/x'),
      /cannot start with a dash|nothing else/,
    );
    assert.equal(runner.spawned.length, 0);
  });

  it('refuses a name the database would refuse', async () => {
    await assert.rejects(() => service.add('Main V3', 'main-v3'), /lower case/);
  });
});

describe('the build mutex', () => {
  it('refuses a second build while one is running, and names the first', async () => {
    await service.add('v3', 'main-v3');

    await assert.rejects(
      () => service.add('other', 'main-v2'),
      /v3 is building/,
    );
    assert.equal(runner.spawned.length, 1);
  });

  it('lets only the first of two builds started together through', async () => {
    // Both calls, no await between them: the shape a double click on Add or two
    // operators on the same page make. The check used to sit before an await
    // and the setting after one, so both got past it and two containers built
    // at once, each overwriting the other's image tags.
    const first = service.add('v3', 'main-v3');
    const second = service.add('other', 'main-v2');

    await assert.rejects(() => second, /v3 is building/);
    await first;
    assert.equal(runner.spawned.length, 1);
  });

  it('frees the mutex when the version being added already exists', async () => {
    await assert.rejects(() => service.add('bundled', 'main-v2'), /already exists/);

    await service.add('v3', 'main-v3');
    assert.equal(runner.spawned.length, 1);
  });

  it('frees the mutex when the update is refused', async () => {
    const bundled = await repository.findByName('bundled');
    await assert.rejects(
      () => service.update(bundled?.id ?? 0),
      /comes with the manager/,
    );

    await service.add('v3', 'main-v3');
    assert.equal(runner.spawned.length, 1);
  });

  it('lets the next build start once the first has finished', async () => {
    await service.add('v3', 'main-v3');
    built('v3');
    runner.finish(0, 'built\n');
    await settled();

    await service.add('other', 'main-v2');
    assert.equal(runner.spawned.length, 2);
  });

  it('lets a failed build free the mutex too', async () => {
    await service.add('v3', 'main-v3');
    runner.finish(1, 'boom');
    await settled();

    await service.add('other', 'main-v2');
    assert.equal(runner.spawned.length, 2);
  });
});

describe('the default version', () => {
  it('starts on the bundled row and moves to exactly one other', async () => {
    const id = await readyAndTested('v3');
    await service.setDefault(id);

    const versions = await service.list();
    assert.deepEqual(
      versions.filter((version) => version.isDefault).map((v) => v.name),
      ['v3'],
    );
  });

  it('refuses a version nobody has deployed on yet', async () => {
    await service.add('v3', 'main-v3');
    built('v3');
    runner.finish(0, 'built\n');
    await settled();
    const added = await repository.findByName('v3');

    await assert.rejects(
      () => service.setDefault(added?.id ?? 0),
      /Mark v3 as tested first/,
    );
  });

  it('refuses a version that has not finished building', async () => {
    await service.add('v3', 'main-v3');
    const building = await repository.findByName('v3');

    await assert.rejects(
      () => service.setDefault(building?.id ?? 0),
      /Only a version that finished building/,
    );
  });

  it('refuses a version that does not exist', async () => {
    await assert.rejects(() => service.setDefault(4242), /not found/);
  });
});

describe('removing a version', () => {
  it('refuses while a deployment runs it, and names the deployments', async () => {
    await service.add('v3', 'main-v3');
    built('v3');
    runner.finish(0, 'built\n');
    await settled();

    const added = await repository.findByName('v3');
    repository.setDeployments(added?.id ?? 0, ['main-stage', 'backup-stage']);

    await assert.rejects(
      () => service.remove(added?.id ?? 0),
      /main-stage, backup-stage/,
    );
    assert.notEqual(await repository.findByName('v3'), null);
  });

  it('refuses the bundled version, which comes with the manager', async () => {
    const bundled = await repository.findByName('bundled');

    await assert.rejects(
      () => service.remove(bundled?.id ?? 0),
      /cannot be removed/,
    );
  });

  it('refuses the version that carries the default badge', async () => {
    // Removing it would leave the table with no default at all, because the
    // index permits none rather than requiring one, and the next deployment
    // would be created with no version to run.
    await service.add('v3', 'main-v3');
    built('v3');
    runner.finish(0, 'built\n');
    await settled();

    const added = await repository.findByName('v3');
    await service.setTested(added?.id ?? 0, true, added?.commitSha ?? null, added?.buildId ?? null);
    await service.setDefault(added?.id ?? 0);

    await assert.rejects(
      () => service.remove(added?.id ?? 0),
      /v3 is the default version\. Set another default first\./,
    );
    assert.notEqual(await repository.findByName('v3'), null);
  });

  it('refuses a version that is building right now', async () => {
    await service.add('v3', 'main-v3');
    const building = await repository.findByName('v3');

    await assert.rejects(
      () => service.remove(building?.id ?? 0),
      /is building/,
    );
  });
});

describe('the tested flag', () => {
  it('is set by hand for the commit the page showed, and answered back with the row', async () => {
    const bundled = await repository.findByName('bundled');
    await repository.setCommitSha(bundled?.id ?? 0, COMMIT);
    const updated = await service.setTested(bundled?.id ?? 0, true, COMMIT);

    assert.equal(updated.tested, true);
    assert.equal(events.includes('version.changed'), true);
  });

  it('is cleared by an update that lands on another commit', async () => {
    // The approval stands for a person having deployed one commit and watched
    // it work. Carrying it over to whatever the branch moved to would let an
    // untested commit become the default without anybody saying so.
    const id = await readyAndTested('v3');

    await rebuild(id, MOVED);

    const rebuilt = await repository.findById(id);
    assert.equal(rebuilt?.commitSha, MOVED);
    assert.equal(rebuilt?.tested, false);
  });

  it('survives an update that lands on the same commit', async () => {
    // A rebuild of a branch that has not moved. The commit the operator
    // approved is still the commit on disk, so the approval still holds.
    const id = await readyAndTested('v3');
    const before = await repository.findById(id);

    await rebuild(id);

    const rebuilt = await repository.findById(id);
    assert.equal(rebuilt?.commitSha, before?.commitSha);
    assert.equal(rebuilt?.tested, true);
  });

  it('stays off through an update of a version nobody approved', async () => {
    await service.add('v3', 'main-v3');
    built('v3');
    runner.finish(0, 'built\n');
    await settled();

    const added = await repository.findByName('v3');
    await rebuild(added?.id ?? 0);

    assert.equal((await repository.findByName('v3'))?.tested, false);
  });

  it('cannot be set on a version that is still building', async () => {
    await service.add('v3', 'main-v3');
    const building = await repository.findByName('v3');

    await assert.rejects(
      () => service.setTested(building?.id ?? 0, true, COMMIT),
      /v3 is building\. Only a version that finished building/,
    );
    assert.equal((await repository.findByName('v3'))?.tested, false);
  });

  it('cannot be set on a version whose build failed', async () => {
    await service.add('v3', 'main-v3');
    runner.finish(1, 'fatal: could not read from remote repository\n');
    await settled();
    const failed = await repository.findByName('v3');

    await assert.rejects(
      () => service.setTested(failed?.id ?? 0, true, COMMIT),
      /v3 is failed\. Only a version that finished building/,
    );
  });

  it('can be cleared while the version is building', async () => {
    // The other direction is an operator withdrawing an approval, and a
    // version being rebuilt right now is exactly when that matters.
    const id = await readyAndTested('v3');
    await service.update(id);

    const updated = await service.setTested(id, false);
    assert.equal(updated.tested, false);
  });
});

describe('the bundled version at boot', () => {
  it('records the commit and reads the contract from its own checkout', async () => {
    await service.syncBundled(V3_FIXTURE, COMMIT);

    const bundled = await repository.findByName('bundled');
    assert.equal(bundled?.commitSha, COMMIT);
    assert.equal(bundled?.contract?.maxSlot, 99);
  });

  it('keeps the row when the checkout cannot be read, with no commit', async () => {
    await service.syncBundled(join(versionsRoot, 'nowhere'), null);

    const bundled = await repository.findByName('bundled');
    assert.equal(bundled?.commitSha, null);
    assert.equal(bundled?.contract, null);
  });

  it('keeps the approval on the same commit, and takes it with a move to another', async () => {
    // Approval names a build. A manager deploy that moves the bundled
    // checkout is a new build nobody has run yet, the way an Update is.
    await service.syncBundled(V3_FIXTURE, COMMIT);
    const bundled = await repository.findByName('bundled');
    await repository.setTested(bundled?.id ?? 0, true, COMMIT);

    await service.syncBundled(V3_FIXTURE, COMMIT);
    assert.equal((await repository.findByName('bundled'))?.tested, true, 'the same commit');

    await service.syncBundled(V3_FIXTURE, 'f'.repeat(40));
    assert.equal((await repository.findByName('bundled'))?.tested, false, 'another commit');
  });
});

describe('a build the manager was restarted during', () => {
  it('fails the row rather than leaving it building forever', async () => {
    await service.add('v3', 'main-v3');
    // No finish: this is a manager that went away mid-build. A fresh service
    // over the same table is what the next boot has.
    const rebooted = new StackVersionService(
      repository,
      new FakeScriptSpawner(),
      bus,
      versionsRoot,
      { openReferences: async () => [], pendingShipmentBuildIds: async () => [] },
    );

    assert.deepEqual(await rebooted.failInterruptedBuilds(), ['v3']);

    const version = await repository.findByName('v3');
    assert.equal(version?.status, 'failed');
    assert.equal(
      version?.lastError,
      'Interrupted by a manager restart. Update the version to build it again.',
    );
  });

  it('leaves a ready version alone and says nothing was interrupted', async () => {
    assert.deepEqual(await service.failInterruptedBuilds(), []);
    assert.equal((await repository.findByName('bundled'))?.status, 'ready');
  });
});

describe('listing versions', () => {
  it('carries how many deployments run each one', async () => {
    const bundled = await repository.findByName('bundled');
    repository.setDeployments(bundled?.id ?? 0, ['a', 'b', 'c']);

    const [first] = await service.list();
    assert.equal(first?.deployments, 3);
  });
});
