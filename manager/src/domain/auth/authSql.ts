/**
 * Advisory-lock key guarding user removal. ASCII "user".
 *
 * Removing a user has to read how many are left and delete in one step, or two
 * browsers each removing the other both see two users and both delete, leaving
 * a manager nobody can sign in to. Same shape as PROFILE_SLOT_LOCK_KEY, which
 * guards port-slot allocation for the same reason.
 */
export const USER_REMOVAL_LOCK_KEY = 0x75736572;
