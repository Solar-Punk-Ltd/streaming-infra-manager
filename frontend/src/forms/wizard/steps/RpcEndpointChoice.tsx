import { TextField } from '@mui/material';

import {
  CUSTOM_RPC_ENDPOINT_SOURCE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  type RpcEndpointSource,
  rpcEndpointChoiceProblem,
  STACK_RPC_ENDPOINT_SOURCE,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import { ChoiceGroup, type Choice } from '../../ChoiceGroup';
import { FormField } from '../../FormField';
import { rpcEndpointError } from '../wizardError';
import {
  chosenNodeMode,
  nodeServices,
  offersRpcEndpoint,
  type WizardStepProps,
} from '../wizardState';

const LABEL = 'RPC endpoint';

const STACK_DETAIL =
  'The public Gnosis endpoint the stack ships with. It is shared by everyone and it rate-limits.';

const CUSTOM_DETAIL =
  'An endpoint of your own. One running on the server itself is reached at http://host.docker.internal:PORT.';

/**
 * Where this deployment's Bee node reaches the chain.
 *
 * Offered only to a light node, because an ultra-light one reaches no chain at
 * all. The manager's own endpoint comes first whenever there is one, which is
 * the whole point of configuring one, and a source the shared rule refuses is
 * shown with its reason rather than left out unexplained.
 */
export function RpcEndpointChoice(props: WizardStepProps) {
  const { state, context, update } = props;
  if (!offersRpcEndpoint(state)) return null;

  const refusalOf = (source: RpcEndpointSource) =>
    rpcEndpointChoiceProblem({
      source,
      url: '',
      managerHasEndpoint: context.beeRpcEndpoint.configured,
      nodeMode: chosenNodeMode(state),
      services: nodeServices(state),
    });
  const stackRefusal = refusalOf(STACK_RPC_ENDPOINT_SOURCE);
  // Absent rather than disabled: a manager with no endpoint of its own has
  // nothing to offer here, and a greyed row would name a setting that is not
  // this deployment's to make.
  const ours: Choice<RpcEndpointSource>[] = context.beeRpcEndpoint.configured
    ? [
        {
          value: MANAGER_RPC_ENDPOINT_SOURCE,
          title: "Manager's endpoint",
          detail: context.beeRpcEndpoint.host ?? 'the one this manager is configured with',
        },
      ]
    : [];
  const choices: Choice<RpcEndpointSource>[] = [
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
          value={state.rpcEndpoint}
          onChange={(event) => update({ rpcEndpoint: event.target.value })}
          placeholder="https://rpc.example.org"
          inputProps={{
            style: { fontFamily: MONO_STACK },
            'aria-label': 'Custom RPC endpoint',
          }}
        />
      ),
    },
  ];

  return (
    <FormField label={LABEL} error={rpcEndpointError(state, context)} labelId="wizard-rpc-label">
      <ChoiceGroup<RpcEndpointSource>
        name="wizard-rpc-endpoint"
        labelledBy="wizard-rpc-label"
        value={state.rpcEndpointSource}
        onChange={(rpcEndpointSource) => update({ rpcEndpointSource })}
        choices={choices}
      />
    </FormField>
  );
}
