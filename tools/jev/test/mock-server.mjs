// Loopback stand-in for POST /v1/systemone. Never contacts the real service.
import { createServer } from 'node:http';
import { MODEL_PIN } from '../config.mjs';

/**
 * `script` is a list of responses consumed one per request; the last one repeats.
 * Each entry: { status, body, delayMs, model, usage, answerFor }.
 */
export async function startMock(script = []) {
  const seen = [];
  let i = 0;
  const sockets = new Set();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* record as unparsed */ }
      seen.push({ url: req.url, headers: req.headers, raw, body: parsed });

      const step = script[Math.min(i, script.length - 1)] ?? {};
      i++;
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (step.hang) return; // never responds: exercises the timeout path

      const status = step.status ?? 200;
      let body = step.body;
      if (body === undefined) {
        // Default: answer the first choice question by picking a given label.
        const qname = Object.keys(parsed?.questions ?? {})[0] ?? 'pick';
        const q = parsed?.questions?.[qname];
        const labels = Object.keys(q?.criteria ?? {});
        const chosen = step.answerFor ?? labels[0];
        const probabilities = Object.fromEntries(labels.map((l) => [l, l === chosen ? 0.82 : (0.18 / Math.max(1, labels.length - 1))]));
        body = {
          model: step.model ?? MODEL_PIN,
          answers: { [qname]: { type: 'choice', choice: chosen, confidence: step.confidence ?? 0.82, probabilities } },
          usage: step.usage ?? { input_tokens: 1919, output_tokens: 355 },
        };
      }
      res.writeHead(status, { 'content-type': 'application/json', 'x-typesafe-request-id': `mock-${i}` });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    requestCount: () => seen.length,
    // A `hang` step leaves a live socket; destroy them or close() never resolves.
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); sockets.clear(); server.close(r); }),
  };
}
