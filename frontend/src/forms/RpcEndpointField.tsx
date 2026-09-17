import { TextField } from '@mui/material';

import {
  type ConfiguredBeeRpcEndpoint,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  defaultServicesFor,
  effectiveNodeMode,
  MANAGER_RPC_ENDPOINT_SOURCE,
  type RpcEndpointSource,
  rpcEndpointChoiceProblem,
  STACK_RPC_ENDPOINT_SOURCE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import type { Profile } from '../types';
import { ChoiceGroup, type Choice } from './ChoiceGroup';
import type { DeploymentEdits } from './deploymentEdits';
import { FormField } from './FormField';

const STACK_DETAIL =
  'The public Gnosis endpoint the stack version carries. It is shared by everyone and it rate-limits.';

const CUSTOM_DETAIL =
  'An endpoint of your own. One running on the server itself is reached at http://host.docker.internal:PORT.';

/**
 * Where a running deployment's Bee node reaches the chain.
 *
 * The same three sources the wizard offers, so a deployment is edited in the
 * words it was created in. A source the shared rule refuses is shown with its
 * reason rather than left out unexplained, and the manager's own endpoint is
 * absent where there is none to offer.
 */
export function RpcEndpointField({
  profile,
  edits,
  managerEndpoint,
  onChange,
}: {
  profile: Profile;
  edits: DeploymentEdits;
  managerEndpoint: ConfiguredBeeRpcEndpoint;
  onChange: (patch: Partial<DeploymentEdits>) => void;
}) {
  const refusalOf = (source: RpcEndpointSource) =>
    rpcEndpointChoiceProblem({
      source,
      url: '',
      managerHasEndpoint: managerEndpoint.configured,
      nodeMode: effectiveNodeMode(profile),
      services: defaultServicesFor(profile),
    });
  const stackRefusal = refusalOf(STACK_RPC_ENDPOINT_SOURCE);
  const ours: Choice<RpcEndpointSource>[] = managerEndpoint.configured
    ? [
        {
          value: MANAGER_RPC_ENDPOINT_SOURCE,
          title: "Manager's endpoint",
          detail: managerEndpoint.host ?? 'the one this manager is configured with',
        },
      ]
    : [];

  return (
    <FormField label="RPC endpoint" labelId="edit-rpc-label">
      <ChoiceGroup<RpcEndpointSource>
        name="edit-rpc-endpoint"
        labelledBy="edit-rpc-label"
        value={edits.rpcEndpointSource}
        onChange={(rpcEndpointSource) => onChange({ rpcEndpointSource })}
        choices={[
          ...ours,
          {
            value: STACK_RPC_ENDPOINT_SOURCE,
            title: 'Stack default',
            detail: stackRefusal ?? STACK_DETAIL,
            disabled: stackRefusal !== null,
          },
          {
            value: CUSTOM_RPC_ENDPOINT_SOURCE,
            title: 'Custom',
            detail: CUSTOM_DETAIL,
            extra: (
              <TextField
                size="small"
                fullWidth
                value={edits.rpcEndpoint}
                onChange={(event) => onChange({ rpcEndpoint: event.target.value })}
                placeholder="https://rpc.example.org"
                inputProps={{
                  style: { fontFamily: MONO_STACK },
                  'aria-label': 'Custom RPC endpoint',
                }}
              />
            ),
          },
        ]}
      />
    </FormField>
  );
}
