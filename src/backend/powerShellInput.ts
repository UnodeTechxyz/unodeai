/**
 * v0.9.100 (field, T3): whether PowerShell would read this command and then wait for more. In an agent's terminal that
 * is the `>>` prompt: nothing runs and nobody answers until the command's time limit. The usual cause is a model's
 * `\\"`, which escapes nothing in PowerShell, so the string goes on past the end of the command.
 *
 * Only an open quote is reported, and a form this scan does not model answers "complete": the shell then decides as it
 * did before. A bracket is not counted, because `a(b` is an ordinary word to PowerShell.
 */
export function powerShellInputIncomplete(command: string): boolean {
  const DOUBLE = '"\u201c\u201d\u201e';
  const SINGLE = "'\u2018\u2019\u201a\u201b";
  let tokenStart = true;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '`') { i++; tokenStart = /\s/.test(command[i] ?? ''); continue; }
    if (c === '#' && tokenStart) {
      while (i < command.length && command[i] !== '\n') i++;
      tokenStart = true;
      continue;
    }
    // A here-string, a block comment or the stop-parsing token has rules of its own.
    if (c === '@' && (DOUBLE + SINGLE).includes(command[i + 1] ?? ' ')) return false;
    if (command.startsWith('<#', i) || command.startsWith('--%', i)) return false;
    if (SINGLE.includes(c)) {
      let closed = false;
      for (i++; i < command.length; i++) {
        if (!SINGLE.includes(command[i])) continue;
        if (SINGLE.includes(command[i + 1] ?? ' ')) { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) return true;
      tokenStart = false;
      continue;
    }
    if (DOUBLE.includes(c)) {
      let closed = false;
      for (i++; i < command.length; i++) {
        const inner = command[i];
        if (inner === '`') { i++; continue; }
        if (inner === '$' && command[i + 1] === '(') return false; // A subexpression holds quotes of its own.
        if (!DOUBLE.includes(inner)) continue;
        if (DOUBLE.includes(command[i + 1] ?? ' ')) { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) return true;
      tokenStart = false;
      continue;
    }
    tokenStart = /\s/.test(c) || c === ';' || c === '|' || c === '&' || c === '(' || c === '{';
  }
  return false;
}
