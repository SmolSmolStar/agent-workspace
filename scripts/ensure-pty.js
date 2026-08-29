#!/usr/bin/env node

const { loadNodePty } = require('../server/utils/nodePtyCompat');

try {
  loadNodePty();
  console.log('node-pty ok');
  process.exit(0);
} catch (error) {
  console.error('node-pty unavailable:', error.message || String(error));
  process.exit(1);
}
