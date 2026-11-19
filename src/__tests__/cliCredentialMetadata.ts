import ts from 'typescript';

const homeExpression = `environment.CODEX_HOME || path.join(
  (process.platform === 'win32' ? environment.USERPROFILE || environment.HOME : environment.HOME) || os.homedir(), '.codex')`;
const publisherBody = `{
  if (!path.isAbsolute(home) || windowsNameProblem(home)) return;
  this.controlFiles = [{ kind: 'codex-config', path: path.join(home, 'config.toml') },
    { kind: 'codex-auth', path: path.join(home, 'auth.json') }];
  this.deps?.onControlFiles?.(this.controlFiles.map(file => ({ ...file })));
}`;
function tokens(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) result.push(`${kind}:${scanner.getTokenText()}`);
  return JSON.stringify(result);
}
const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(node); ts.forEachChild(node, child => walk(child, visit));
};

/** Reviewed S3 location publication only. Exact syntax and home-value uses are pinned; no file-read exemption. */
export function reviewedCredentialMetadata(source: ts.SourceFile, relativeFile: string): Set<ts.Node> {
  const allowed = new Set<ts.Node>();
  if (relativeFile !== 'src/backend/CodexBackend.ts') return allowed;
  const methods: ts.MethodDeclaration[] = [];
  walk(source, node => { if (ts.isMethodDeclaration(node)) methods.push(node); });
  const publishers = methods.filter(method => method.name.getText(source) === 'publishCodexControlHome');
  const spawns = methods.filter(method => method.name.getText(source) === 'spawnAppServer');
  if (publishers.length !== 1 || spawns.length !== 1) return allowed;
  const publisher = publishers[0].body, spawn = spawns[0].body;
  if (!publisher || !spawn || tokens(publisher.getText(source)) !== tokens(publisherBody)) return allowed;
  const homes: ts.Identifier[] = [], initializers: ts.Expression[] = [];
  let publishes = 0;
  walk(spawn, node => {
    if (ts.isIdentifier(node) && node.text === 'home') homes.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'home'
      && node.initializer && tokens(node.initializer.getText(source)) === tokens(homeExpression)) initializers.push(node.initializer);
    if (ts.isCallExpression(node) && tokens(node.getText(source)) === tokens('this.publishCodexControlHome(path.resolve(this.workspaceRoot, home))')) publishes++;
  });
  // A new read or alias of home, or an edited initializer/publication, invalidates this whole exception.
  if (homes.length !== 2 || initializers.length !== 1 || publishes !== 1) return allowed;
  walk(initializers[0], node => allowed.add(node));
  walk(publisher, node => allowed.add(node));
  return allowed;
}
