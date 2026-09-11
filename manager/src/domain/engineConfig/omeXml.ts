/**
 * Whether a Server.xml is well formed, read the way a strict XML parser reads
 * it, and the tree it holds.
 *
 * OvenMediaEngine's own loader is lenient: checked on 2026-09-08 against
 * v0.21.0, it starts on a file with a second root element and on one with an
 * entity XML does not define, silently reading past both, and it exits on an
 * unquoted attribute. So the manager is the one that refuses a malformed
 * file, before the container ever sees it, with the line of the fault. A file
 * that is well formed is then held to the contract the version's template
 * sets, in omeContract.ts.
 */
import { SaxesParser } from 'saxes';

export interface OmeElement {
  name: string;
  line: number;
  /** The element's own text, CDATA included, trimmed. Empty for one that only holds children. */
  text: string;
  children: OmeElement[];
}

export type OmeParse = { root: OmeElement; problem: null } | { root: null; problem: string };

/**
 * What the operator did, in words, for the faults a strict parser names
 * tersely. `closed` is the element the parser had to close on its own just
 * before the fault, which for a mismatched closing tag is the one it does
 * not match.
 */
function describeFault(
  message: string,
  line: number,
  open: OmeElement | undefined,
  closed: OmeElement | undefined,
): string {
  if (/only one root/.test(message)) {
    return `Line ${line}: a second root element. An XML file has one root, and OvenMediaEngine reads only the first.`;
  }
  if (/undefined entity/.test(message)) {
    return `Line ${line}: an entity XML does not define. Write a literal & as &amp;.`;
  }
  if (/unquoted attribute/.test(message)) {
    return `Line ${line}: an attribute value without quotes.`;
  }
  if (/unexpected close tag/.test(message)) {
    return closed
      ? `Line ${line}: a closing tag that does not match <${closed.name}> opened on line ${closed.line}.`
      : `Line ${line}: a closing tag that closes nothing.`;
  }
  if (/disallowed character in tag name/.test(message)) {
    return `Line ${line}: a bare < that starts no tag. Write &lt; for a literal one.`;
  }
  if (/text data outside of root/.test(message)) {
    return `Line ${line}: text outside the root element.`;
  }
  if (/unclosed root tag|unclosed tag/i.test(message) && open) {
    return `<${open.name}> opened on line ${open.line} is never closed.`;
  }
  return `Line ${line}: ${message.replace(/\.$/, '')}.`;
}

export function parseOmeXml(text: string): OmeParse {
  const parser = new SaxesParser({ position: true });
  const stack: OmeElement[] = [];
  let root: OmeElement | null = null;
  let problem: string | null = null;
  let closed: OmeElement | undefined;

  parser.on('error', (err) => {
    if (problem === null) {
      problem = describeFault(err.message, parser.line, stack[stack.length - 1], closed);
    }
  });
  parser.on('opentag', (tag) => {
    const element: OmeElement = { name: tag.name, line: parser.line, text: '', children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root === null) root = element;
    stack.push(element);
  });
  parser.on('closetag', () => {
    closed = stack.pop();
    if (closed) closed.text = closed.text.trim();
  });
  const append = (chunk: string) => {
    const current = stack[stack.length - 1];
    if (current) current.text += chunk;
  };
  parser.on('text', append);
  parser.on('cdata', append);

  parser.write(text).close();

  // saxes reports an element left open and a document without a root itself
  // on close, so a null problem here means a whole tree under a root.
  if (problem !== null) return { root: null, problem };
  if (root === null) return { root: null, problem: 'The file has no XML element in it.' };
  return { root, problem: null };
}

/** Why a strict XML parser would not read this file, in one sentence with the line, or null. */
export function omeXmlProblem(text: string): string | null {
  return parseOmeXml(text).problem;
}
