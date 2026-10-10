import fs from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import headless from '@xterm/headless';
import {UnicodeGraphemesAddon} from '@xterm/addon-unicode-graphemes';

// Replay actual PTY bytes through a VT terminal rather than assuming full-frame clears.
// Grapheme-aware width avoids treating one ZWJ emoji as several unrelated glyphs.
// This still does not simulate an OS input method or every terminal's font shaping.
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const terminal = new headless.Terminal({cols: input.columns, rows: input.rows, allowProposedApi: true, scrollback: 1000});
terminal.loadAddon(new UnicodeGraphemesAddon());
// PTY reads may split a Unicode code point across buffers. Decode the continuous
// byte stream before passing text to the grapheme addon, which otherwise loses
// some characters (including the selection marker) at those buffer boundaries.
const decoder = new StringDecoder('utf8');
const write = text => text ? new Promise(resolve => terminal.write(text, resolve)) : Promise.resolve();
for (const event of input.events) {
  if (event.data !== undefined) {
    await write(decoder.write(Buffer.from(event.data, 'base64')));
  } else if (event.columns !== undefined) terminal.resize(event.columns, event.rows);
}
await write(decoder.end());
const buffer = terminal.buffer.active;
const lines = Array.from({length: terminal.rows}, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
const attributes = input.attributes ? Array.from({length: terminal.rows}, (_, y) => {
  const line = buffer.getLine(buffer.viewportY + y);
  return Array.from({length: terminal.cols}, (_, x) => {
    const cell = line?.getCell(x);
    return {chars: cell?.getChars() ?? '', dim: !!cell?.isDim(), foregroundDefault: cell?.isFgDefault() ?? true,
      foreground: cell?.getFgColor() ?? 0};
  });
}) : undefined;
process.stdout.write(JSON.stringify({lines, columns: terminal.cols, rows: terminal.rows, buffer: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
  ...(attributes ? {attributes} : {})}));
terminal.dispose();
