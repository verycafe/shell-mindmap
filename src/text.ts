import stringWidth from 'string-width';
import {stripVTControlCharacters} from 'node:util';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export const graphemes = (text: string): string[] =>
  Array.from(segmenter.segment(text), part => part.segment);

export const displayWidth = (text: string): number => stringWidth(text);

const integer = (value: number, fallback = 0): number =>
  Number.isFinite(value) ? Math.trunc(value) : fallback;

/** Slice terminal columns, replacing either half of a clipped wide glyph with spaces. */
export function clipText(text: string, start: number, width: number): string {
  const from = Math.max(0, integer(start));
  const end = from + Math.max(0, integer(width));
  if (end === from) return '';
  let column = 0;
  let result = '';
  for (const {segment: glyph} of segmenter.segment(stripVTControlCharacters(text))) {
    const size = displayWidth(glyph);
    if (size === 0) continue;
    if (column >= end) break;
    const next = column + size;
    const overlap = Math.max(0, Math.min(next, end) - Math.max(column, from));
    if (overlap > 0) result += column >= from && next <= end ? glyph : ' '.repeat(overlap);
    column = next;
  }
  return result;
}

/** Wrap whole ASCII words where possible; keep all graphemes and whitespace. */
export function wrapText(text: string, maxWidth: number): string[] {
  // A terminal-wide CJK character or emoji needs two columns even in a tiny viewport.
  const limit = Math.max(2, integer(maxWidth, 32));
  const lines: string[] = [];
  const paragraphs = stripVTControlCharacters(text)
    .replace(/\r\n?/gu, '\n').replace(/\t/gu, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, '');
  for (const paragraph of paragraphs.split('\n')) {
    const tokens: string[] = [];
    let previousWord = false;
    for (const {segment: glyph} of segmenter.segment(paragraph)) {
      const word = /^[A-Za-z0-9_]$/u.test(glyph);
      if (word && previousWord) {
        tokens[tokens.length - 1] += glyph;
      } else {
        tokens.push(glyph);
      }
      previousWord = word;
    }
    let line = '';
    let columns = 0;
    const append = (part: string): void => {
      const size = displayWidth(part);
      if (columns > 0 && columns + size > limit) {
        lines.push(line);
        line = '';
        columns = 0;
      }
      line += part;
      columns += size;
    };
    for (const token of tokens) {
      if (displayWidth(token) <= limit) append(token);
      else for (const {segment: glyph} of segmenter.segment(token)) append(glyph);
    }
    lines.push(line);
  }
  return lines;
}

/** Plain, single-line input. Keep ZWJ and combining marks used by valid graphemes. */
export function sanitizePaste(text: string): string {
  // Node's VT stripper consumes ESC O but leaves the final SS3 key byte behind.
  return stripVTControlCharacters(text.replace(/\x1bO[A-Za-z]/gu, '').replace(/\x1b\[\[[A-E]/gu, ''))
    .replace(/\r\n|[\r\n\t\u2028\u2029]/gu, ' ')
    .replace(/\p{Cc}/gu, '');
}

export interface EditState {value: string; cursor: number}

/** The cursor is a grapheme boundary, never a UTF-16 offset or a screen column. */
export function editBuffer(state: EditState, key: string, text = ''): EditState {
  const parts = graphemes(state.value);
  const cursor = Math.max(0, Math.min(parts.length, integer(state.cursor)));
  switch (key) {
    case 'left': return {value: state.value, cursor: Math.max(0, cursor - 1)};
    case 'right': return {value: state.value, cursor: Math.min(parts.length, cursor + 1)};
    case 'home': return {value: state.value, cursor: 0};
    case 'end': return {value: state.value, cursor: parts.length};
    case 'clear': return {value: '', cursor: 0};
    case 'backspace':
      if (cursor > 0) parts.splice(cursor - 1, 1);
      return {value: parts.join(''), cursor: Math.max(0, cursor - 1)};
    case 'delete':
      parts.splice(cursor, 1);
      return {value: parts.join(''), cursor};
    case 'insert': {
      const prefix = parts.slice(0, cursor).join('') + sanitizePaste(text);
      const value = prefix + parts.slice(cursor).join('');
      // Newly inserted combining marks/ZWJ sequences can merge with adjacent text.
      return {value, cursor: Math.min(graphemes(value).length, graphemes(prefix).length)};
    }
    default: return {value: state.value, cursor};
  }
}
