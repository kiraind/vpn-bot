import http from 'http'

// Separate loopback listener for /metrics, so it never goes through the public reverse proxy
// in front of the client API and needs no auth (R-O7).

export function startMetricsServer(listen: string, render: () => Promise<string>): Promise<http.Server> {
  const [host, port] = listen.split(':')
  const server = http.createServer((req, res) => {
    if(req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end()
      return
    }
    render().then(body => {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body)
    }, err => {
      console.error('metrics failed:', err)
      res.writeHead(500).end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
