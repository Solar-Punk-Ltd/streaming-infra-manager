import type { OmeElement } from './omeXml.js';

/** Named applications, virtual hosts and output profiles keep their identity when reordered. */
function segmentOf(element: OmeElement): string {
  const name = element.children.find(child => child.name === 'Name');
  if (!name || element.children.length < 2) return element.name;
  return `${element.name}[${name.text}]`;
}

export interface OmePathEntry {
  path: string;
  element: OmeElement;
  /** Ancestors under Server, followed by the element itself. */
  ancestry: readonly OmeElement[];
}

/** Parsed ancestry avoids interpreting punctuation inside application names as path syntax. */
export function* elementsWithPaths(root: OmeElement): Generator<OmePathEntry> {
  function* walk(element: OmeElement, parentPath: string, ancestors: readonly OmeElement[]): Generator<OmePathEntry> {
    for (const child of element.children) {
      const path = parentPath ? `${parentPath}/${segmentOf(child)}` : segmentOf(child);
      const ancestry = [...ancestors, child];
      yield { path, element: child, ancestry };
      yield* walk(child, path, ancestry);
    }
  }
  yield* walk(root, '', []);
}

/** Every element under the root by path, with each path's values in document order. */
export function valuesByPath(root: OmeElement): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (element: OmeElement, parentPath: string) => {
    for (const child of element.children) {
      const path = parentPath ? `${parentPath}/${segmentOf(child)}` : segmentOf(child);
      const values = found.get(path) ?? [];
      values.push(child.text);
      found.set(path, values);
      walk(child, path);
    }
  };
  walk(root, '');
  return found;
}

/** The path and every path above it, the root left out. */
export function prefixesOf(path: string): string[] {
  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}
