# Third-party notices

SiteWake is licensed under the [MIT License](LICENSE). This file lists the
third-party code that ships **inside SiteWake's own artifacts**, with the
notices their licenses require us to keep.

Server-side npm dependencies are not redistributed by this repository; npm
installs each one together with its own license file under `node_modules/`.

## Bundled into the browser SDK

`npm run sdk:build` compiles `public/sitewake.js` and
`public/sitewake-adaptive.js`, the scripts that websites load. Both are
minified bundles that include the packages below. The build appends the same
notices to the end of each bundle, so the shipped file carries them on its own.

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| [@page-agent/core](https://github.com/alibaba/page-agent) | 1.12.1 | MIT | (c) 2026 SimonLuvRamen; (c) 2026 Alibaba Group Holding Limited |
| [@page-agent/llms](https://github.com/alibaba/page-agent) | 1.12.1 | MIT | (c) 2026 SimonLuvRamen; (c) 2026 Alibaba Group Holding Limited |
| [@page-agent/page-controller](https://github.com/alibaba/page-agent) | 1.12.1 | MIT | (c) 2026 SimonLuvRamen; (c) 2026 Alibaba Group Holding Limited |
| [ai-motion](https://gaomeng1900.github.io/ai-motion/) | 0.4.8 | MIT | (c) 2025 Simon <gaomeng1900@gmail.com> |
| [chalk](https://github.com/chalk/chalk) | 5.6.2 | MIT | (c) Sindre Sorhus <sindresorhus@gmail.com> |
| [zod](https://zod.dev) | 4.4.3 | MIT | (c) 2025 Colin McDonnell |
| [ret](https://github.com/fent/ret.js) | 0.5.0 | MIT | (C) 2011 by fent |
| [safe-regex2](https://github.com/fastify/safe-regex2) | 5.0.0 | MIT | Fastify contributors |

`sitewake.js` bundles `ret` and `safe-regex2`. `sitewake-adaptive.js` bundles
the `@page-agent/*` packages, `ai-motion`, `chalk` and `zod`. Model requests
made through `@page-agent/llms` go to your own SiteWake server, never to a
third-party endpoint.

Each of these packages is distributed under the MIT License:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Copied source

The authored-capability page contract (`run(page, args)`, `page.goto`,
`page.evaluate`, `page.wait`) is copied from
[OpenCLI](https://github.com/jackwener/OpenCLI) (Apache License 2.0). Its
attribution is in [NOTICE](NOTICE).
