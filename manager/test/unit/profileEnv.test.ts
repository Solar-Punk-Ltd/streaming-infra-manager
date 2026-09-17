/**
 * What writeProfileEnv puts in .env.<profile> for a pool-backed uploader.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Three things have to hold at once or the uploader on the other machine will
 * not start: BEE_PUBLISHERS reaches the file unquoted (deploy.sh's line parser
 * and compose both take an unquoted value literally, and the engine's own sample
 * writes it that way), ABR_ENABLED goes with it, and ABR_LADDER names exactly the
 * rungs the publishers cover — the uploader refuses any mismatch.
 */
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { throwawayRoot } from '../support/throwawayRoot.js';

// Every case writes into a scratch checkout of its own, which is the root
// writeProfileEnv is handed.
const root = throwawayRoot('shls-');

// The one definition of the base .env every case starts from. Cases that need
// a different base overwrite the file; rewriting it before each test means
// they cannot leak into the next one — a failing assertion used to skip the
// inline restore that followed it, so one real failure reported as three, two
// of them pointing at code that was fine.
const BASE_ENV =
  'ENGINE=srs\nBEE_URL=http://bee-uploader:1633\nSTREAM_LIST_TOPIC=swarm-stream\n';
const writeBaseEnv = (contents = BASE_ENV) =>
  writeFileSync(join(root, '.env'), contents);

// The stack's own .env.sample, which every checkout's base .env is copied from.
// Read rather than quoted, because what this file has to prove is what the
// shipped text actually carries: BEE_URL=http://localhost:1633, an address that
// inside the uploader container is the container itself.
const STACK_SAMPLE = fileURLToPath(
  new URL('../../swarm-hls-stream/.env.sample', import.meta.url),
);
const sampleBaseEnv = () => readFileSync(STACK_SAMPLE, 'utf8');

writeBaseEnv();

const { bootstrapStackDefaults, writeProfileEnv } = await import(
  '../../src/utils/envUtils.js',
);

const BATCH = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map((rung, i) => `${rung}@http://65.108.40.58:${10015 + i * 10}<${BATCH(rung)}>`)
  .join(' ');

const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);
const lines = (path: string) => readFileSync(path, 'utf8').split('\n');
const lineFor = (path: string, key: string) =>
  lines(path).find((line) => line.startsWith(`${key}=`));

beforeEach(() => writeBaseEnv());

