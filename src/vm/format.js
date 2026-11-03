// printf-style formatting used by kString format (sub-ops 1/2) and Display.
// Supports %d %u %x %X %c %s %% with optional '-', '0' flags and width, like
// the Borland C runtime the interpreter links. %s takes a string ID.
import { signed } from './opcodes.js';

const SPEC = /%([-0]*)(\d*)([dusxXc%])/g;

/**
 * @param {string} fmt
 * @param {number[]} args
 * @param {(id: number) => string} readString
 */
export function formatString(fmt, args, readString) {
  let next = 0;
  return fmt.replace(SPEC, (match, flags, width, conv) => {
    if (conv === '%') {
      return '%';
    }
    const value = args[next++] ?? 0;
    const text = convert(conv, value, readString);
    return pad(text, Number(width || 0), flags);
  });
}

function convert(conv, value, readString) {
  switch (conv) {
    case 'd': return String(signed(value));
    case 'u': return String(value);
    case 'x': return value.toString(16);
    case 'X': return value.toString(16).toUpperCase();
    case 'c': return String.fromCharCode(value & 0xff);
    default: return readString(value);
  }
}

function pad(text, width, flags) {
  if (text.length >= width) {
    return text;
  }
  if (flags.includes('-')) {
    return text.padEnd(width);
  }
  return text.padStart(width, flags.includes('0') ? '0' : ' ');
}
