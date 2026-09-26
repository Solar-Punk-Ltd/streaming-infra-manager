/**
 * What the engine routes accept at the edge.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The schema's only job is shape: known keys, string values, and nothing else
 * taken, a key no engine reads refused by name. The bounds, the choices and
 * the keyframe rule belong to `engineSettingsProblem`, which the drawer and
 * the deploy both call, so a second copy of them here would be a third rule
 * to keep in step.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  containerParamsSchema,
  engineSettingsSchema,
  logsQuerySchema,
} from '../../src/schemas/engine.js';

const validate = <T>(schema: {
  validate: (value: unknown, options: object) => Promise<T>;
}, stripUnknown = true) =>
  (value: unknown): Promise<T> =>
    schema.validate(value, { abortEarly: false, stripUnknown });

describe('engineSettingsSchema', () => {
  // As the engine settings route reads a body: a key it does not declare is
  // refused rather than dropped, because the body replaces the whole set.
  const accept = validate(engineSettingsSchema, false);

  it('takes the keys of either engine, as strings', async () => {
    assert.deepEqual(
      await accept({ HLS_FRAGMENT: '2', ABR_PRESET: 'faster' }),
      { HLS_FRAGMENT: '2', ABR_PRESET: 'faster' },
    );
    assert.deepEqual(await accept({ HLS_SEGMENT_COUNT: '8' }), {
      HLS_SEGMENT_COUNT: '8',
    });
  });

  it('refuses a key neither engine reads, naming every such key and never a value', async () => {
    const typed = 'typed-value-4711';
    const refusal = await accept({ HLS_FRAGMENT: '2', HLS_FRAGMNT: typed, NONSENSE: 'x' }).then(
      () => null,
      (error: { errors: string[] }) => error.errors,
    );

    assert.deepEqual(refusal, [
      'Not an engine setting either engine reads: HLS_FRAGMNT, NONSENSE. Nothing was stored. This route replaces ' +
        'every engine setting with the body, so a misspelled key would have put the setting it meant back to its ' +
        'default. GET /profiles/:name/engine lists the settings this deployment reads.',
    ]);
    assert.equal(JSON.stringify(refusal).includes(typed), false);
  });

  it('takes an empty body, which is every setting back to its default', async () => {
    assert.deepEqual(await accept({}), {});
  });

  it('leaves the value exactly as typed', async () => {
    // Coercing to a number and back would write HLS_FRAGMENT=1.5 where the
    // operator typed 1.50, and the container would then disagree with the form.
    assert.deepEqual(await accept({ HLS_FRAGMENT: '1.50' }), {
      HLS_FRAGMENT: '1.50',
    });
  });
});

describe('containerParamsSchema', () => {
  const accept = validate(containerParamsSchema);

  it('takes a deployment name and a service of this stack', async () => {
    assert.deepEqual(await accept({ name: 'stream1', service: 'srs' }), {
      name: 'stream1',
      service: 'srs',
    });
  });

  it('refuses a service name that is not in the stack', async () => {
    await assert.rejects(
      () => accept({ name: 'stream1', service: 'postgres' }),
      /service must be one of this stack/,
    );
  });

  it('refuses a deployment name the profile routes would refuse', async () => {
    await assert.rejects(
      () => accept({ name: '../etc', service: 'srs' }),
      /name must match/,
    );
  });
});

describe('logsQuerySchema', () => {
  const accept = validate(logsQuerySchema);

  it('takes a line count as the string a query string carries', async () => {
    assert.deepEqual(await accept({ tail: '200' }), { tail: 200 });
  });

  it('takes no line count at all, and the route picks the default', async () => {
    assert.deepEqual(await accept({}), {});
  });

  it('names the bound when there are too many lines asked for', async () => {
    await assert.rejects(
      () => accept({ tail: '50000' }),
      /tail must be at most 2000 lines/,
    );
  });
});
