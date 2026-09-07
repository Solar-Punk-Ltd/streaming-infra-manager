/**
 * A config file of the deployment's own, for the mock manager.
 *
 * It answers the three routes the way `manager/src/api/routes/engineConfig.ts`
 * does: the version's template with its placeholders when nothing is stored,
 * a refusal in the manager's own words for a version without the hook or a
 * file the engine would refuse, and a recreate that moves the deployment
 * through DEPLOYING and back. The engine's own parser is stood in for by a
 * brace count for SRS and a tag count for OME, and a file containing the
 * word `crash` plays the revert: a few seconds after the recreate the
 * previous file is back and the row says why.
 */
import {
  defaultServicesFor,
  ENGINE_CONFIG_MAX_BYTES,
  ENGINE_CONFIG_REFERENCES,
  ENGINE_DISPLAY_NAMES,
  engineOfServices,
  OME_SERVICE,
  placeholdersIn,
  unknownPlaceholders,
} from '@streaming-infra-manager/common';

import { send } from './mock-http.mjs';
import { refreshDerived } from './mock-seed.mjs';
import { contractOfVersion } from './mock-versions.mjs';

/** How long after the recreate a `crash` file is reverted. */
const CRASH_AFTER_MS = 4000;

const SRS_TEMPLATE = `listen              RTMP_PORT_PLACEHOLDER;
max_connections     1000;
daemon              off;

http_server {
    enabled         on;
    listen          HTTP_PORT_PLACEHOLDER;
    dir             ./objs/nginx/html;
}

http_api {
    enabled         on;
    listen          HTTP_API_PORT_PLACEHOLDER;
}

srt_server {
    enabled         on;
    listen          SRT_PORT_PLACEHOLDER;
    latency         SRT_LATENCY_PLACEHOLDER;
    passphrase      PASSPHRASE_PLACEHOLDER;
    pbkeylen        16;
    tlpktdrop       on;
    tsbpdmode       on;
}

vhost __defaultVhost__ {
    srt {
        enabled     on;
    }

    hls {
        enabled         INGEST_HLS_PLACEHOLDER;
        hls_path        ./objs/nginx/html;
        hls_fragment    HLS_FRAGMENT_PLACEHOLDER;
        hls_aof_ratio   HLS_AOF_RATIO_PLACEHOLDER;
        hls_window      HLS_WINDOW_PLACEHOLDER;
        hls_ts_file     [app]/[stream]/[stream]-[seq].ts;
        hls_m3u8_file   [app]/[stream]/index.m3u8;
    }

    http_hooks {
        enabled         on;
        on_publish      http://SRS_ADAPTER_HOST_PLACEHOLDER:SRS_ADAPTER_PORT_PLACEHOLDER/engines/srs/streams?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
        on_unpublish    http://SRS_ADAPTER_HOST_PLACEHOLDER:SRS_ADAPTER_PORT_PLACEHOLDER/engines/srs/streams?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
        on_hls          http://SRS_ADAPTER_HOST_PLACEHOLDER:SRS_ADAPTER_PORT_PLACEHOLDER/engines/srs/hls?token=SRS_WEBHOOK_TOKEN_PLACEHOLDER;
    }

TRANSCODE_PLACEHOLDER
}

ABR_VHOST_PLACEHOLDER
`;

const OME_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<Server version="8">
    <Name>SwarmHlsStreamOME</Name>
    <Type>origin</Type>
    <IP>*</IP>
    <Bind>
        <Providers><SRT><Port>OME_SRT_PORT_PLACEHOLDER</Port></SRT></Providers>
        <Publishers><HLS><Port>OME_HLS_PORT_PLACEHOLDER</Port></HLS></Publishers>
    </Bind>
    <VirtualHosts>
        <VirtualHost>
            <Name>default</Name>
            <AdmissionWebhooks>
                <ControlServerUrl>http://OME_ADAPTER_HOST_PLACEHOLDER:OME_ADAPTER_PORT_PLACEHOLDER/engines/ome/admission</ControlServerUrl>
                <SecretKey>OME_ADMISSION_SECRET_PLACEHOLDER</SecretKey>
                <Timeout>3000</Timeout>
            </AdmissionWebhooks>
            <Applications>
                <Application>
                    <Name>video</Name>
                    <Type>live</Type>
                    <Publishers>
                        <HLS>
                            <SegmentDuration>SEGMENT_DURATION_PLACEHOLDER</SegmentDuration>
                            <SegmentCount>SEGMENT_COUNT_PLACEHOLDER</SegmentCount>
                        </HLS>
                    </Publishers>
                </Application>
            </Applications>
        </VirtualHost>
    </VirtualHosts>
