// Lazurio MausBot GitHub intake: the backward-compatible publication
// instruction, a line of a pull request comment that reads exactly the marker.

/** Backward-compatible publication instruction for installations without assignment handoff. */
export const PUBLISH_MARKER = "/lazurio publish";

/** Columns of a line's leading whitespace with CommonMark tab stops of 4, so a
 * tab after one to three spaces still reaches the indented-code column. */
function leadingColumns(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** True when one line of the comment, outside quotes and code, is exactly the
 * publish marker. Code follows CommonMark: a fenced block opens with three or
 * more backticks or tildes indented at most three spaces and closes only with
 * the same character, at least as long, and nothing else on the line; a line
 * indented four or more spaces (or by a tab) is an indented code block. An
 * unclosed fence runs to the end of the comment. */
export function hasPublishMarker(body: string): boolean {
  let fence: { char: string; length: number } | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const shallow = leadingColumns(raw) <= 3;
    const line = raw.trim();
    const run = shallow ? /^(`{3,}|~{3,})(.*)$/.exec(line) : null;
    if (fence) {
      if (run && run[1][0] === fence.char && run[1].length >= fence.length && run[2].trim() === "") fence = null;
      continue;
    }
    if (run) {
      // A backtick fence's info string may not contain a backtick.
      if (run[1][0] === "`" && run[2].includes("`")) continue;
      fence = { char: run[1][0], length: run[1].length };
      continue;
    }
    if (shallow && line === PUBLISH_MARKER) return true;
  }
  return false;
}
