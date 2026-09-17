import { useEffect, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Button, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { chequebookHealthFromPayload, type LadderRungState, sameBatchId, stampHealthFrom } from '@streaming-infra-manager/common';
import { buildChecklist, firstBlocker } from '../../../deployments/checklist';
import { useBeePublishers } from '../../../groups/useBeePublishers';
import { beeReadinessView } from '../../../uploaders/beeReadiness';
import { useBeeUtils } from '../../../uploaders/useBeeUtils';
import type { Profile } from '../../../types';
import { matchingPool } from '../poolIdentity';
import { probedRungUrl, rungPublishingSummary } from '../rungPublishing';
import type { WizardContext } from '../wizardState';

export function PoolPrerequisites({ poolId, context }: { poolId: number; context: WizardContext }) {
  const [refresh, setRefresh] = useState(0);
  const members = context.profiles.filter(profile => profile.group_id === poolId);
  const publishers = useBeePublishers(poolId, members.map(member => `${member.name}:${member.stamp_id ?? ''}:${member.status}`).join('|'));
  const reloadPublishers = publishers.reload;
  useEffect(() => { if (refresh > 0) void reloadPublishers(); }, [refresh, reloadPublishers]);
  const group = context.groups.find(group => group.id === poolId);
  const pool = group ? matchingPool({ group, profiles: members }, group.name) : null;
  if (!pool) return <Alert severity="warning">The selected pool is not available with all compatible members. Check the deployment list or choose another pool.</Alert>;
  return <Stack spacing={1}>
    <Typography variant="subtitle2">Storage pool checks</Typography>
    <Typography variant="body2" color="text.secondary">These checks report each node’s current observations, and the manager probes each rung’s publishing address itself. Funding and postage checks do not prevent saving a valid uploader configuration.</Typography>
    <Button onClick={() => setRefresh(value => value + 1)}>Refresh pool checks</Button>
    {pool.profiles.map(profile => <PoolMemberChecks key={`${poolId}:${profile.name}:${profile.created_at}`} profile={profile}
      rungState={publishers.result?.rungs.find(entry => entry.name === profile.name) ?? null} refresh={refresh} />)}
  </Stack>;
}

function PoolMemberChecks({ profile, rungState, refresh }: { profile: Profile; rungState: LadderRungState | null; refresh: number }) {
  const bee = useBeeUtils(profile);
  useEffect(() => { if (refresh > 0) void bee.reload(); }, [refresh, bee.reload]);
  const observed = beeReadinessView(bee.nodeObservation, bee.observationNow, bee.loading || profile.status !== 'RUNNING', bee.observationReceivedAt);
  const current = observed.state === 'ready';
  const stampId = profile.stamp_id;
  const stampHealth = stampHealthFrom(stampId, current ? bee.stamps : null);
  const steps = buildChecklist({ profile, nodeReadiness: observed, wallet: current ? bee.wallet : null,
    chequebook: current && bee.chequebook ? chequebookHealthFromPayload(bee.chequebook.health) : null,
    nodeAddress: bee.address?.ethereum ?? null, stampHealth,
    currentStamp: (current && stampId && bee.stamps?.find(stamp => sameBatchId(stamp.batchID, stampId))) || null,
    publishUrl: null, clientUrl: null, streamers: [] });
  const first = firstBlocker(steps);
  return <Accordion disableGutters>
    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{profile.name}</Typography>
        <Typography variant="body2">{first?.problem ?? first?.title ?? rungPublishingSummary(rungState)}</Typography>
        <Typography variant="caption" color="text.secondary">{[...steps.slice(1).map(step => step.state === 'ok' ? step.title : step.problem ?? step.title), probedRungUrl(rungState)].filter(Boolean).join(' · ')}</Typography>
      </Stack>
    </AccordionSummary>
    <AccordionDetails>
      <Stack spacing={1}>
        {steps.map(step => <Stack key={step.title}>
          <Typography variant="body2" fontWeight={600}>{step.title}: {step.problem && step.state !== 'ok' ? step.problem : step.state === 'ok' ? 'Checked' : 'Not checked'}</Typography>
          <Typography variant="body2" color="text.secondary">{step.problem === 'Needs a stamp' ? 'A stamp is prepaid Swarm storage. Fund the node, then buy and set its stamp from the node’s deployment page.' : step.detail}</Typography>
        </Stack>)}
      </Stack>
    </AccordionDetails>
  </Accordion>;
}
