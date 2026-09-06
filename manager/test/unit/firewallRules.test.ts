/**
 * That the host firewall generator opens the stack's ports and not the ones
 * standing next to them.
 *
 * The whole ruleset is arithmetic on the port table in `DeploymentOrchestrator`
 * (`PORT_VAR_DEFAULTS`), and the two mistakes it can make both look fine in a
 * diff: an off-by-one in the base leaves a Bee API open to the internet, where
 * anyone reaching it can spend the node's postage, and a wrong stride closes a
 * P2P port so the node quietly stops finding peers. So the script is run and
 * its output read, the way `nginxProxyHeaders.test.ts` reads nginx.conf.
 *
 * The DOCKER-USER section has a third mistake available to it. Docker has
 * already rewritten the destination port by the time that chain runs, so a rule
 * written against `tcp dport` would match the container's port and quietly
 * filter nothing. These check that the match is on the original destination.
 *
 * A fourth mistake is the two port bands landing on each other. Every base
 * shifts by ten per slot, so far enough up the first band its ports reach the
 * second band's: first-band slot 101 has its RTMP port on 11012, which is the
 * rung band's slot 1 P2P port and open. The script refuses a slot above 100 for
 * that reason, and the sweep below is what holds it there.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(
  here,
  '..',
  '..',
  '..',
  'deploy',
  'host',
  'firewall-rules.sh',
);

/**
 * The highest slot the script opens, and not the 999 the manager allocates:
 * above 100 the first band's ports land on the rung band's, and the rung sets
 * would open the RTMP ports the first band leaves closed on purpose.
 */
const FIRST_BAND_SLOT_CAP = 100;

/** The first slot refused, whose RTMP port is the rung band's slot 1 P2P port. */
const FIRST_OVERLAPPING_SLOT = FIRST_BAND_SLOT_CAP + 1;
const OVERLAP_PORT = 11012;

/** Any name will do, so long as the ruleset carries it through. */
const IFACE = 'eth0';

/** A generator that hangs instead of refusing should fail, not stall the suite. */
const RUN = { timeout: 10_000, encoding: 'utf8' } as const;

const DOCKER_USER_FLUSH = 'flush chain ip filter DOCKER-USER';
const DOCKER_USER_RULE = 'add rule ip filter DOCKER-USER';
const BAND = '10000-19999';

/**
 * Slot 1's ports: the stack's base table plus one stride of ten. That table is
 * PORT_VARS in `manager/swarm-hls-stream/deploy/scripts/_lib.sh` and
 * PORT_VAR_DEFAULTS in `manager/src/domain/DeploymentOrchestrator.ts`, copied
 * into `deploy/host/firewall-rules.sh` and again into these numbers. A port
 * that moves in either source has to move in all four places.
 */
const SLOT_ONE = {
  beeUploaderP2p: 10016,
  beeGatewayP2p: 10018,
  viewer: 10014,
  srtIngest: 10011,
  uploaderApi: 10010,
  beeUploaderApi: 10015,
  beeGatewayApi: 10017,
  srsApi: 10019,
};

/** What one slot adds to every base in that table. */
const SLOT_STRIDE = 10;

/**
 * The media server's RTMP base, from the same table, shifted per slot like the
 * rest. No set holds one: anyone who reaches it can publish to the media server
 * as if they were the streamer.
 */
const RTMP_BASE = 10002;

const rtmpPort = (slot: number): number => RTMP_BASE + slot * SLOT_STRIDE;

/**
 * How many ports each set gains per slot, and the highest slot it ever shifts
 * to. The second band's stack refuses a slot above 99, so that band stops there
 * however high `--max-slot` goes.
 */
const RUNG_SLOT_CAP = 99;

interface Band {
  basesInBand: number;
  slotCap: number;
  l4proto: string;
}

