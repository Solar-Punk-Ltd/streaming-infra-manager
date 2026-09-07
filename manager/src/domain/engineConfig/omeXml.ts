/**
 * Whether a Server.xml is well formed enough for OvenMediaEngine to read it.
 *
 * OME has no test mode, so this is the check that runs before the container
 * does: balanced, properly nested tags, nothing left open at the end, and the
 * one element the stack cannot admit a publisher without. A file that passes
 * can still be refused by OME for its content, which the twenty second watch
 * after the recreate is for.
 */

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)([^<>]*?)(\/?)>/g;

/** The element the uploader admits publishers through. Without it nothing is ever admitted. */
const ADMISSION_ELEMENT = 'AdmissionWebhooks';

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** The declaration, comments and CDATA blanked out, offsets kept. */
function withoutMarkupNoise(text: string): string {
  return text.replace(
    /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g,
    (match) => ' '.repeat(match.length),
  );
}

/** Why OvenMediaEngine would not read this file, in one sentence, or null. */
export function omeXmlProblem(text: string): string | null {
  const body = withoutMarkupNoise(text);
  const open: { name: string; line: number }[] = [];
  let sawRoot = false;

  for (const match of body.matchAll(TAG_RE)) {
    const [, closing, name, , selfClosing] = match;
    const line = lineOf(body, match.index ?? 0);
    if (closing) {
      const last = open.pop();
      if (!last) return `Line ${line}: </${name}> closes nothing.`;
      if (last.name !== name) {
        return `Line ${line}: </${name}> closes <${last.name}> opened on line ${last.line}.`;
      }
      continue;
    }
    sawRoot = true;
    if (!selfClosing) open.push({ name: name!, line });
  }

  const stray = /<(?![A-Za-z_/!?])/.exec(body);
  if (stray) {
    return `Line ${lineOf(body, stray.index)}: a bare < that starts no tag. Write &lt; for a literal one.`;
  }
  if (!sawRoot) return 'The file has no XML element in it.';
  const unclosed = open[open.length - 1];
  if (unclosed) {
    return `<${unclosed.name}> opened on line ${unclosed.line} is never closed.`;
  }
  if (!new RegExp(`<${ADMISSION_ELEMENT}[\\s>]`).test(body)) {
    return `The file has no <${ADMISSION_ELEMENT}> element. The stack's uploader admits every publisher through it, so without one nothing is ever admitted.`;
  }
  return null;
}
