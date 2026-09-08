import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, CssBaseline, ThemeProvider, Typography } from '@mui/material';
import { theme } from '../src/app/theme';
import { DeploymentsProvider, type DeploymentsStore } from '../src/app/useDeploymentsStore';
import { SessionProvider, type SessionStore } from '../src/app/useSession';
import { StorageCard } from '../src/deployments/StorageCard';
import type { Profile } from '../src/types';
import type { BeeUtils } from '../src/uploaders/useBeeUtils';
import { setSessionEndedHandler } from '../src/http';
import { stampHealthFrom } from '@streaming-infra-manager/common';

declare global {
  interface Window { t09Ui: { account(id: number | null): void; profile(value: Profile): void; balances(available: boolean): void; refresh(): void } }
}

function Fixture() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<number | null>(7);
  const [balances, setBalances] = useState(true);
  const [, refresh] = useState(0);
  useEffect(() => {
    void fetch('/profiles/synthetic-test', { cache: 'no-store' }).then(response => response.json()).then(setProfile);
    setSessionEndedHandler(() => setAccount(null));
    return () => setSessionEndedHandler(null);
  }, []);
  window.t09Ui = { account: setAccount, profile: setProfile, balances: setBalances, refresh: () => refresh(value => value + 1) };
  const session: SessionStore = { state: account === null ? { status: 'signedOut', reason: 'ended' } : { status: 'signedIn', id: account,
    username: `operator-${account}`, isAdmin: false, expiresAt: '2099-01-01T00:00:00.000Z' }, signIn: async () => ({ ok: false, message: 'Offline fixture' }), signOut: async () => setAccount(null) };
  const deployments = { chequebookFloorBzz: '0.5' } as DeploymentsStore;
  const bee = { address: null, wallet: balances ? { bzzBalance: '20000000000000000', nativeTokenBalance: '1000000000000000' } : null,
    chequebook: balances ? { address: `0x${'22'.repeat(20)}`, availableBalance: '10000000000000000', totalBalance: '10000000000000000', totalSent: '0', totalReceived: '0' } : null,
    chainState: null, stamps: [], loading: false, loadError: balances ? null : 'The synthetic balance read failed.', waitingBatch: null,
    reload: async () => refresh(value => value + 1), waitForStamp() {} } as BeeUtils;
  return <SessionProvider value={session}><DeploymentsProvider value={deployments}>
    <Box sx={{ maxWidth: 850, mx: 'auto', p: 2 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>Offline transfer fixture</Typography>
      {profile && <StorageCard profile={profile} bee={bee} stampHealth={stampHealthFrom(null, null)} chequebookHealth={null} onChanged={() => {}} />}
    </Box>
  </DeploymentsProvider></SessionProvider>;
}

createRoot(document.querySelector('#root')!).render(<StrictMode><ThemeProvider theme={theme}><CssBaseline /><Fixture /></ThemeProvider></StrictMode>);
