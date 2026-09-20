import { useEffect, useState } from 'react';

import { LifecycleCard } from '../../../src/deployments/LifecycleCard';
import {
  type UploaderLifecyclePollingPolicy,
  useUploaderLifecycle,
} from '../../../src/deployments/useUploaderLifecycle';
import type { Profile } from '../../../src/types';

const POLLING_POLICY: UploaderLifecyclePollingPolicy = {
  pollEveryMs: 100,
  staleAfterMs: 400,
};

function profile(name: string, instanceId: string): Profile {
  return {
    name,
    instance_id: instanceId,
    port_slot: 1,
    kind: 'custom',
    notes: null,
    notes_revision: 0,
    has_private_key: false,
    has_rpc_endpoint: false,
    has_srt_passphrase: false,
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    engine_config_state: null,
    engine_config_revision: 0,
    intent_revision: 0,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    last_full_deploy_commit: null,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    containers: [],
  };
}

interface LifecycleTestControl {
  select(name: string, instanceId: string): void;
  setAdminConsoleUrl(value: string | null): void;
  unmount(): void;
}

declare global {
  interface Window {
    lifecycleTest?: LifecycleTestControl;
  }
}

function Reading({ selected, adminConsoleUrl }: {
  selected: Profile;
  adminConsoleUrl: string | null;
}) {
  const reading = useUploaderLifecycle(selected, true, POLLING_POLICY);
  return (
    <LifecycleCard
      reading={reading}
      adminConsoleUrl={adminConsoleUrl}
    />
  );
}

export function App() {
  const [selected, setSelected] = useState(() => profile('alpha', 'alpha-1'));
  const [adminConsoleUrl, setAdminConsoleUrl] = useState<string | null>(null);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    window.lifecycleTest = {
      select(name, instanceId) {
        setSelected(profile(name, instanceId));
        setMounted(true);
      },
      setAdminConsoleUrl,
      unmount() {
        setMounted(false);
      },
    };
    return () => {
      delete window.lifecycleTest;
    };
  }, []);

  return mounted ? (
    <Reading selected={selected} adminConsoleUrl={adminConsoleUrl} />
  ) : (
    <p>Lifecycle test unmounted.</p>
  );
}
