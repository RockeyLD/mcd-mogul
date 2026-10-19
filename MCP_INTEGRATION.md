# 麦当劳 MCP 接入说明

本文说明「麦麦大亨」实际调用了麦当劳 MCP Server 的哪些能力、怎么调、拿到了什么、用来干什么。

---

## 1. 接入信息

| 项 | 值 |
|---|---|
| MCP Server | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP（JSON-RPC 2.0，响应可能是 `text/event-stream` SSE） |
| 鉴权 | `Authorization: Bearer <MCP_TOKEN>`（Token 由 mcd.cn 控制台申请） |
| 限流 | 600 次 / 分钟 |
| 协议方法 | `initialize` → `tools/list` → `tools/call` |

游戏**不是**在浏览器里直连 MCP 的。原因有两个，都很硬：

1. `mcp.mcd.cn` 没有开放 CORS，浏览器直连会被拦；
2. Token 一旦写进前端代码就等于公开。

所以接入分两层：一层在 Node 里跑（拉数据），一层在浏览器里跑（玩游戏）。

```
tools/pull-mcp.js  ──Bearer Token──▶  mcp.mcd.cn/tools/call
        │
        ▼
data/snapshot.json  ──注入──▶  game/index.html 的 <script id="mcd-data">
                                      │
                                      ▼
                              浏览器里跑，零依赖、离线可玩
```

一条命令重跑整条链路：

```bash
MCD_MCP_TOKEN=<你的 Token> node tools/pull-mcp.js --store 1421136
```

---

## 2. 用到的 Tool

### 2.1 `query-nearby-stores`

> 门店。决定"你在哪家店打工"，也是后面所有查询的 `storeCode` 来源。

```json
{ "beType": 1, "searchType": 1 }
```

返回门店数组（`storeCode` / `storeName` / `address`）。本仓库快照取到的是：

- 门店编码 `1421136`
- 门店名「麦当劳深圳腾讯总部园区一店餐厅」
- 地址「大铲湾南部企鹅岛4栋公寓地上一层」

**用在哪：** 标题页页脚、存档里显示的门店名。

---

### 2.2 `query-meals`

> 在售菜单与价格。这是全游戏唯一的商品与定价来源。

```json
{ "storeCode": "1421136", "orderType": 1, "beType": 1 }
```

真实返回里 `data.meals` **是一个以商品 code 为键的对象，不是数组**（这一点和文档示例不一致，第一次接的时候踩了）。当前门店返回 116 个在售项，含套餐、周边。

**用在哪：** 五座工位的选品条。从 116 项里挑出 13 款真实单品，名称、售价、原价全部原样取用，没有一处是手写死数。

| 工位 | 商品（真实售价） |
|---|---|
| 薯条站 | 薯条 ¥14.5 · 脆脆薯条 ¥16 |
| 炸物站 | 麦乐鸡 ¥14.5 · 麦辣鸡翅 ¥14.5 |
| 饮料站 | 可乐 ¥9.5 · 雪碧 ¥9.5 · 黄金橙橙 ¥13 |
| 组装站 | 巨无霸 ¥26 · 板烧鸡腿堡 ¥24 · 麦辣鸡腿汉堡 ¥23 · 麦香鸡 ¥17 · 麦香鱼 ¥22.5 · 双层吉士汉堡 ¥23 |
| 煎区 | 通用肉饼——**中间工序，不是商品**，不引入任何新数据（见 README 已知限制） |

---

### 2.3 `query-meal-detail`

> 单个商品的详情与可改配料。**组装站的配方就是从这里来的**，这是本项目最核心的一次调用。

```json
{ "storeCode": "1421136", "orderType": 1, "beType": 1, "code": "1100" }
```

关键点是 `data.modification.items[].values[]` 里的 **`selectedQuantity`**：

- `selectedQuantity > 0` → 这个配料是这份汉堡**默认就带的**
- `selectedQuantity == 0` → 这是可加可去的备选项

按这个规则抽出来的真实配方（不是编的）：

| 汉堡 | 默认配料（按顺序） |
|---|---|
| 巨无霸 | 巨无霸酱 · 吉士 · 生菜 · 酸黄瓜 · 洋葱粒 |
| 双层吉士汉堡 | 吉士 · 酸黄瓜 · 洋葱粒 · 番茄酱 · 芥末酱 |
| 板烧鸡腿堡 | 烤味酱 · 切块生菜 |
| 麦辣鸡腿汉堡 | 麦香鸡酱 · 切块生菜 |
| 麦香鸡 | 麦香鸡酱 · 生菜 |
| 麦香鱼 | 麦香鱼酱 · 吉士 |

**用在哪：** 组装站的叠层顺序、配料台上的可点项、订单票上的"照着单子从上往下加"。

顺带一个副作用很好玩：因为配方是真的，玩过之后你会真的记住巨无霸里有什么。

---

### 2.4 `list-nutrition-foods`

> 营养表。158 行，覆盖上述 13 款商品中的全部。

**注意：返回的是一段 CSV 字符串，不是结构化 JSON。**

