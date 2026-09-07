import { ENGINE_CONFIG_MAX_BYTES } from '@streaming-infra-manager/common';
import { object, string, InferType } from 'yup';

/**
 * The whole file as one string. Its size is checked here in characters and
 * again by the service in bytes, and its content by the engine's own parser.
 */
export const engineConfigBodySchema = object({
  config: string()
    .required('config is required')
    .max(
      ENGINE_CONFIG_MAX_BYTES,
      `config must be at most ${ENGINE_CONFIG_MAX_BYTES / 1024} KiB`,
    ),
}).noUnknown(true);

export type EngineConfigBody = InferType<typeof engineConfigBodySchema>;
