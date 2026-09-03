import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const target = join(process.cwd(), 'out', 'claudeToolGate.cjs');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(process.cwd(), 'src', 'claudeToolGate.cjs'), target);
