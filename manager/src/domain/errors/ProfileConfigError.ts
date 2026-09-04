/**
 * A profile whose upload destination does not make sense.
 *
 * Raised by ProfileService when `beeTargetProblem` rejects the *resulting*
 * profile — the state after a create body or a full-replace update is applied,
 * which is the only place the rule can be evaluated: `PUT /profiles/:name`
 * carries neither `kind` nor `components`, so the equivalent per-field yup
 * tests on `createProfileSchema` cannot see enough to fire on update.
 *
 * Mapped to 400 with the same shape as a schema validation error, because from
 * the caller's side that is exactly what it is.
 */
export class ProfileConfigError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'ProfileConfigError';
  }
}
