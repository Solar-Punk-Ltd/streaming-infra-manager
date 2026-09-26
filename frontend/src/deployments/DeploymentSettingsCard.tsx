import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import { DeploymentSettingsEditor } from './settings/DeploymentSettingsEditor';

export const DEPLOYMENT_SETTINGS_ANCHOR = 'stack-settings';

/**
 * The deployment page's frame around its settings editor. The editor carries
 * everything, so moving it to a page or a tab of its own changes this file
 * and the one that mounts it, and nothing else.
 */
export function DeploymentSettingsCard({ profile }: { profile: Profile }) {
  return (
    <SectionCard id={DEPLOYMENT_SETTINGS_ANCHOR} title="Stack settings" sub="this deployment's own values">
      <DeploymentSettingsEditor profile={profile} />
    </SectionCard>
  );
}
