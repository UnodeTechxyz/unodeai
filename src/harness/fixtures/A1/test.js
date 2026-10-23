const fs = require('node:fs');
process.exit(fs.readFileSync('src/message.txt', 'utf8') === 'hello\n' ? 0 : 1);
