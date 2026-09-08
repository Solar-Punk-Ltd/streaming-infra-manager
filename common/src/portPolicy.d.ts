export const MANAGER_SLOT_CAP: number;
export const PORT_SLOT_STRIDE: number;
export const PROTECTED_PORT_MIN: number;
export const PROTECTED_PORT_MAX: number;
export const PORT_POLICY_VERSION: number;
export const OME_PORT_SOURCES: Readonly<Record<string, string>>;

export interface ExposureEntry {
  port: number;
  protocol: string;
  portVar: string;
  service: string | null;
}

export interface PublicPortRole {
  aliases?: readonly { portVar: string; service: string }[];
  group: string;
  protocol: string;
  base: number;
  maxSlot: number;
  portVar: string;
  service: string;
}

export const PUBLIC_PORT_ROLES: readonly PublicPortRole[];
export function publicPortRole(entry: Pick<ExposureEntry, 'port' | 'protocol'>): PublicPortRole | null;
export function portExposureProblem(entry: ExposureEntry): string | null;
