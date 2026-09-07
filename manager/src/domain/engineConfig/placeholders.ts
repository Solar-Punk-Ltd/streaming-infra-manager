import { placeholdersIn } from '@streaming-infra-manager/common';

/**
 * What a placeholder is replaced with for a syntax check, so the engine's
 * parser sees a complete file rather than a token where a number belongs.
 *
 * The values only have to parse. A passphrase of sixteen characters clears
 * SRS's length rule and a port of 1935 is a port, and none of it is ever run.
 */
const CHECK_VALUES: Record<string, string> = {
  PASSPHRASE_PLACEHOLDER: 'checkpassphrase16',
  RTMP_PORT_PLACEHOLDER: '1935',
  HTTP_PORT_PLACEHOLDER: '8080',
  HTTP_API_PORT_PLACEHOLDER: '1985',
  SRT_PORT_PLACEHOLDER: '10080',
  SRT_LATENCY_PLACEHOLDER: '200',
  INGEST_HLS_PLACEHOLDER: 'on',
  HLS_FRAGMENT_PLACEHOLDER: '1.5',
  HLS_AOF_RATIO_PLACEHOLDER: '2.1',
  HLS_WINDOW_PLACEHOLDER: '22.5',
  SRS_ADAPTER_HOST_PLACEHOLDER: 'stream-uploader',
  SRS_ADAPTER_PORT_PLACEHOLDER: '3000',
  SRS_WEBHOOK_TOKEN_PLACEHOLDER: 'checktoken',
  SEGMENT_DURATION_PLACEHOLDER: '2',
  SEGMENT_COUNT_PLACEHOLDER: '5',
  OME_ADAPTER_HOST_PLACEHOLDER: 'stream-uploader',
  OME_ADAPTER_PORT_PLACEHOLDER: '3000',
  OME_ADMISSION_SECRET_PLACEHOLDER: 'c'.repeat(64),
  OME_SRT_PORT_PLACEHOLDER: '10080',
  OME_HLS_PORT_PLACEHOLDER: '8081',
};

/**
 * Tokens the entrypoint replaces by whole lines, with a generated block or
 * with nothing. The check drops the line, which is what the no-ladder case
 * of the entrypoint does with them.
 */
const LINE_PLACEHOLDERS = ['TRANSCODE_PLACEHOLDER', 'ABR_VHOST_PLACEHOLDER'];

const FALLBACK_CHECK_VALUE = '1';

/** The file as the engine's parser will see it, every placeholder filled in. */
export function substituteForCheck(config: string): string {
  const lines = config
    .split('\n')
    .filter((line) => !LINE_PLACEHOLDERS.some((token) => line.includes(token)));
  let text = lines.join('\n');
  for (const token of placeholdersIn(text)) {
    text = text.split(token).join(CHECK_VALUES[token] ?? FALLBACK_CHECK_VALUE);
  }
  return text;
}

/**
 * The tokens a version's entrypoint fills or removes: every one it names.
 *
 * Read off the script rather than kept as a list here, so a version that
 * adds a placeholder is understood the day it is built and not the day the
 * manager is updated.
 */
export function placeholdersFilledBy(entrypoint: string): string[] {
  return placeholdersIn(entrypoint);
}
