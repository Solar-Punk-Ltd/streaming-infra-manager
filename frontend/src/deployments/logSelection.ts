export function initialLogService(services: readonly string[], engine: string | null, requested?: string): string | null {
  if (requested && services.includes(requested)) return requested;
  if (engine && services.includes(engine)) return engine;
  return services[0] ?? null;
}
