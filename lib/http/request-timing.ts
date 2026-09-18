/** Bounded operational metadata only; request bodies, URLs and credentials are never logged. */
export function withRequestTiming<Args extends unknown[]>(name: string, handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const start = performance.now();
    let status = 500;
    try {
      const response = await handler(...args);
      status = response.status;
      response.headers.set('server-timing', `app;dur=${(performance.now() - start).toFixed(1)}`);
      response.headers.set('x-request-id', requestId);
      const exposed = response.headers.get('access-control-expose-headers');
      response.headers.set('access-control-expose-headers', [exposed, 'server-timing', 'x-request-id'].filter(Boolean).join(','));
      return response;
    } finally {
      console.info(JSON.stringify({ event: 'runtime_http', operation: name, requestId, status, durationMs: Math.round(performance.now() - start) }));
    }
  };
}
