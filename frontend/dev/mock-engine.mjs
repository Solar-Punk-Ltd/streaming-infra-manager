/**
 * The engine card's five routes, for the mock manager.
 *
 * They behave the way `manager/src/api/routes/engine.ts` behaves: the settings
 * are validated with the same shared rules, saving them moves the deployment
 * through DEPLOYING and back, a restart changes nothing but the container's own
 * clock, and the live block is null with the reason the real manager gives.
 *
 * The logs and the config are generated rather than canned, so the config tab
 * shows the values that were just saved and a restart is visible in the log
 * timestamps. That is the whole point of being able to click it offline.
 */
import {
  BEE_UPLOADER_SERVICE,
  containerNotRunningMessage,
  defaultServicesFor,
  effectiveEngineDefaults,
  effectiveEngineSettings,
  engineOfServices,
  engineSettingsFieldsFor,
  engineSettingsProblem,
  hasBeePublishers,
  liveUnavailableReason,
  OME_SERVICE,
  RESTARTABLE_SERVICES,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { send, sendText } from './mock-http.mjs';
import { contractOfVersion } from './mock-versions.mjs';

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;

/** When each container last came up, so a restart shows in its log. */
const startedAt = new Map();

function containerStartedAt(profileName, service) {
  const key = `${profileName}/${service}`;
  let at = startedAt.get(key);
  if (!at) {
    at = Date.now() - 3 * 60 * 60 * 1000;
    startedAt.set(key, at);
  }
  return at;
}

function engineFacts(profile) {
  const engine = engineOfServices(defaultServicesFor(profile));
  return { engine, abr: hasBeePublishers(profile) };
}

/**
 * The mock's stand-in for the deploy host's base `.env`.
 *
 * The manager reads the real one. A deploy server usually carries a value or
 * two set on the box by hand, and `.env.<profile>` is a copy of that file with
 * the unset keys left out, so those values are what the container starts with.
 * One key is set here so the drawer's "set on this host" wording is on screen
 * offline as well.
 */
const HOST_BASE_ENV = { HLS_FRAGMENT: '2' };

/** What an unset setting falls back to for this deployment: the host's value, else its version's. */
function hostDefaults(engine, profile) {
  const contract = contractOfVersion(profile.stack_version_id);
  return effectiveEngineDefaults(
    engine,
    HOST_BASE_ENV,
    contract?.engineDefaults ?? {},
  );
}

function noEngine(res, profile) {
  return send(res, 400, {
    error: 'validation_error',
    errors: [
      `${profile.name} runs no media server, so it has no engine settings. Only a stream or an ABR uploader has them.`,
    ],
  });
}

// ------------------------------------------------------------ generated text

const LOG_LINES = {
  [SRS_SERVICE]: [
    'srs.conf generated from template',
    'SRS/6.0.145 starting, pid=1',
    'listening on udp 10080 for SRT',
    'http_api listening on 1985',
    'hls handler ready, writing to ./objs/nginx/html',
  ],
  [OME_SERVICE]: [
    'Server.xml generated from template',
    'OvenMediaEngine v0.17 starting',
    'SRT provider bound to 10080',
    'LLHLS publisher ready',
  ],
  [STREAM_UPLOADER_SERVICE]: [
    'config loaded, engine plugin ready',
    'watching /media for new segments',
    'uploaded segment 000142 in 380 ms',
    'feed updated at index 142',
  ],
  [BEE_UPLOADER_SERVICE]: [
    'bee 2.8.1 starting',
    'connected to 68 peers',
    'postage batch usable',
    'chunk synced',
  ],
};

function generateLogs(profile, service, tail) {
  const template = LOG_LINES[service] ?? ['container running'];
  const start = containerStartedAt(profile.name, service);
  const wanted = Math.min(Math.max(tail, 1), MAX_LOG_LINES);

  return Array.from({ length: wanted }, (_value, index) => {
    const at = new Date(start + index * 1000).toISOString();
    return `${at} ${template[index % template.length]}`;
  }).join('\n');
}

function srsConf(settings) {
  return [
    'listen              1935;',
    'max_connections     1000;',
    'daemon              off;',
    '',
    'http_api {',
    '    enabled         on;',
    '    listen          1985;',
    '}',
    '',
    'srt_server {',
    '    enabled         on;',
    '    listen          10080;',
    '    latency         200;',
    '}',
    '',
    'vhost __defaultVhost__ {',
    '    hls {',
    '        enabled         on;',
    `        hls_fragment    ${settings.HLS_FRAGMENT};`,
    `        hls_window      ${settings.HLS_WINDOW};`,
    '    }',
    '}',
  ].join('\n');
}

function serverXml(settings) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Server version="8">',
    '  <Applications>',
    '    <Application>',
    '      <Publishers>',
    '        <LLHLS>',
    `          <SegmentDuration>${settings.HLS_SEGMENT_DURATION}</SegmentDuration>`,
    `          <SegmentCount>${settings.HLS_SEGMENT_COUNT}</SegmentCount>`,
    '        </LLHLS>',
    '      </Publishers>',
    '    </Application>',
    '  </Applications>',
    '</Server>',
  ].join('\n');
}

