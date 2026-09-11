/**
 * The engine routes on a random port, with the profile service and the Docker
 * client stood in for. What is and is not mounted: see routerTestApp.ts.
 */
import { createEngineRouter } from '../../src/api/routes/engine.js';
import type { ContainerControl } from '../../src/domain/ContainerControl.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';

import {
  call,
  startRouterTestApp,
  type RouterCall,
  type RouterTestApp,
} from './routerTestApp.js';

export type EngineTestApp = RouterTestApp;
export type EngineCall = RouterCall;

export function startEngineTestApp(
  profileService: ProfileService,
  containers: ContainerControl,
): Promise<EngineTestApp> {
  return startRouterTestApp(createEngineRouter(profileService, containers));
}

export const callEngine = call;
