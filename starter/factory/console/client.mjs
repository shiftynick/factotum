import http from 'node:http';

/** Transport boundary: a future remote client must preserve these request semantics. */
export function requestProject(socketPath, { method = 'GET', path, body, timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, method, path, headers: encoded ? {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
    } : {} }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(new Error('Project response exceeded limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(data.error || `Project returned HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode;
            reject(error);
          } else resolve(data);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Project request timed out')), timeoutMs);
    req.on('error', error => reject(new Error(error.code ? `Project transport unavailable (${error.code})` : error.message)));
    req.on('close', () => clearTimeout(timer));
    req.end(encoded);
  });
}
