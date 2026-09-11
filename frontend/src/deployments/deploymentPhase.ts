import type { Profile } from '../types';

export function deploymentProgressText(profile: Profile): string {
  switch (profile.status) {
    case 'DEPLOYING': {
      const phase = profile.deployment_phase === 'starting' ? 'Starting' : profile.deployment_phase === 'restarting' ? 'Restarting' : 'Deploying';
      return `${phase}. Ingest and current container state are not yet verified. Previous observations may describe the earlier deployment.`;
    }
    case 'STOPPING': return 'Stopping. Ingest and current container state are not yet verified.';
    case 'REMOVING': return 'Removing. Ingest and current container state are not yet verified.';
    case 'ERROR': return 'The last deployment action failed. Check the container logs for its current state.';
    case 'STOPPED': return 'The deployment is stopped. Start it, then publish to this URL.';
    default: return 'Containers are reported running. Receiving, uploading and playback are not verified.';
  }
}