describe('writeProfileEnv — BEE_PUBLISHERS', () => {
  it('writes the publishers unquoted, with ABR_ENABLED and the shipped ABR_LADDER', () => {
    const path = writeProfileEnv(root, 'stage-a', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
    assert.equal(lineFor(path, 'ABR_ENABLED'), 'ABR_ENABLED=true');
    assert.equal(
      lineFor(path, 'ABR_LADDER'),
      'ABR_LADDER=1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700',
    );
    // The base env is still copied through.
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
  });

  it('leaves an inherited STAMP alone — an empty one is fatal upstream', () => {
    // Tempting to clear: the batch belongs to whatever the base .env was set up
    // for, not to this profile. But the uploader declares `stamp: required(…)`
    // and its required() throws on '', so a blank STAMP stops the container at
    // config load. Inert-but-wrong beats fatal until STAMP is made conditional
    // upstream.
    const foreign = 'f'.repeat(64);
    writeBaseEnv(`ENGINE=srs\nSTAMP=${foreign}\n`);
    const path = writeProfileEnv(root, 'stage-inherit', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
    });
    assert.equal(lineFor(path, 'STAMP'), `STAMP=${foreign}`);
    // No restore needed: beforeEach rewrites the base env for the next case.
  });

  it('trims the pasted value', () => {
    const path = writeProfileEnv(root, 'stage-b', {
      engine: 'srs',
      beePublishers: `  ${PUBLISHERS}\n`,
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
  });

  it('writes none of the three when the profile publishes through its own node', () => {
    const path = writeProfileEnv(root, 'stage-c', {
      engine: 'srs',
      stampId: BATCH('own'),
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), undefined);
    assert.equal(lineFor(path, 'ABR_ENABLED'), undefined);
    assert.equal(lineFor(path, 'ABR_LADDER'), undefined);
    assert.equal(lineFor(path, 'STAMP'), `STAMP=${BATCH('own')}`);
  });

  it('refuses a value the uploader would refuse, naming the reason', () => {
    const missing1080 = PUBLISHERS.split(' ').slice(0, 3).join(' ');
    assert.throws(
      () => writeProfileEnv(root, 'stage-d', { engine: 'srs', beePublishers: missing1080 }),
      /refusing to write BEE_PUBLISHERS.*missing 1080p/,
    );
  });

  it('refuses the OME engine — the ladder is SRS-only', () => {
    assert.throws(
      () => writeProfileEnv(root, 'stage-e', { engine: 'ome', beePublishers: PUBLISHERS }),
      /srs engine/,
    );
  });
});

describe('writeProfileEnv — BEE_URL', () => {
  it('writes an explicit external node', () => {
    const path = writeProfileEnv(root, 'ext-a', {
      engine: 'srs',
      beeUrl: 'http://10.0.0.7:1633',
      stampId: BATCH('360p'),
    });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://10.0.0.7:1633');
  });

  it('leaves the base env alone when none is set', () => {
    const path = writeProfileEnv(root, 'ext-b', { engine: 'srs' });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
  });

  it('yields to BEE_PUBLISHERS, which the uploader reads instead', () => {
    const path = writeProfileEnv(root, 'ext-c', {
      engine: 'srs',
      beePublishers: PUBLISHERS,
      beeUrl: 'http://10.0.0.7:1633',
    });
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://bee-uploader:1633');
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
  });

  it('refuses an ssh target', () => {
    assert.throws(
      () => writeProfileEnv(root, 'ext-d', { engine: 'srs', beeUrl: 'http://deploy@10.0.0.7:1633' }),
      /refusing to write BEE_URL.*ssh user info/,
    );
  });

  it('blanks the sample placeholder when there is no node and no address', () => {
    // The last line of defence for a row stored before the request refused this
    // combination. deploy.sh refuses LOCAL_BEE_UPLOADER=false beside an EMPTY
    // BEE_URL and names what to set, but the sample's http://localhost:1633 is
    // not empty, so it passes the refusal and the uploader publishes to port
    // 1633 of its own container. Written empty, the stack's own message fires.
    writeBaseEnv(sampleBaseEnv());
    assert.equal(
      lineFor(join(root, '.env'), 'BEE_URL'),
      'BEE_URL=http://localhost:1633',
      'the shipped sample no longer carries the placeholder this case is about',
    );

    const path = writeProfileEnv(root, 'blank-a', {
      engine: 'srs',
      localBeeUploader: false,
    });

    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=');
  });

  it('leaves the placeholder alone for a pool-backed uploader, which never reads it', () => {
    // BEE_PUBLISHERS is what that uploader starts on and BEE_URL is unused, so
    // blanking it here would be changing a value for no reason.
    writeBaseEnv(sampleBaseEnv());

    const path = writeProfileEnv(root, 'blank-b', {
      engine: 'srs',
      localBeeUploader: false,
      beePublishers: PUBLISHERS,
    });

    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://localhost:1633');
  });

  it('normalises a value that was stored before the schema canonicalised it', () => {
    // writeProfileEnv normalises as well as the schema, for rows written
    // before the transform existed. Without it a four-line value already in
    // the database would still produce an .env file compose refuses to read.
    const path = writeProfileEnv(root, 'stage-legacy', {
      engine: 'srs',
      beePublishers: PUBLISHERS.split(' ').join('\n'),
    });
    assert.equal(lineFor(path, 'BEE_PUBLISHERS'), `BEE_PUBLISHERS=${PUBLISHERS}`);
  });

  it('refuses a $ in the address rather than writing one', () => {
    // This value used to be written, and had to be written literally: the
    // upsert's overwrite branch handed it to String.replace as a *replacement
    // string*, where `$&` means "the text that matched", and the old line came
    // back spliced into the middle of the new one. That is still how the writer
    // works, and no value it accepts can reach it any more, because docker
    // compose expands a $ in an env file value from the keys it parsed earlier
    // in the same file, and this file carries the deployment's secrets.
    assert.throws(
      () =>
        writeProfileEnv(root, 'ext-e', {
          engine: 'srs',
          beeUrl: 'http://10.0.0.7:1633/$&$`x',
        }),
      /refusing to write BEE_URL/,
    );
  });
});

describe('writeProfileEnv — STREAM_KEY', () => {
  // The uploader signs the feed with this key. It used to reach deploy.sh as a
  // `--private-key=` argument, which put it in the manager's own log line and
  // in the process table for the length of the run. The env file is the only
  // way in now, so these cases are what keeps it out of both.
  const KEY = `0x${'1a'.repeat(32)}`;

  it('writes the profile key over the host-wide one', () => {
    writeBaseEnv(`ENGINE=srs\nSTREAM_KEY=0x${'ff'.repeat(32)}\n`);
    const path = writeProfileEnv(root, 'keyed', { engine: 'srs', streamKey: KEY });

    assert.equal(lineFor(path, 'STREAM_KEY'), `STREAM_KEY=${KEY}`);
    assert.equal(
      lines(path).filter((line) => line.startsWith('STREAM_KEY=')).length,
      1,
      'upsert, not append',
    );
  });

  it('leaves the base env value standing when the profile has no key', () => {
    const hostWide = `0x${'ff'.repeat(32)}`;
    for (const unset of [undefined, null, '', '   ']) {
      writeBaseEnv(`ENGINE=srs\nSTREAM_KEY=${hostWide}\n`);
      assert.equal(
        lineFor(writeProfileEnv(root, 'unkeyed', { engine: 'srs', streamKey: unset }), 'STREAM_KEY'),
        `STREAM_KEY=${hostWide}`,
        `${JSON.stringify(unset)} should fall back to the base .env`,
      );
    }
  });

  it('adds the key to a base .env that has none', () => {
    const path = writeProfileEnv(root, 'added-key', { engine: 'srs', streamKey: KEY });
    assert.equal(lineFor(path, 'STREAM_KEY'), `STREAM_KEY=${KEY}`);
  });

  it('refuses anything that is not a private key', () => {
    for (const bad of [KEY.slice(0, -2), 'not-a-key', `${KEY} extra`]) {
      assert.throws(
        () => writeProfileEnv(root, 'bad-key', { engine: 'srs', streamKey: bad }),
        /refusing to write STREAM_KEY/,
        `should refuse ${bad}`,
      );
    }
  });
});

describe('writeProfileEnv — LOCAL_BEE_UPLOADER', () => {
  // deploy.sh's resolve_bee_url computes the local Bee address and writes it
  // into an override file that outranks .env.<profile>. It has to know whether
  // this PROFILE runs a Bee node, and it cannot work that out for itself: the
  // service filter says what the current invocation was asked for, and the
  // manager deploys a held-back uploader on its own once a batch is bought —
  // which looks exactly like a profile that owns no node.
  //
  // Getting it wrong breaks one case or the other. Guarding on the filter left
  // a staged `deploy.sh --profile=x stream-uploader` with the base env's
  // BEE_URL (http://localhost:1663 — inside the container, the container
  // itself), so the uploader crash-looped beside its own healthy Bee node.

  it('says false when the profile runs no Bee node of its own', () => {
    const path = writeProfileEnv(root, 'nolocal', {
      engine: 'srs',
      localBeeUploader: false,
      beeUrl: 'http://10.0.0.7:1633',
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=false');
    // And the operator's external node is what is written.
    assert.equal(lineFor(path, 'BEE_URL'), 'BEE_URL=http://10.0.0.7:1633');
  });

  it('says true when it does, so the local address is still resolved', () => {
    // The staged case: only stream-uploader is being deployed, but the profile
    // owns a bee-uploader, so resolve_bee_url must still run.
    const path = writeProfileEnv(root, 'withlocal', {
      engine: 'srs',
      localBeeUploader: true,
      stampId: BATCH('360p'),
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=true');
  });

  it('is stated explicitly, not left to the base env', () => {
    // .env.<profile> is a fresh copy of the base .env every deploy, so an
    // absent key would let a base-env value decide it.
    writeBaseEnv('ENGINE=srs\nLOCAL_BEE_UPLOADER=true\n');
    const path = writeProfileEnv(root, 'override', {
      engine: 'srs',
      localBeeUploader: false,
    });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), 'LOCAL_BEE_UPLOADER=false');
  });

  it('is omitted when the caller does not say, so deploy.sh decides as before', () => {
    // Absent means "decide as before" in deploy.sh, which keeps a hand-run
    // deploy.sh and an older manager working.
    const path = writeProfileEnv(root, 'unsaid', { engine: 'srs' });
    assert.equal(lineFor(path, 'LOCAL_BEE_UPLOADER'), undefined);
  });
});

describe('writeProfileEnv, the generated stack secrets', () => {
  it('writes a value of the shape the manager generates', () => {
    const path = writeProfileEnv(root, 'secrets', {
      engine: 'srs',
      stackSecrets: { API_AUTH_TOKEN: 'a'.repeat(64) },
    });

    assert.equal(lineFor(path, 'API_AUTH_TOKEN'), `API_AUTH_TOKEN=${'a'.repeat(64)}`);
  });

  it('refuses a value that is not one, because nothing else may reach this column', () => {
    for (const value of ['not-a-real-secret', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `]) {
      assert.throws(
        () =>
          writeProfileEnv(root, 'refused', {
            engine: 'srs',
            stackSecrets: { API_AUTH_TOKEN: value },
          }),
        /not a secret this manager generated/,
        `${value.length} characters`,
      );
    }
  });

  it('refuses a key that is not an env name', () => {
    assert.throws(
      () =>
        writeProfileEnv(root, 'refused', {
          engine: 'srs',
          stackSecrets: { 'not a key': 'a'.repeat(64) },
        }),
      /not a secret this manager generated/,
    );
  });
});

/**
 * The file holds every generated secret of the deployment, and the manager's
 * container runs as root, so on the host these bytes are root-owned and
 * readable by every account unless the mode says otherwise.
 */
describe('writeProfileEnv, the mode of the file it writes', () => {
  it('writes a new deployment env owner only', () => {
    const path = writeProfileEnv(root, 'freshmode', { engine: 'srs' });

    assert.equal(modeOf(path), '600');
  });

  it('narrows a deployment env an earlier deploy left readable', () => {
    const path = writeProfileEnv(root, 'widemode', { engine: 'srs' });
    chmodSync(path, 0o644);

    writeProfileEnv(root, 'widemode', { engine: 'srs' });

    assert.equal(modeOf(path), '600');
  });
});

/**
 * A value that carries a line break is a second line in a file two readers
 * parse by line: docker compose takes `.env.<profile>` as its env file and
 * deploy.sh takes it as its defaults. So the injected key is the writer's to
 * choose, and `SRS_CONF_FILE` is the one that pays: the version's compose
 * override bind-mounts whatever it names into the engine container.
 *
 * The addresses got here because the URL constructor drops a tab, a carriage
 * return and a line feed before it parses, so the value that was checked and
 * the value that was written were not the same string.
 */
describe('writeProfileEnv, a value that would become a second line', () => {
  it('refuses a BEE_URL carrying a line break', () => {
    assert.throws(
      () =>
        writeProfileEnv(root, 'inject-bee', {
          engine: 'srs',
          beeUrl: 'http://h:1633/a\nFOO=bar',
        }),
      /refusing to write BEE_URL/,
    );
  });

  it('refuses an RPC_ENDPOINT carrying a line break', () => {
    assert.throws(
      () =>
        writeProfileEnv(root, 'inject-rpc', {
          engine: 'srs',
          rpcEndpoint: 'http://h:8545/a\nFOO=bar',
        }),
      /refusing to write RPC_ENDPOINT/,
    );
  });

  it('refuses it in a field that has no rule of its own', () => {
    // ENGINE is written first and has never been checked, because its type says
    // it can only be one of two words. The guard sits in front of the writer
    // rather than on each field, so a field nobody thought about is covered too.
    assert.throws(
      () =>
        writeProfileEnv(root, 'inject-any', {
          engine: 'srs\nSRS_CONF_FILE=/etc/passwd' as unknown as 'srs',
        }),
      /refusing to write ENGINE/,
    );
  });
});

/**
 * The version's own base .env, which every deployment env file is copied from
 * and which carries API_AUTH_TOKEN, PUBLISH_KEY_SECRET and STREAM_KEY of its
 * own. It is made by copying the checked-in .env.sample, a file at 0644 like
 * every other file in the checkout, and a copy keeps the mode it came from.
 * The api container runs as root, so on the host those bytes were root-owned
 * and readable by every account.
 */
describe('bootstrapStackDefaults, the mode of the base env it makes', () => {
  /** A checkout with the stack's real sample in it and nothing bootstrapped. */
  const sampleRoot = (): string => {
    const dir = throwawayRoot('shls-bootstrap-');
    copyFileSync(STACK_SAMPLE, join(dir, '.env.sample'));
    chmodSync(join(dir, '.env.sample'), 0o644);
    return dir;
  };

  it('creates it owner only, though the sample it copies is world readable', async () => {
    const dir = sampleRoot();

    assert.deepEqual(await bootstrapStackDefaults(dir), [join(dir, '.env')]);
    assert.equal(modeOf(join(dir, '.env')), '600');
  });

  it('narrows one an older manager left readable', async () => {
    const dir = sampleRoot();
    writeFileSync(join(dir, '.env'), sampleBaseEnv());
    chmodSync(join(dir, '.env'), 0o644);

    assert.deepEqual(
      await bootstrapStackDefaults(dir),
      [],
      'a file that is already there is not copied over',
    );
    assert.equal(modeOf(join(dir, '.env')), '600');
  });
});

describe('the chain endpoint a deployment names for itself', () => {
  /**
   * Every Bee node reads RPC_ENDPOINT, and until now the only place to set it
   * was the stack version, so every deployment on a version shared one
   * endpoint. The shipped default is a public RPC that answered one node 4568
   * HTTP 429s in two hours on 2026-09-15, so an operator running their own
   * needs to be able to point one deployment at it without moving the rest.
   */
  it('overrides the one the version carries', () => {
    writeBaseEnv('ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n');

    const path = writeProfileEnv(root, 'own-rpc', {
      engine: 'srs',
      rpcEndpoint: 'http://host.docker.internal:9000',
    });

    assert.equal(lineFor(path, 'RPC_ENDPOINT'), 'RPC_ENDPOINT=http://host.docker.internal:9000');
    assert.equal(
      lines(path).filter((line) => line.startsWith('RPC_ENDPOINT=')).length,
      1,
      'the version value is replaced rather than joined by a second line compose would read instead',
    );
  });

  it('leaves the version value alone when the deployment names none', () => {
    writeBaseEnv('ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n');

    for (const value of [undefined, '', '   ']) {
      const path = writeProfileEnv(root, 'no-rpc', { engine: 'srs', rpcEndpoint: value });
      assert.equal(lineFor(path, 'RPC_ENDPOINT'), 'RPC_ENDPOINT=https://rpc.gnosischain.com');
    }
  });

  it('refuses an address that is not one, rather than writing it for compose to find', () => {
    writeBaseEnv();

    assert.throws(
      () => writeProfileEnv(root, 'bad-rpc', { engine: 'srs', rpcEndpoint: 'rpc.gnosischain.com' }),
      /RPC_ENDPOINT/,
    );
  });
});

describe('the chain endpoint a deployment takes from its source', () => {
  const MANAGER = 'https://rpc.manager.example.org/key';
  const OWN = 'http://host.docker.internal:9000';

  it('writes the manager’s endpoint for a deployment that takes it', () => {
    writeBaseEnv('ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n');

    const path = writeProfileEnv(root, 'from-manager', {
      engine: 'srs',
      rpcEndpointSource: 'manager',
      managerRpcEndpoint: MANAGER,
    });

    assert.equal(lineFor(path, 'RPC_ENDPOINT'), `RPC_ENDPOINT=${MANAGER}`);
  });

  it('writes the deployment’s own address for a custom one', () => {
    writeBaseEnv('ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n');

    const path = writeProfileEnv(root, 'from-own', {
      engine: 'srs',
      rpcEndpointSource: 'custom',
      rpcEndpoint: OWN,
      managerRpcEndpoint: MANAGER,
    });

    assert.equal(lineFor(path, 'RPC_ENDPOINT'), `RPC_ENDPOINT=${OWN}`);
  });

  it('writes no line at all for a deployment on the stack’s endpoint', () => {
    writeBaseEnv('ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n');

    const path = writeProfileEnv(root, 'from-stack', {
      engine: 'srs',
      rpcEndpointSource: 'stack',
      managerRpcEndpoint: MANAGER,
    });

    assert.equal(lineFor(path, 'RPC_ENDPOINT'), 'RPC_ENDPOINT=https://rpc.gnosischain.com');
  });

  it('refuses to deploy a deployment whose manager has lost its endpoint', () => {
    // The row says it takes the manager's endpoint and the manager now has
    // none. Writing no line would move it onto the stack's public RPC, and
    // nothing anywhere would say it had moved.
    writeBaseEnv();

    assert.throws(
      () =>
        writeProfileEnv(root, 'lost-manager', {
          engine: 'srs',
          rpcEndpointSource: 'manager',
          managerRpcEndpoint: null,
        }),
      /BEE_RPC_ENDPOINT/,
    );
  });
});

describe('the keys a Bee gateway put on the chain reads', () => {
  const MANAGER = 'https://rpc.manager.example.org/key';

  it('gives a light gateway the same endpoint and turns SWAP on', () => {
    writeBaseEnv();

    const path = writeProfileEnv(root, 'light-gateway', {
      engine: 'srs',
      rpcEndpointSource: 'manager',
      managerRpcEndpoint: MANAGER,
      lightGateway: true,
    });

    assert.equal(lineFor(path, 'BEE_GATEWAY_RPC_ENDPOINT'), `BEE_GATEWAY_RPC_ENDPOINT=${MANAGER}`);
    assert.equal(lineFor(path, 'BEE_GATEWAY_SWAP_ENABLE'), 'BEE_GATEWAY_SWAP_ENABLE=true');
    assert.equal(lineFor(path, 'RPC_ENDPOINT'), `RPC_ENDPOINT=${MANAGER}`);
  });

  it('gives an ultra-light gateway neither, which is what the stack ships', () => {
    writeBaseEnv();

    const path = writeProfileEnv(root, 'ultra-light-gateway', {
      engine: 'srs',
      rpcEndpointSource: 'stack',
      managerRpcEndpoint: MANAGER,
      lightGateway: false,
    });

    assert.equal(lineFor(path, 'BEE_GATEWAY_RPC_ENDPOINT'), undefined);
    assert.equal(lineFor(path, 'BEE_GATEWAY_SWAP_ENABLE'), undefined);
  });

  it('refuses a light gateway that would come up with no chain at all', () => {
    writeBaseEnv();

    assert.throws(
      () =>
        writeProfileEnv(root, 'chainless-gateway', {
          engine: 'srs',
          rpcEndpointSource: 'stack',
          lightGateway: true,
        }),
      /BEE_GATEWAY_RPC_ENDPOINT/,
    );
  });
});

