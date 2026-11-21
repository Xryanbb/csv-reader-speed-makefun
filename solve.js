// Fast drop-in replacement for make.fun csv-reader 1.0.0 (bounty
// csv-reader-speed-01-run-20261121). Semantics mirror the reference reader
// (kit baselines/csv-reader/vendor/csv-reader/index.js) exactly — same state
// machine, same error records in the same order — but scanning jumps with
// indexOf instead of reading one character at a time.
//
// Written in the main chat session on 2026-11-21 (the build session of record
// for this entry). Verified against the kit practice set with the kit scorer.

const COMMA = 'comma';
const LINE_BREAK = 'line break';
const END = 'end';

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;
  // Half the drawn files are LF-only: with no CR anywhere, the CR branches
  // of the reader are unreachable, so the scan can skip looking for CR.
  const hasCR = text.indexOf('\r') !== -1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The raw range [a, b) of a quoted field, with every CRLF, lone CR and LF
  // read as one LF, counting each in `line`.
  function convertSegment(a, b) {
    if (a === b) return '';
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return seg;
    let count = 0;
    const out = seg.replace(/\r\n|\r|\n/g, () => { count += 1; return '\n'; });
    line += count;
    return out;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept by this call.
  function readUnquoted(value) {
    let added = 0;
    let out = value;
    let segStart = pos;
    while (pos < n) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      const ri = hasCR ? text.indexOf('\r', pos) : -1;
      let stop = n;
      let kind = 0; // 1 comma, 2 LF, 3 CR
      if (ci !== -1 && ci < stop) { stop = ci; kind = 1; }
      if (ni !== -1 && ni < stop) { stop = ni; kind = 2; }
      if (ri !== -1 && ri < stop) { stop = ri; kind = 3; }
      if (kind === 0) {
        out += text.slice(segStart, n);
        added += n - segStart;
        pos = n;
        return { value: out, ended: END, added };
      }
      if (kind === 3 && text.charCodeAt(stop + 1) !== 10) {
        // A CR not followed by LF is dropped (stray_cr).
        out += text.slice(segStart, stop);
        added += stop - segStart;
        error('stray_cr');
        pos = stop + 1;
        segStart = pos;
        continue;
      }
      out += text.slice(segStart, stop);
      added += stop - segStart;
      if (kind === 1) {
        pos = stop + 1;
        return { value: out, ended: COMMA, added };
      }
      line += 1;
      pos = kind === 2 ? stop + 1 : stop + 2;
      return { value: out, ended: LINE_BREAK, added };
    }
    return { value: out, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    pos += 1;
    let segStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        parts.push(convertSegment(segStart, q));
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      parts.push(convertSegment(segStart, q));
      pos = q + 1;
      break;
    }
    const value = parts.join('');
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields = null;
    let quoted = false;

    // Fast path: the whole record sits on one line and holds no quote and
    // no interior CR, so it is just the line split at its commas. Anything
    // else (a quote before the line ends, a CR that is not the CRLF's, a
    // record running past the line) takes the general reader below.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : (text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl);
    const firstQuote = text.indexOf('"', pos);
    const firstCR = hasCR ? text.indexOf('\r', pos) : -1;
    if ((firstQuote === -1 || firstQuote > lineEnd) && (firstCR === -1 || firstCR >= lineEnd)) {
      fields = [];
      let fStart = pos;
      while (true) {
        const c = text.indexOf(',', fStart);
        if (c === -1 || c >= lineEnd) {
          fields.push(text.slice(fStart, lineEnd));
          break;
        }
        fields.push(text.slice(fStart, c));
        fStart = c + 1;
      }
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      fields = [];
      let field;
      do {
        quoted = text[pos] === '"';
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
