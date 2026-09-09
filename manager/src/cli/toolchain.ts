export const TOOLCHAIN_FLAG = '--toolchain';

const MAX_TOOLCHAIN_LENGTH = 256;
/** Letters, digits, spaces and the punctuation a version string needs. Nothing a shell reads as syntax. */
const TOOLCHAIN = /^[A-Za-z0-9 ._/+-]+$/;

/**
 * Refuses a toolchain description a host shell would read as more than one
 * word.
 *
 * The deploy puts this value into a single-quoted argument inside a remote
 * script, so one quote in it would end that argument and leave the rest of the
 * string to the shell. It is checked on the laptop where it is written and
 * again on the host that runs with it, because neither side may assume the
 * other looked.
 */
export function assertToolchain(value: string): void {
  if (!value.trim() || value.length > MAX_TOOLCHAIN_LENGTH || !TOOLCHAIN.test(value)) {
    throw new Error(`${TOOLCHAIN_FLAG} must name what built the stack in at most ${MAX_TOOLCHAIN_LENGTH} characters, written with letters, digits, spaces and any of . _ / + and -, and spaces alone name nothing`);
  }
}
