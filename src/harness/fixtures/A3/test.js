const { left } = require('./src/left');
const { right } = require('./src/right');
process.exit(left() === 'left' && right() === 'right' ? 0 : 1);
