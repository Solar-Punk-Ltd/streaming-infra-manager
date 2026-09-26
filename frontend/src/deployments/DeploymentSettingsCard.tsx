import { useEffect } from 'react';

import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';
import { DeploymentSettingsEditor } from './settings/DeploymentSettingsEditor';
import type { SettingReveal } from './settings/SettingsList';

export const DEPLOYMENT_SETTINGS_ANCHOR = 'stack-settings';

/**
 * The deployment page's frame around its settings editor. The editor carries
 * everything, so moving it to a page or a tab of its own changes this file
 * and the one that mounts it, and nothing else. A request from elsewhere on
 * the page to show one setting brings the card into view at once, and the
 * editor scrolls to the setting and focuses it once its list is read and the
 * section holding it has opened.
 */
export function DeploymentSettingsCard({ profile, reveal = null }: { profile: Profile; reveal?: SettingReveal | null }) {
  useEffect(() => {
    if (reveal) document.getElementById(DEPLOYMENT_SETTINGS_ANCHOR)?.scrollIntoView({ block: 'start' });
  }, [reveal]);

  return (
    <SectionCard id={DEPLOYMENT_SETTINGS_ANCHOR} title="Stack settings" sub="this deployment's own values">
      <DeploymentSettingsEditor profile={profile} reveal={reveal} />
    </SectionCard>
  );
}
