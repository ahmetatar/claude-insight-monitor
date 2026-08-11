'use strict';

const { createServer } = require('./server');

const port = Number(process.env.CXT_PROXY_PORT || 8787);
// Captures hold full prompts and tool output, so stay off the network by
// default; set CXT_PROXY_HOST=0.0.0.0 to expose it deliberately.
const host = process.env.CXT_PROXY_HOST || '127.0.0.1';

const server = createServer();
server.listen(port, host, () => {
  // stdout is redirected to a log file by the CLI when started detached.
  console.log(`cmon listening on http://${host}:${port}`);
});
