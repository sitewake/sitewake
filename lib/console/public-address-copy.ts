import type { Locale } from "../i18n";

/**
 * The words for the address the install snippet carries.
 *
 * Written the way deployment documentation is written: what the thing is, what
 * is wrong, what to do. Putting https in front of a service is ordinary work,
 * so it is described as ordinary work.
 */

const zh = {
  title: "对外地址",
  hint: "业务网站从这个地址加载 SiteWake，接入代码里写的就是它。",
  manageNote: (origin: string) => `当前管理地址 ${origin}，与对外地址无关，不会写进接入代码。`,
  currentLabel: "当前对外地址",
  sourceConsole: "手动设置",
  sourceEnv: "安装时自动填写",
  sourceNone: "未设置",
  modeLocal: "本地模式",
  modeLocalHint: "仅支持本机与内网站点。公网站点需要 https 对外地址。",
  modeOnline: "已就绪",
  modeOnlineHint: "公网站点可以接入。",
  inputLabel: "https 地址",
  placeholder: "https://console.yourdomain.com",
  submit: "检测并保存",
  checking: "检测中…",
  saved: "已保存，接入代码将使用该地址。",
  failures: {
    insecure: (origin: string) => `${origin} 为 http。https 站点不能加载 http 脚本（混合内容）。`,
    local: (host: string) => `${host} 仅本机或内网可达。`,
    malformed: "地址格式无效。",
    dns: (resolved: string[], expected: string[]) => resolved.length
      ? `解析到 ${resolved.join("、")}，与本机地址${expected.length ? `（${expected.join("、")}）` : ""}不一致，请检查 A 记录。`
      : "域名无法解析，请检查 A 记录。",
    tls: (detail: string) => `域名解析正确，https 未就绪：${detail}`,
    unreachable: (detail: string) => `地址无响应：${detail}`,
    otherInstallation: "该地址指向另一个 SiteWake 实例，请检查反向代理的目标端口。",
    save: "保存失败，请重试。",
  },
  guideTitle: "配置 https",
  guideLead: "SiteWake 监听 3000 端口（http）。在它前面放一层反向代理或云负载均衡即可，服务本身无需改动。",
  guideSelfHosted: (ip: string) => [
    `1. A 记录指向 ${ip || "本机公网 IP"}`,
    "2. 反向代理转发到 3000，由它负责证书：",
    "   caddy reverse-proxy --from console.yourdomain.com --to 127.0.0.1:3000",
    "   使用 Nginx 时需转发 Host 与 X-Forwarded-Proto。",
    "3. 将 https://console.yourdomain.com 填入上方",
  ],
  guideCloud: [
    "云负载均衡：申请证书，监听 443，后端指向本机 3000 端口。",
  ],
  guideLater: "也可暂不配置。本地模式下仍可接入本机站点。",
  bannerTitle: "公网站点暂时无法接入",
  bannerBody: (origin: string) => `对外地址为 ${origin || "未设置"}，业务网站无法加载。为 3000 端口配置 https 即可。`,
  bannerAction: "配置 https",
};

const en: typeof zh = {
  title: "Public address",
  hint: "The website loads SiteWake from this address. It is what the install snippet carries.",
  manageNote: (origin: string) => `You are administering the console at ${origin}. That address is unrelated and never enters the install snippet.`,
  currentLabel: "Current public address",
  sourceConsole: "set manually",
  sourceEnv: "filled in by the installer",
  sourceNone: "not set",
  modeLocal: "Local mode",
  modeLocalHint: "Websites on this machine or this LAN only. A website on the internet needs an https public address.",
  modeOnline: "Ready",
  modeOnlineHint: "Websites on the internet can connect.",
  inputLabel: "https address",
  placeholder: "https://console.yourdomain.com",
  submit: "Check and save",
  checking: "Checking…",
  saved: "Saved. Install snippets will use this address.",
  failures: {
    insecure: (origin: string) => `${origin} is http. An https site cannot load an http script (mixed content).`,
    local: (host: string) => `${host} is reachable only from this machine or this LAN.`,
    malformed: "Invalid address.",
    dns: (resolved: string[], expected: string[]) => resolved.length
      ? `Resolves to ${resolved.join(", ")}, which is not this machine${expected.length ? ` (${expected.join(", ")})` : ""}. Check the A record.`
      : "The name does not resolve. Check the A record.",
    tls: (detail: string) => `DNS is correct, https is not up: ${detail}`,
    unreachable: (detail: string) => `No response from that address: ${detail}`,
    otherInstallation: "That address reaches a different SiteWake instance. Check the proxy's target port.",
    save: "Could not save. Try again.",
  },
  guideTitle: "Set up https",
  guideLead: "SiteWake listens on port 3000 over http. Put a reverse proxy or a cloud load balancer in front of it; the stack itself does not change.",
  guideSelfHosted: (ip: string) => [
    `1. Point the A record at ${ip || "this machine's public IP"}`,
    "2. Forward a reverse proxy to 3000 and let it handle the certificate:",
    "   caddy reverse-proxy --from console.yourdomain.com --to 127.0.0.1:3000",
    "   With Nginx, forward Host and X-Forwarded-Proto.",
    "3. Enter https://console.yourdomain.com above",
  ],
  guideCloud: [
    "Cloud load balancer: issue a certificate, listen on 443, point the backend at port 3000 on this machine.",
  ],
  guideLater: "Leaving it unset is fine. Local mode still connects websites on this machine.",
  bannerTitle: "Websites on the internet cannot connect",
  bannerBody: (origin: string) => `The public address is ${origin || "not set"}, which the website cannot load from. Put https in front of port 3000.`,
  bannerAction: "Set up https",
};

export function publicAddressCopy(locale: Locale) { return locale === "en" ? en : zh; }
