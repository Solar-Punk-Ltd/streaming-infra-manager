import { useEffect, useRef, useState } from 'react';
import type { UploaderLifecycleReading } from '@streaming-infra-manager/common';
import { getJson } from '../http';
import type { Profile } from '../types';

/** Reads only the current deployment identity and discards superseded polls. */
export function useUploaderLifecycle(profile: Profile | null, enabled: boolean): UploaderLifecycleReading | undefined {
  const [reading, setReading] = useState<UploaderLifecycleReading>();
  const revision = useRef(0);
  useEffect(() => {
    ++revision.current;
    if (!profile || !enabled) { setReading(undefined); return; }
    const controller = new AbortController();
    const read = () => {
      const request = ++revision.current;
      return getJson<UploaderLifecycleReading>(`/profiles/${encodeURIComponent(profile.name)}/uploader-lifecycle`, { signal: controller.signal })
        .then(result => { if (revision.current === request) setReading(result); })
        .catch(() => { if (revision.current === request) setReading({ state: 'unavailable' }); });
    };
    void read();
    const timer = setInterval(read, 10_000);
    return () => { ++revision.current; clearInterval(timer); controller.abort(); };
  }, [profile?.instance_id, profile?.name, enabled]);
  return reading;
}
