import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type EngineName,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import { placeholdersFilledBy } from './placeholders.js';

const TEMPLATE_PATHS: Record<EngineName, string> = {
  [SRS_SERVICE]: join('engines', 'srs', 'srs.conf.template'),
  [OME_SERVICE]: join('engines', 'ome', 'Server.xml.template'),
};

const ENTRYPOINT_PATHS: Record<EngineName, string> = {
  [SRS_SERVICE]: join('engines', 'srs', 'entrypoint.sh'),
  [OME_SERVICE]: join('engines', 'ome', 'entrypoint.sh'),
};

export interface EngineTemplate {
  /** The template as the version ships it, placeholders and all. */
  text: string;
  /** The tokens the version's entrypoint fills. */
  placeholders: string[];
}

/**
 * The template and the entrypoint of one engine in one version's checkout.
 *
 * Read from the checkout every time rather than cached: an Update of the
 * version replaces both files, and the editor has to open on what the next
 * container start will run.
 */
export function engineTemplateIn(root: string, engine: EngineName): EngineTemplate {
  const templatePath = join(root, TEMPLATE_PATHS[engine]);
  if (!existsSync(templatePath)) {
    throw new Error(
      `${templatePath} is missing, so this version has no ${engine} template to start from.`,
    );
  }
  const entrypointPath = join(root, ENTRYPOINT_PATHS[engine]);
  const entrypoint = existsSync(entrypointPath)
    ? readFileSync(entrypointPath, 'utf8')
    : '';
  return {
    text: readFileSync(templatePath, 'utf8'),
    placeholders: placeholdersFilledBy(entrypoint),
  };
}

/**
 * The template's text, or null where the checkout has none.
 *
 * For the readers of a deployment's settings, which take null and report it
 * per field, rather than a missing template failing the whole overview.
 */
export function engineTemplateTextIn(root: string, engine: EngineName): string | null {
  try {
    return engineTemplateIn(root, engine).text;
  } catch {
    return null;
  }
}
