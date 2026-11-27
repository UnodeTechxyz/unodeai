/** Heuristic: does a shell command mutate the filesystem/repo? Blacklist, so a read-only research command
 *  reaches `verified`; only clear mutations set the unrecorded-write flag. */
export function looksMutatingShellCommand(command: string): boolean {
  if (!command) { return false; }
  return (
    /(^|[\s;&|(])(rm|rmdir|mv|cp|dd|mkdir|touch|tee|chmod|chown|ln|truncate|shred|rsync)\b/i.test(command) ||
    />>?/.test(command) || // redirection into a file
    /\bgit\s+(commit|checkout|reset|clean|apply|stash|rm|mv|push|restore|revert|merge|rebase)\b/i.test(command) ||
    /\b(npm|yarn|pnpm)\s+(i|install|add|remove|uninstall)\b/i.test(command) ||
    /\bpip\s+install\b|\bsed\b[^\n]*\s-i|\bmake\b/i.test(command)
  );
}
