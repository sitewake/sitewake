import { createServer } from "node:http";
import { build } from "esbuild";

// Synthetic version of the incident: React cards open an internal detail;
// their identically named nested source links open another website.
export async function startClickableCardSite(modules = new Map(), port = 0) {
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      const topics = ['晨间新闻', '科技动态', '城市观察'];
      function App() {
        const [rank, setRank] = React.useState(Number(new URL(location.href).searchParams.get('topic')) || 0);
        const open = (rank) => { history.pushState({}, '', '?topic=' + rank); setRank(rank); };
        return <main><h1>热搜时光机</h1>{rank ? <section><h2>{topics[rank - 1]}</h2><p>排名：{rank}</p><p>热度：68 万；上榜次数：3 次</p><button onClick={() => {history.pushState({}, '', '/'); setRank(0);}}>返回热搜榜</button></section> :
          <section><h2>实时热搜榜</h2>{topics.map((topic, i) => <div key={topic} className="topic-card" onClick={() => open(i + 1)}>
            <span className="rank">{i + 1}</span><span className="topic-title">{topic}</span><span>68 万</span>
            <a href={'https://external.example/source/' + (i + 1)} target="_blank" onClick={e => e.stopPropagation()}>微博</a>
          </div>)}</section>}</main>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `, loader: "jsx", resolveDir: process.cwd() },
    bundle: true, format: "iife", platform: "browser", write: false,
  });
  const html = '<!doctype html><meta charset="utf-8"><title>热搜测试站</title><style>.topic-card{display:flex;gap:20px;padding:20px;cursor:pointer;border:1px solid #ddd}a{margin-left:auto}</style><div id="root"></div><script src="/app.js"></script>';
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const hash = url.pathname.match(/^\/api\/capability-v2\/modules\/([a-f0-9]{64})$/)?.[1];
    if (hash) {
      const source = modules.get(hash);
      response.writeHead(source ? 200 : 404, { "content-type": "text/javascript" });
      return response.end(source || "");
    }
    response.writeHead(200, { "content-type": url.pathname === "/app.js" ? "text/javascript" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? result.outputFiles[0].text : html);
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