</Server>
`;

const TEMPLATES = { srs: SRS_TEMPLATE, [OME_SERVICE]: OME_TEMPLATE };

/** The stored files, by deployment name. The profile only knows whether it has one. */
const configs = new Map();

function engineOf(profile) {
  return engineOfServices(defaultServicesFor(profile));
}

function validationError(res, message) {
  return send(res, 400, { error: 'validation_error', errors: [message] });
}

function unsupportedReason(profile, engine) {
  return (
    `bundled renders the ${ENGINE_DISPLAY_NAMES[engine]} config from its template and cannot run a file of its own. ` +
    'Deploy on main-v3 or a later version to edit it.'
  );
}

function supports(profile, engine) {
  return contractOfVersion(profile.stack_version_id)?.engineConfig?.[engine] ?? false;
}

/** The engine's parser, stood in for: SRS counts braces, OME counts tags. */
function parserProblem(engine, config) {
  if (engine === OME_SERVICE) {
    const opened = (config.match(/<[A-Za-z][^/>]*>/g) ?? []).length;
    const closed = (config.match(/<\/[A-Za-z][^>]*>/g) ?? []).length;
    return opened === closed ? null : `Line ${config.split('\n').length}: an element is never closed.`;
  }
  const opened = (config.match(/{/g) ?? []).length;
  const closed = (config.match(/}/g) ?? []).length;
  if (opened === closed) return null;
  return `SRS refused the file. parse dir : line ${config.split('\n').length}: unexpected end of file, expecting "}" in your config`;
}

function view(profile, engine) {
  const supported = supports(profile, engine);
  return {
    engine,
    supported,
    unsupportedReason: supported ? null : unsupportedReason(profile, engine),
    config: configs.get(profile.name) ?? null,
    template: TEMPLATES[engine],
    placeholders: placeholdersIn(TEMPLATES[engine]),
    error: profile.engine_config_error,
    references: ENGINE_CONFIG_REFERENCES[engine],
  };
}

/**
 * @param deps.readBody    reads a JSON request body
 * @param deps.withProfile wraps a handler so the 404 is written once
 * @param deps.deploy      the mock's own DEPLOYING then RUNNING transition
 * @param deps.publish     writes an event to every open SSE client
 */
export function engineConfigRoutes({ readBody, withProfile, deploy, publish }) {
  const changed = (profile) => {
    refreshDerived(profile);
    publish({ type: 'profile.changed', profile });
  };

  const store = (profile, config, error) => {
    if (config === null) configs.delete(profile.name);
    else configs.set(profile.name, config);
    profile.has_engine_config = config !== null;
    profile.engine_config_error = error;
  };

  /** The watch, played: a file that says `crash` takes the engine down and is reverted. */
  const watchAfter = (profile, engine, previous, config) => {
    if (!/crash/.test(config)) return;
    setTimeout(() => {
      store(
        profile,
        previous,
        `${ENGINE_DISPLAY_NAMES[engine]} keeps restarting on the new config file, so the previous one is back. The engine's last lines:\n` +
          'srs.conf generated from the custom config file\n' +
          'invalid config, exiting',
      );
      deploy(profile);
      changed(profile);
    }, CRASH_AFTER_MS);
  };

  return [
    [
      'GET',
      /^\/profiles\/([^/]+)\/engine-config$/,
      withProfile((_req, res, profile) => {
        const engine = engineOf(profile);
        if (!engine) return validationError(res, `${profile.name} runs no media server, so it has no engine config.`);
        send(res, 200, view(profile, engine));
      }),
    ],
    [
      'PUT',
      /^\/profiles\/([^/]+)\/engine-config$/,
      withProfile(async (req, res, profile) => {
        const engine = engineOf(profile);
        if (!engine) return validationError(res, `${profile.name} runs no media server, so it has no engine config.`);
        if (profile.status === 'DEPLOYING') {
          return send(res, 409, { error: 'profile_busy', message: `${profile.name} is DEPLOYING` });
        }
        if (!supports(profile, engine)) return validationError(res, unsupportedReason(profile, engine));

        const { config } = await readBody(req);
        if (typeof config !== 'string' || !config.trim()) {
          return validationError(res, 'The file is empty. Use Back to the template to run the template again.');
        }
        if (config.length > ENGINE_CONFIG_MAX_BYTES) {
          return validationError(res, `The file is larger than ${ENGINE_CONFIG_MAX_BYTES / 1024} KiB.`);
        }
        const unknown = unknownPlaceholders(config, placeholdersIn(TEMPLATES[engine]));
        if (unknown.length > 0) {
          return validationError(res, `${unknown.join(', ')} is not a placeholder this stack version fills.`);
        }
        const problem = parserProblem(engine, config);
        if (problem) return validationError(res, problem);

        const previous = configs.get(profile.name) ?? null;
        store(profile, config, null);
        deploy(profile);
        watchAfter(profile, engine, previous, config);
        send(res, 202, profile);
      }),
    ],
    [
      'DELETE',
      /^\/profiles\/([^/]+)\/engine-config$/,
      withProfile((_req, res, profile) => {
        const engine = engineOf(profile);
        if (!engine) return validationError(res, `${profile.name} runs no media server, so it has no engine config.`);
        if (profile.has_engine_config) {
          store(profile, null, null);
          deploy(profile);
        }
        send(res, 202, profile);
      }),
    ],
  ];
}