// ----------------------------------------------------------------- the routes

/**
 * @param deps.readBody  reads a JSON request body
 * @param deps.withProfile wraps a handler so the 404 is written once
 * @param deps.deploy    the mock's own DEPLOYING then RUNNING transition
 * @param deps.publish   writes an event to every open SSE client
 */
export function engineRoutes({ readBody, withProfile, deploy, publish }) {
  return [
    [
      'GET',
      /^\/profiles\/([^/]+)\/engine$/,
      withProfile((_req, res, profile) => {
        const { engine, abr } = engineFacts(profile);
        if (!engine) return noEngine(res, profile);
        const defaults = hostDefaults(engine, profile);
        send(res, 200, {
          engine,
          abr,
          settings: profile.engine_settings,
          defaults: defaults.values,
          defaultSources: defaults.sources,
          fields: engineSettingsFieldsFor(engine, { abr }),
          live: null,
          liveUnavailableReason: liveUnavailableReason(
            engine,
            contractOfVersion(profile.stack_version_id)?.features,
          ),
        });
      }),
    ],
    [
      'PUT',
      /^\/profiles\/([^/]+)\/engine-settings$/,
      withProfile(async (req, res, profile) => {
        const { engine, abr } = engineFacts(profile);
        if (!engine) return noEngine(res, profile);

        const settings = await readBody(req);
        const problem = engineSettingsProblem(engine, settings, {
          abr,
          defaults: hostDefaults(engine, profile).values,
        });
        if (problem) {
          return send(res, 400, {
            error: 'validation_error',
            errors: [problem],
          });
        }

        profile.engine_settings = settings;
        startedAt.set(`${profile.name}/${engine}`, Date.now());
        deploy(profile);
        send(res, 202, profile);
      }),
    ],
    [
      'POST',
      /^\/profiles\/([^/]+)\/containers\/([^/]+)\/restart$/,
      withProfile((_req, res, profile, [, service]) => {
        if (!RESTARTABLE_SERVICES.includes(service)) {
          return send(res, 400, {
            error: 'validation_error',
            errors: [
              `${service} cannot be restarted on its own. ` +
                `Pick one of ${RESTARTABLE_SERVICES.join(', ')}, or stop and start the whole deployment.`,
            ],
          });
        }
        if (!profile.containers.some((entry) => entry.service === service)) {
          return send(res, 409, {
            error: 'container_not_running',
            name: profile.name,
            service,
            message: containerNotRunningMessage(profile.name, service),
          });
        }

        startedAt.set(`${profile.name}/${service}`, Date.now());
        publish({
          type: 'engine.restarted',
          profile: profile.name,
          service,
        });
        send(res, 202, { status: 'accepted', name: profile.name, service });
      }),
    ],
    [
      'GET',
      /^\/profiles\/([^/]+)\/containers\/([^/]+)\/logs$/,
      withProfile((req, res, profile, [, service]) => {
        if (!profile.containers.some((entry) => entry.service === service)) {
          return send(res, 409, {
            error: 'container_not_running',
            name: profile.name,
            service,
            message: containerNotRunningMessage(profile.name, service),
          });
        }
        const tail = Number(
          new URL(req.url, 'http://mock').searchParams.get('tail') ??
            DEFAULT_LOG_LINES,
        );
        sendText(res, 200, generateLogs(profile, service, tail));
      }),
    ],
    [
      'GET',
      /^\/profiles\/([^/]+)\/engine\/config$/,
      withProfile((_req, res, profile) => {
        const { engine } = engineFacts(profile);
        if (!engine) return noEngine(res, profile);
        if (!profile.containers.some((entry) => entry.service === engine)) {
          return send(res, 409, {
            error: 'container_not_running',
            name: profile.name,
            service: engine,
            message: containerNotRunningMessage(profile.name, engine),
          });
        }

        const settings = effectiveEngineSettings(
          engine,
          profile.engine_settings,
          hostDefaults(engine, profile).values,
        );
        sendText(
          res,
          200,
          engine === OME_SERVICE ? serverXml(settings) : srsConf(settings),
          { 'cache-control': 'no-store' },
        );
      }),
    ],
  ];
}
