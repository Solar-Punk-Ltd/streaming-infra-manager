import {
  ABR_UPLOADER_KIND,
  BEE_UPLOADER_SERVICE,
  beePublishersProblem,
  beeUrlProblem,
  defaultServicesFor,
  engineForComponents,
  hasConflictingEngines,
  LADDER_GROUP_NAME_MAX,
  OME_SERVICE,
} from '@streaming-infra-manager/common';
import { array, boolean, number, object, string, InferType } from 'yup';

import { ALL_SERVICES, PROFILE_KINDS } from '../types/index.js';

const ONE_ENGINE_MESSAGE =
  'components may include at most one engine (srs or ome, not both)';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/; // like localhost or "user@host"
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const FEED_TOPIC_RE = /^[\x20-\x7E]{1,128}$/;

// Four `rung@url<batch>` entries come to ~500 chars; this is headroom, not a
// format rule — beePublishersProblem is the rule.
const BEE_PUBLISHERS_MAX = 2000;

/**
 * A pasted BEE_PUBLISHERS. Validated here, where the operator can still fix it,
 * against the same rules the uploader applies when it starts — on another
 * machine, where the failure would be a container that will not come up.
 */
const beePublishersField = () =>
  string()
    .nullable()
    .notRequired()
    .max(BEE_PUBLISHERS_MAX)
    .test('bee-publishers', 'invalid bee_publishers', function (value) {
      const problem = beePublishersProblem(value);
      return problem
        ? this.createError({ message: `bee_publishers: ${problem}` })
        : true;
    })
    // An abr-uploader is defined by publishing to a pool. Without the value it
    // is a streamer with no Bee node and no postage — it would deploy and never
    // upload anything.
    .test('required-for-abr-uploader', 'bee_publishers required', function (v) {
      const { kind } = this.parent as { kind?: string };
      if (kind !== ABR_UPLOADER_KIND || (v && v.trim())) return true;
      return this.createError({
        message: `bee_publishers is required for a ${ABR_UPLOADER_KIND} — paste it from an ABR node pool`,
      });
    });

/**
 * An explicit bee API URL. Refused alongside `bee_publishers`, which the
 * uploader reads instead, so a config cannot say two different things about
 * where uploads go.
 */
const beeUrlField = () =>
  string()
    .nullable()
    .notRequired()
    .max(255)
    .test('bee-url', 'invalid bee_url', function (value) {
      const problem = beeUrlProblem(value);
      if (problem) return this.createError({ message: `bee_url: ${problem}` });
      if (!value || !value.trim()) return true;
      const { bee_publishers } = this.parent as { bee_publishers?: string | null };
      if (bee_publishers && bee_publishers.trim()) {
        return this.createError({
          message:
            'bee_url is not used when bee_publishers is set — the uploader publishes to the pool',
        });
      }
      return true;
    });

export const profileNameSchema = object({
  name: string()
    .required()
    .matches(PROFILE_NAME_RE, 'name must match /^[a-z0-9][a-z0-9-]{0,30}$/'),
}).strict();

export const createProfileSchema = object({
  name: string()
    .required()
    .matches(PROFILE_NAME_RE, 'name must match /^[a-z0-9][a-z0-9-]{0,30}$/'),
  kind: string()
    .oneOf([...PROFILE_KINDS])
    .default('custom'),
  notes: string().nullable().notRequired().max(500),
  host: string()
    .notRequired()
    .matches(HOST_RE, 'host must be "localhost", an ssh alias, or user@host'),
  components: array()
    .of(
      string()
        .required()
        .oneOf([...ALL_SERVICES]),
    )
    .notRequired()
    .test('one-engine', ONE_ENGINE_MESSAGE, (v) => !hasConflictingEngines(v)),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  private_key: string()
    .notRequired()
    .matches(PRIVATE_KEY_RE, 'private_key must be 0x + 64 hex chars')
    // The uploader declares `streamKey: required('STREAM_KEY')` and derives the
    // catalog feed's owner from it, so one is not optional for a deployment
    // whose only job is to publish. Without it the container throws at config
    // load and restarts forever, while the manager reports RUNNING throughout.
    .test('required-for-abr-uploader', 'private_key required', function (v) {
      const { kind } = this.parent as { kind?: string };
      if (kind !== ABR_UPLOADER_KIND || (v && v.trim())) return true;
      return this.createError({
        message: `private_key is required for a ${ABR_UPLOADER_KIND} — it is the uploader's STREAM_KEY, and it cannot start without one`,
      });
    }),
  public_key: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'public_key must be a 0x-prefixed Ethereum address',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
  bee_publishers: beePublishersField().test(
    'bee-publishers-srs-only',
    'bee_publishers requires the srs engine — the ABR ladder is SRS-only',
    function (value) {
      if (!value || !value.trim()) return true;
      const { components } = this.parent as { components?: string[] | null };
      return engineForComponents(components) !== OME_SERVICE;
    },
  ),
  bee_url: beeUrlField().test(
    'bee-url-needs-no-local-node',
    'bee_url has no effect alongside a local bee-uploader',
    function (value) {
      if (!value || !value.trim()) return true;
      const { kind, components } = this.parent as {
        kind?: string;
        components?: string[] | null;
      };
      // deploy.sh's resolve_bee_url overwrites BEE_URL whenever a local
      // bee-uploader is enabled, so accepting one here would store a value that
      // silently never applies.
      const services = defaultServicesFor({ kind: kind ?? 'custom', components });
      return !services.includes(BEE_UPLOADER_SERVICE)
        ? true
        : this.createError({
            message:
              'bee_url only applies to a deployment that runs no bee-uploader — remove that component to point the uploader at an external node',
          });
    },
  ),
}).noUnknown(true);