const BANDS: Record<string, Band> = {
  bee_p2p: { basesInBand: 2, slotCap: FIRST_BAND_SLOT_CAP, l4proto: 'tcp' },
  rung_p2p: { basesInBand: 3, slotCap: RUNG_SLOT_CAP, l4proto: 'tcp' },
  viewer: { basesInBand: 1, slotCap: FIRST_BAND_SLOT_CAP, l4proto: 'tcp' },
  srt_ingest: { basesInBand: 1, slotCap: FIRST_BAND_SLOT_CAP, l4proto: 'udp' },
};

const SET_BLOCK = /set (\w+) \{[^}]*elements = \{([^}]*)\}/g;

/** A DOCKER-USER return rule: its matches, its ports, and the band it names. */
const DOCKER_USER_BAND =
  /add rule ip filter DOCKER-USER ([^\n{]*)\{([^}]*)\} return comment "(\w+)"/g;

/**
 * Arguments the script must refuse whole, and the flag its message has to name.
 * Bash reads a digit string in two ways that are both wrong for a port slot: a
 * leading zero is octal inside `(( ))`, and `[ -lt ]` on a value wider than a
 * 64 bit integer prints an error and carries on rather than answering. Either
 * one printed a ruleset that did not match the numbers in its own header, and a
 * ruleset that prints is a ruleset somebody applies.
 */
const REFUSED: ReadonlyArray<{
  why: string;
  argv: readonly string[];
  flag: string;
}> = [
  {
    why: 'a slot below the first one the manager allocates',
    argv: ['--iface', IFACE, '--max-slot', '0'],
    flag: '--max-slot',
  },
  {
    why: 'a slot above the last one the manager allocates',
    argv: ['--iface', IFACE, '--max-slot', '1000'],
    flag: '--max-slot',
  },
  {
    why: 'a slot that is not a number at all',
    argv: ['--iface', IFACE, '--max-slot', 'abc'],
    flag: '--max-slot',
  },
  {
    why: 'a slot written with a leading zero, which would read as octal',
    argv: ['--iface', IFACE, '--max-slot', '010'],
    flag: '--max-slot',
  },
  {
    why: 'a slot wider than the integers the shell can compare',
    argv: ['--iface', IFACE, '--max-slot', '9223372036854775808'],
    flag: '--max-slot',
  },
  {
    why: 'an SSH port below the first one',
    argv: ['--iface', IFACE, '--ssh-port', '0'],
    flag: '--ssh-port',
  },
  {
    why: 'an SSH port above the last one',
    argv: ['--iface', IFACE, '--ssh-port', '70000'],
    flag: '--ssh-port',
  },
  {
    why: 'an interface name carrying a quote, which nft could not read back',
    argv: ['--iface', 'eth0"quoted'],
    flag: '--iface',
  },
];

type PortSets = Map<string, number[]>;

function ruleset(...args: string[]): string {
  return execFileSync('bash', [SCRIPT, '--iface', IFACE, ...args], RUN);
}

/** Everything from the flush of Docker's user chain to the end of the file. */
function dockerUserSection(...args: string[]): string {
  const printed = ruleset(...args);
  const start = printed.indexOf(DOCKER_USER_FLUSH);

  assert.notEqual(start, -1, 'the ruleset has no DOCKER-USER section');
  return printed.slice(start);
}

/** That section's rules, one string each, the multi-line sets left behind. */
function dockerUserRules(...args: string[]): string[] {
  return dockerUserSection(...args)
    .split('\n')
    .filter((line) => line.startsWith(DOCKER_USER_RULE));
}

/** What each band's return rule matches on, keyed by the band it names. */
function dockerUserMatches(...args: string[]): Map<string, string> {
  const matches = new Map<string, string>();

  for (const [, match, , name] of dockerUserSection(...args).matchAll(
    DOCKER_USER_BAND,
  )) {
    matches.set(name!, match!.trim());
  }
  return matches;
}

/** Every port that section lets through, whatever band the rule names. */
function dockerUserReturnedPorts(...args: string[]): Set<number> {
  const ports = new Set<number>();

  for (const [, , listed] of dockerUserSection(...args).matchAll(
    DOCKER_USER_BAND,
  )) {
    for (const element of listed!.split(',')) {
      ports.add(Number(element.trim()));
    }
  }
  return ports;
}

