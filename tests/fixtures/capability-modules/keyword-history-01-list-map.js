export const capability = {
  version: 2,
  stages: [
    { id: "stage_open", io: {"reads":{"input":["keyword"],"state":[]},"writes":{"state":[],"output":[]}}, navigation: "required",
      async run({ input }) {
        return { outcome: "Continue", navigation: { url: `https://example.test/search?q=${encodeURIComponent(String(input["keyword"]))}`, target: "_self" } };
      } },
    { id: "stage_verify", io: {"reads":{"input":["keyword"],"state":[]},"writes":{"state":[],"output":["items","totalFound"]}}, navigation: "none",
      async run({ input, waitUntil, settle }) {
        const keyword = String(input["keyword"]);
        
        // 等待结果区域加载完成
        await waitUntil(() => {
          const container = document.querySelector('main > div > div:nth-of-type(3)');
          if (!container) return false;
          const links = container.querySelectorAll('a[href^="/topic/"]');
          return links.length > 0;
        });
        
        // 等待稳定
        await settle();
        
        // 提取 totalFound - 来自 document.body.innerText 的正则捕获
        const bodyText = document.body.innerText;
        const totalMatch = bodyText.match(/找到\s+(\d+)\s+条包含/);
        const totalFound = totalMatch ? parseInt(totalMatch[1]) : 0;
        
        // 检查结果容器
        const resultContainer = document.querySelector('main > div > div:nth-of-type(3)');
        if (!resultContainer) {
          return { outcome: "NoResult", reason: "未找到结果列表容器" };
        }
        
        // 获取所有结果链接
        const links = Array.from(resultContainer.querySelectorAll('a[href^="/topic/"]'));
        
        if (links.length === 0) {
          return { outcome: "NoResult", reason: "没有找到相关热搜条目" };
        }
        
        // 为每个链接构建条目，每个字段都来自对应元素的属性
        const items = links.map(link => {
          // name 属性来自 link.getAttribute('name')
          const name = link.getAttribute('name') || '';
          
          // title: 从 name 中正则捕获
          const titleMatch = name.match(/^(.+?)上榜记录/);
          const title = titleMatch ? titleMatch[1].trim() : '';
          
          // recordCount: 从 name 中正则捕获数字 + '条'
          const recordMatch = name.match(/上榜记录\s+(\d+)\s+条/);
          const recordCount = recordMatch ? recordMatch[1] + '条' : '';
          
          // maxHeat: 从 name 中正则捕获数字 + '万'
          const heatMatch = name.match(/最高热度\s+([\d.]+)万/);
          const maxHeat = heatMatch ? heatMatch[1] + '万' : '';
          
          // lastDate: 从 name 中正则捕获日期
          const dateMatch = name.match(/最近上榜\s+(\d{4}\/\d{2}\/\d{2})/);
          const lastDate = dateMatch ? dateMatch[1] : '';
          
          return { title, recordCount, maxHeat, lastDate };
        });
        
        // 过滤出有效条目（所有字段都有值）
        const validItems = items.filter(item => item.title && item.recordCount && item.maxHeat && item.lastDate);
        
        if (validItems.length === 0) {
          return { outcome: "NoResult", reason: "无法解析有效的热搜条目" };
        }
        
        return {
          outcome: "Success",
          output: {
            totalFound,
            items: validItems
          },
          evidence: [{
            kind: "status",
            value: {
              keyword,
              totalFound,
              itemCount: validItems.length
            }
          }]
        };
      } }
  ]
};