```
  {productName,nutritionDescription,energyKj,...}:
中薯条,中薯条,1100,289,... 
```

游戏里按 `productName` 建索引，给每款商品挂上热量/蛋白/脂肪/碳水/钠。

**用在哪：** 日结页的营养小结。**只作展示，不做任何健康或营养建议。**

---

### 2.5 `campaign-calendar`

> 活动日历。拿"今天正在发生什么"。

```json
{}
```

从 `dailyList` 里找 `dateText` 含「今日」的那天，再从 `events[].articleDto` 取标题。本次拉到的是「超值𝟗.𝟗元早餐两件套陪你开工啦」。

**用在哪：** 标题页显示今日活动；策划里预留为"每日事件倍率"的输入（当前版本只展示，不参与结算）。

> 这个 Tool 失败不阻塞主流程，`pull-mcp.js` 里用 try/catch 兜住——活动日历挂了，游戏照样能拉数据、照样能玩。

---

## 3. 一次完整调用

```js
// 1) 握手（只需一次，拿 session）
POST https://mcp.mcd.cn
{ jsonrpc:"2.0", id:1, method:"initialize",
  params:{ protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"maimai-mogul",version:"1.0.0"} } }

// 2) 调工具
POST https://mcp.mcd.cn
{ jsonrpc:"2.0", id:1, method:"tools/call",
  params:{ name:"query-meals", arguments:{ storeCode:"1421136", orderType:1, beType:1 } } }

// 3) 取数据
// 优先读 result.structuredContent.data；
// structuredContent.success === false 是业务失败，要单独判。
```

响应可能是普通 JSON，也可能是 SSE（`event: message` + `data: {...}`），`tools/pull-mcp.js` 两种都处理了。

---

## 4. 踩过的坑（都是文档没写的）

| 现象 | 真实情况 | 处理 |
|---|---|---|
| `query-meals` 的 `data.meals` 按数组取 | 实际是以 code 为键的对象 | 用 `Object.keys()` 遍历 |
| `list-nutrition-foods` 以为是 JSON 数组 | 实际是 CSV 字符串，首行还是表头花括号 | 手写 `parseNutrition()` 逐行 split |
| `modification.items` 以为是"可加配料" | 里面混着默认配料，靠 `selectedQuantity` 区分 | `> 0` 才是默认 |
| 商品名带 `【】` 和中文引号，票面上放不下 | 「【美汁源】"黄金橙橙"」有 11 个字 | `shortName()` 去前缀去引号，超 6 字截断 |
| 返回 `success:false` 但 HTTP 200 | 业务失败不走 HTTP 状态码 | 先判 `structuredContent.success` |

---

## 5. 业务价值

说人话：**这个 MCP 让"做一份巨无霸"这件事从假的变成了真的。**

- 没有 MCP 的做法：美术画 6 张汉堡图，程序写死"巨无霸 = 酱 + 菜 + 芝士"，跟麦当劳没有任何关系，换成肯德基也一样跑。
- 有 MCP 的做法：配方来自这家店、这一天的 `query-meal-detail`；价格来自 `query-meals`；今天卖什么、打什么活动来自 `campaign-calendar`。**换一家店、换一天，游戏内容就真的不一样。**

具体到落地：

1. **内容永不过期**：麦当劳上架/下架/调价，重跑一条命令，游戏自动跟上，不用改一行游戏代码。
2. **零人工配表**：13 款商品、6 份配方、158 条营养全部程序化生成，没有一张手填的 Excel。
3. **可信度**：玩家在游戏里看到的 ¥26 巨无霸、5 层配料，和门口那家店是一致的——这对一个"经营游戏"来说是最基本也最难做到的事。
4. **可迁移**：`tools/pull-mcp.js` 和游戏完全解耦。MCP 结构一变，只改这一个文件；要接"就近门店"也只需要把 `--store` 换成 `query-nearby-stores` 的返回值。

---

## 6. 自己验证一遍

```bash
# 只打印不写文件，看拉回来的东西对不对
MCD_MCP_TOKEN=<token> node tools/pull-mcp.js --dry

# 正式拉取：写 data/snapshot.json 并注入 game/index.html
MCD_MCP_TOKEN=<token> node tools/pull-mcp.js --store 1421136
```

期望输出：

```
▶ 拉取门店…   门店：麦当劳深圳腾讯总部园区一店餐厅（1421136）
▶ 拉取菜单…   在线商品 116 项
▶ 拉取营养表… 营养条目 158 条
▶ 拉取活动日历… 今日活动：超值𝟗.𝟗元早餐两件套陪你开工啦
▶ 拉取汉堡配料（6 次）…
  巨无霸 → 巨无霸酱、吉士、生菜、酸黄瓜、洋葱粒
  ...
商品数 13　价格合计 ¥227.0
✔ 写入 data/snapshot.json
✔ 已注入 game/index.html
```

Token 只从环境变量 / `tools/.mcd-token` / 本机 `~/.workbuddy/mcp.json` 读取，三者都在 `.gitignore` 里。仓库内不含任何真实凭证，只保留 `mcp-config.example.json` 这一个占位符样例。