function portSets(...args: string[]): PortSets {
  const sets: PortSets = new Map();

  for (const [, name, elements] of ruleset(...args).matchAll(SET_BLOCK)) {
    sets.set(
      name!,
      elements!.split(',').map((element) => Number(element.trim())),
    );
  }
  return sets;
}

function portsOf(sets: PortSets, name: string): number[] {
  const ports = sets.get(name);
  assert.ok(ports, `the ruleset has no set named ${name}`);
  return ports;
}

function everyOpenPort(sets: PortSets): Set<number> {
  return new Set([...sets.values()].flat());
}

function assertSetSizes(sets: PortSets, maxSlot: number): void {
  for (const [name, { basesInBand, slotCap }] of Object.entries(BANDS)) {
    const slots = Math.min(maxSlot, slotCap);

    assert.equal(
      portsOf(sets, name).length,
      slots * basesInBand,
      `${name} should hold one port per base for each of ${slots} slots`,
    );
  }
}

describe('firewall-rules.sh', () => {
  it('opens what a deployment has to be reached on', () => {
    const sets = portSets();

    assert.ok(portsOf(sets, 'bee_p2p').includes(SLOT_ONE.beeUploaderP2p));
    assert.ok(portsOf(sets, 'bee_p2p').includes(SLOT_ONE.beeGatewayP2p));
    assert.ok(portsOf(sets, 'viewer').includes(SLOT_ONE.viewer));
    assert.ok(portsOf(sets, 'srt_ingest').includes(SLOT_ONE.srtIngest));
  });

  it('leaves the APIs next to them to the drop policy', () => {
    const open = everyOpenPort(portSets());

    for (const port of [
      SLOT_ONE.uploaderApi,
      SLOT_ONE.beeUploaderApi,
      SLOT_ONE.beeGatewayApi,
      SLOT_ONE.srsApi,
    ]) {
      assert.ok(!open.has(port), `${port} must not be in any set`);
    }
  });

  it('covers every slot it can open without the two bands meeting', () => {
    assertSetSizes(portSets(), FIRST_BAND_SLOT_CAP);
  });

  it('leaves every slot RTMP port closed, in both sections, at the cap', () => {
    const maxSlot = String(FIRST_BAND_SLOT_CAP);
    const open = everyOpenPort(portSets('--max-slot', maxSlot));
    const returned = dockerUserReturnedPorts('--max-slot', maxSlot);

    for (let slot = 1; slot <= FIRST_BAND_SLOT_CAP; slot++) {
      const rtmp = rtmpPort(slot);

      assert.ok(!open.has(rtmp), `slot ${slot} has RTMP ${rtmp} in a set`);
      assert.ok(
        !returned.has(rtmp),
        `slot ${slot} has RTMP ${rtmp} returned by DOCKER-USER`,
      );
    }
    assert.equal(
      rtmpPort(FIRST_OVERLAPPING_SLOT),
      OVERLAP_PORT,
      'the next slot up is the one whose RTMP port the rung band already opens',
    );
  });

  it('opens only as far as --max-slot says', () => {
    const sets = portSets('--max-slot', '99');
    const open = everyOpenPort(sets);

    assertSetSizes(sets, 99);
    assert.ok(open.has(10998), 'slot 99 still needs its gateway P2P port');
    assert.ok(!open.has(11008), 'slot 100 is past the limit that was asked for');
  });

  it('stops the second band at slot 99 however high --max-slot goes', () => {
    const rung = portsOf(
      portSets('--max-slot', String(FIRST_BAND_SLOT_CAP)),
      'rung_p2p',
    );

    assert.equal(rung.length, RUNG_SLOT_CAP * BANDS.rung_p2p!.basesInBand);
    assert.ok(rung.includes(11996), 'slot 99 is the last one the stack allows');
    assert.ok(!rung.includes(12006), 'slot 100 is one the stack refuses');
  });
});

