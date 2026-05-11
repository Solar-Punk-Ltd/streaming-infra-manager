import { array, object, string, InferType } from 'yup';

import { ALL_SERVICES } from '../types.js';

const serviceList = array()
  .of(string().required().oneOf([...ALL_SERVICES], 'unknown service'))
  .notRequired();

export const deployBodySchema = object({
  services: serviceList,
}).noUnknown(true);

export const stopBodySchema = object({
  services: serviceList,
}).noUnknown(true);

export type DeployBody = InferType<typeof deployBodySchema>;
export type StopBody = InferType<typeof stopBodySchema>;