export type CreateProfileInput = InferType<typeof createProfileSchema>;

export const updateProfileSchema = object({
  notes: string().nullable().notRequired().max(500),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  private_key: string()
    .notRequired()
    .matches(PRIVATE_KEY_RE, 'private_key must be 0x + 64 hex chars'),
  public_key: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'public_key must be a 0x-prefixed Ethereum address',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
  // Neither the engine nor the components are in an update body; writeProfileEnv
  // refuses an OME profile at deploy time, and components are immutable after
  // the first deploy so the bee-uploader check cannot newly fail here.
  bee_publishers: beePublishersField(),
  bee_url: beeUrlField(),
}).noUnknown(true);

export type UpdateProfileInput = InferType<typeof updateProfileSchema>;

export const createGroupSchema = object({
  group_name: string()
    .required()
    .matches(
      PROFILE_NAME_RE,
      'group_name must match /^[a-z0-9][a-z0-9-]{0,30}$/',
    )
    // A ladder member is named `<group>-<rung>`, and profile names cap at 31
    // characters, so a ladder's group name has less room than an ordinary one.
    // Caught here rather than as a check-constraint violation partway through
    // creating the group.
    .test(
      'ladder-name-fits',
      `group_name must be at most ${LADDER_GROUP_NAME_MAX} characters for an ABR node pool, so that <group>-<rung> member names stay within 31`,
      function (value) {
        const { abr_ladder } = this.parent as { abr_ladder?: boolean };
        if (!abr_ladder || !value) return true;
        return value.length <= LADDER_GROUP_NAME_MAX;
      },
    ),
  /**
   * Deploy one bee-uploader per ABR quality rung, named `<group>-<rung>`. Size and
   * components are fixed by the ladder; anything passed for them is ignored.
   */
  abr_ladder: boolean().notRequired(),
  size: number().required().integer().min(1),
  kind: string()
    .oneOf([...PROFILE_KINDS])
    .default('custom'),
  notes: string().nullable().notRequired().max(500),
  host: string()
    .notRequired()
    .matches(HOST_RE, 'host must be "localhost", an ssh alias, or user@host'),
  components: array()
    .of(
      string()
        .required()
        .oneOf([...ALL_SERVICES]),
    )
    .notRequired()
    .test('one-engine', ONE_ENGINE_MESSAGE, (v) => !hasConflictingEngines(v)),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  private_key: string()
    .notRequired()
    .matches(PRIVATE_KEY_RE, 'private_key must be 0x + 64 hex chars'),
  public_key: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'public_key must be a 0x-prefixed Ethereum address',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
}).noUnknown(true);

export type CreateGroupInput = InferType<typeof createGroupSchema>;

export const groupIdParamSchema = object({
  id: string()
    .required()
    .matches(/^[1-9]\d*$/, 'id must be a positive integer'),
}).strict();

export const updateGroupConfigSchema = object({
  notes: string().nullable().notRequired().max(500),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
}).noUnknown(true);

export type UpdateGroupConfigInput = InferType<typeof updateGroupConfigSchema>;

export const addMembersSchema = object({
  count: number().required().integer().min(1),
}).noUnknown(true);

export type AddMembersInput = InferType<typeof addMembersSchema>;