describe('firewall-rules.sh, the DOCKER-USER section', () => {
  it('filters the interface it was told the internet arrives on', () => {
    const section = dockerUserSection();

    assert.ok(
      section.startsWith(DOCKER_USER_FLUSH),
      'the section should begin by emptying the chain of an earlier run',
    );
    for (const rule of dockerUserRules().slice(1)) {
      assert.ok(
        rule.includes(`iifname "${IFACE}"`),
        `every rule but the first should name the interface: ${rule}`,
      );
    }
  });

  it('lets an established connection through before anything else', () => {
    assert.equal(
      dockerUserRules()[0],
      `${DOCKER_USER_RULE} ct state established,related return`,
    );
  });

  it('matches the port the client dialled, not the container port', () => {
    for (const rule of dockerUserRules().slice(1)) {
      assert.ok(
        rule.includes('ct original proto-dst'),
        `Docker has already rewritten the destination by here: ${rule}`,
      );
    }
  });

  it('names the protocol the input chain opens each band on', () => {
    const printed = ruleset();
    const matches = dockerUserMatches();

    assert.equal(matches.size, Object.keys(BANDS).length);
    for (const [name, { l4proto }] of Object.entries(BANDS)) {
      assert.ok(
        printed.includes(`${l4proto} dport @${name} accept`),
        `the input chain should open ${name} on ${l4proto} and nothing else`,
      );
      assert.ok(
        matches.get(name)?.includes(`meta l4proto ${l4proto}`),
        `and so should this: ${matches.get(name)} (${name})`,
      );
    }
  });

  it('drops the rest of the band the stack publishes in', () => {
    const rules = dockerUserRules();

    assert.equal(
      rules.at(-1),
      `${DOCKER_USER_RULE} iifname "${IFACE}" ct original proto-dst ${BAND} drop`,
    );
  });

  it('creates neither the table nor the chain, because Docker owns both', () => {
    const section = dockerUserSection();

    assert.ok(
      !section.includes('table ip filter {'),
      'defining the table would take it over from Docker',
    );
    assert.ok(
      !section.includes('chain DOCKER-USER {'),
      'defining the chain would take it over from Docker',
    );
  });
});

describe('firewall-rules.sh, the arguments it refuses', () => {
  it('refuses to print at all without --iface', () => {
    const run = spawnSync('bash', [SCRIPT], RUN);

    assert.equal(run.status, 2);
    assert.equal(run.stdout, '', 'a refused run should print no ruleset');
    assert.match(run.stderr, /--iface is required/);
    assert.match(
      run.stderr,
      /ip -4 route get 1\.1\.1\.1/,
      'the message should say how to find the name',
    );
  });

  it('refuses the first slot the two bands would collide on, and says where', () => {
    const run = spawnSync(
      'bash',
      [SCRIPT, '--iface', IFACE, '--max-slot', String(FIRST_OVERLAPPING_SLOT)],
      RUN,
    );

    assert.equal(run.status, 2, `stderr was: ${run.stderr}`);
    assert.equal(run.stdout, '', 'a refused run should print no ruleset');
    assert.ok(
      run.stderr.includes('--max-slot'),
      `the message should name --max-slot, and says: ${run.stderr}`,
    );
    assert.match(
      run.stderr,
      /rung/,
      `the message should name the band it runs into: ${run.stderr}`,
    );
    assert.ok(
      run.stderr.includes(String(OVERLAP_PORT)),
      `the message should name the port they meet on: ${run.stderr}`,
    );
  });

  for (const { why, argv, flag } of REFUSED) {
    it(`refuses ${why}`, () => {
      const run = spawnSync('bash', [SCRIPT, ...argv], RUN);

      assert.equal(run.status, 2, `stderr was: ${run.stderr}`);
      assert.equal(run.stdout, '', 'a refused run should print no ruleset');
      assert.ok(
        run.stderr.includes(flag),
        `the message should name ${flag}, and says: ${run.stderr}`,
      );
    });
  }
});
