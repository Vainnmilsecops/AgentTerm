import { createServer } from 'node:http';

import next from 'next';

const nextApp = next({
  dev: false,
  dir: process.cwd(),
});

await nextApp.prepare();

const requestHandler = nextApp.getRequestHandler();
const server = createServer((request, response) => {
  void requestHandler(request, response);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Website smoke server did not expose a TCP address.');
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const content = await response.text();

  if (!response.ok) {
    throw new Error(`Website smoke request failed with status ${response.status}.`);
  }

  if (!content.includes('AgentTerm')) {
    throw new Error('Website smoke response did not contain the AgentTerm heading.');
  }

  console.log(`AgentTerm website smoke test passed: HTTP ${response.status}.`);
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await nextApp.close();
}
