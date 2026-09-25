import { useEffect, useState } from 'react';

import {
  STREAM_UPLOADER_SERVICE,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { isRunning } from './shape';
import { fetchUploaderHealth } from './uploaderHealthApi';

/** What each deployment's uploader said about itself, through the manager, by profile name. */
export type UploaderHealths = ReadonlyMap<string, UploaderHealthReading>;

/**
 * How often the readings are taken again while the page stays open.
 *
 * The chequebook's cadence rather than the deployment page's ten seconds: a
 * list asks every uploader on the manager at once, and each read costs the
 * manager a request to that uploader. A wait that ends, or a reason the
 * uploader latches, still reaches the list within half a minute.
 */
const REFRESH_MS = 30_000;

const NAME_SEPARATOR = ',';

function runsUploader(profile: Profile): boolean {
  return profile.containers.some(
    (container) => container.service === STREAM_UPLOADER_SERVICE,
  );
}

/**
 * Which deployments a list can ask about their uploader: running ones with a
 * stream-uploader container, which covers streams and ABR uploaders alike.
 *
 * One without the container has nothing to ask, the manager would only answer
 * that nothing is deployed, and a stopped one has nothing listening.
 */
export function askableUploaders(profiles: Profile[] | null): string[] {
  return (profiles ?? [])
    .filter((profile) => isRunning(profile) && runsUploader(profile))
    .map((profile) => profile.name);
}

/**
 * What a round of answers is worth, with the reads that failed left out.
 *
 * A failed read is the manager not answering, which says nothing about the
 * uploader, so the list goes on judging that deployment by its container, as
 * it did before it asked. An uploader that did not answer the manager is a
 * reading, `unreachable`, and is kept.
 */
export function uploaderHealthsFrom(
  answers: readonly (readonly [string, UploaderHealthReading | null])[],
): UploaderHealths {
  return new Map(
    answers.filter(
      (answer): answer is readonly [string, UploaderHealthReading] =>
        answer[1] !== null,
    ),
  );
}

/**
 * Ask every running uploader what it says about itself, for the pages that
 * list many deployments at once.
 *
 * One effect rather than a hook per row, for the reason `useChequebookHealths`
 * gives: the list changes as deployments come and go, and hooks cannot be
 * called in a loop that varies. The same route the deployment page reads,
 * `GET /profiles/:name/uploader-health`.
 */
export function useUploaderHealths(profiles: Profile[] | null): UploaderHealths {
  const [healths, setHealths] = useState<UploaderHealths>(new Map());
  const askKey = askableUploaders(profiles).join(NAME_SEPARATOR);

  useEffect(() => {
    const names = askKey ? askKey.split(NAME_SEPARATOR) : [];
    let cancelled = false;
    const controller = new AbortController();

    const askEveryone = async () => {
      const answers = await Promise.all(
        names.map(async (name) => {
          try {
            return [name, await fetchUploaderHealth(name, controller.signal)] as const;
          } catch {
            return [name, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setHealths(uploaderHealthsFrom(answers));
    };

    void askEveryone();
    const timer = setInterval(() => void askEveryone(), REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [askKey]);

  return healths;
}
