import { ENGINE_CONFIG_MAX_BYTES } from '@streaming-infra-manager/common';

export interface SrsDirective {
  name: string;
  args: readonly string[];
  /** UTF-16 positions in the source, used to verify the entrypoint's first replacement on each line. */
  argOffsets: readonly number[];
  children: readonly SrsDirective[] | null;
  generated: boolean;
}

type Token = { kind: 'word'; value: string; quoted: boolean; lineStart: boolean; offset: number }
  | { kind: '{' | '}' | ';' | 'newline' };

const GENERATED = new Set(['TRANSCODE_PLACEHOLDER', 'ABR_VHOST_PLACEHOLDER']);
const MAX_TOKENS = 16_384;
const MAX_DEPTH = 64;

function tokensIn(text: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  let lineStart = true;
  while (index < text.length) {
    if (tokens.length >= MAX_TOKENS) return null;
    const char = text[index]!;
    if (char === '\n') { tokens.push({ kind: 'newline' }); lineStart = true; index += 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r') { index += 1; continue; }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '{' || char === '}' || char === ';') {
      tokens.push({ kind: char }); lineStart = false; index += 1; continue;
    }
    const quoted = char === '"' || char === "'";
    const offset = index + (quoted ? 1 : 0);
    let value = '';
    if (quoted) {
      const quote = char;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        let next = text[index++]!;
        if (next === '\n' || next === '\r') return null;
        if (next === '\\') {
          next = text[index++] ?? '';
          if (next !== quote && next !== '\\') return null;
        }
        value += next;
      }
      if (text[index] !== quote) return null;
      index += 1;
      if (index < text.length && !/[\s#{};]/.test(text[index]!)) return null;
    } else {
      while (index < text.length && !/[\s#{};]/.test(text[index]!)) {
        const next = text[index++]!;
        if (next === '\\' || next === '"' || next === "'" || next.charCodeAt(0) < 32) return null;
        value += next;
      }
    }
    if (!value && !quoted) return null;
    tokens.push({ kind: 'word', value, quoted, lineStart, offset });
    lineStart = false;
  }
  return tokens;
}

/** A bounded observation subset. This is not SRS's config validator and never expands an include. */
export function parseSrsConfig(text: string | null): readonly SrsDirective[] | null {
  if (text === null || Buffer.byteLength(text) > ENGINE_CONFIG_MAX_BYTES) return null;
  // The entrypoint replaces entire marker lines, including occurrences inside comments and quotes.
  if (text.split('\n').some(line => [...GENERATED].some(marker => line.includes(marker)) && !GENERATED.has(line.trim()))) return null;
  const tokens = tokensIn(text);
  if (tokens === null) return null;
  let index = 0;
  const block = (depth: number): SrsDirective[] => {
    if (depth > MAX_DEPTH) throw new Error('depth');
    const nodes: SrsDirective[] = [];
    while (index < tokens.length) {
      const first = tokens[index++]!;
      if (first.kind === 'newline') continue;
      if (first.kind === '}' && depth > 0) return nodes;
      if (first.kind !== 'word' || first.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(first.value)) throw new Error('directive');
      if (GENERATED.has(first.value)) {
        if (!first.lineStart || (tokens[index] && tokens[index]!.kind !== 'newline')) throw new Error('marker');
        nodes.push({ name: first.value, args: [], argOffsets: [], children: null, generated: true });
        continue;
      }
      const args: string[] = [];
      const argOffsets: number[] = [];
      let ended = false;
      while (index < tokens.length) {
        const token = tokens[index++]!;
        if (token.kind === 'newline') continue;
        if (token.kind === 'word') { args.push(token.value); argOffsets.push(token.offset); continue; }
        if (token.kind !== ';' && token.kind !== '{') throw new Error('terminator');
        nodes.push({ name: first.value, args, argOffsets, children: token.kind === '{' ? block(depth + 1) : null, generated: false });
        ended = true;
        break;
      }
      if (!ended) throw new Error('unfinished');
    }
    if (depth > 0) throw new Error('unclosed');
    return nodes;
  };
  try { return block(0); } catch { return null; }
}
