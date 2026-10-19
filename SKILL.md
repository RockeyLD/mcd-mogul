---
name: maimai-mogul
description: 用麦当劳 MCP 的真实菜单和真实配方开一局「麦麦大亨 · 后厨」做菜游戏。当用户说"开一局麦麦大亨""用我们店的数据跑一下""拉今天的菜单做游戏""换成我家附近的店"时使用。会拉取门店、菜单、汉堡配料、营养、今日活动，注入单文件游戏并在浏览器打开。
---

# 麦麦大亨 · 后厨

把真实麦当劳菜单变成一份能上手做的后厨游戏。

## 前置条件

- 需要麦当劳 MCP Token（[open.mcd.cn](https://open.mcd.cn/mcp) 控制台申请）
- 需要 Node 18+

Token 的查找顺序（脚本里已实现，不要自己再写一份）：

1. 环境变量 `MCD_MCP_TOKEN`
2. `tools/.mcd-token`
3. `~/.workbuddy/mcp.json` 里 `mcpServers["mcd-mcp"].headers.Authorization`

**永远不要把 Token 写进仓库任何文件。** 用户如果直接把 Token 发在对话里，只在命令行里用一次环境变量传入，不要落盘。

## 标准流程

### 1. 确认门店

用户没说具体门店，就用快照里的默认门店 `1421136`（麦当劳深圳腾讯总部园区一店餐厅）。

用户说"我家附近的""我们公司楼下"，就先问地址或门店名，然后用 `query-nearby-stores` 找到对应的 `storeCode`。**门店编码拿不准就问，不要猜。**

### 2. 拉数据

```bash
MCD_MCP_TOKEN=<token> node tools/pull-mcp.js --store <storeCode>
```

先跑一次 `--dry` 看拉回来的东西对不对，再正式跑。

期望看到：门店名、在线商品数（约 116）、营养条目（约 158）、今日活动、6 份汉堡配料。任何一步报错，把这个 Tool 的名字和错误原文告诉用户，不要静默跳过。

### 3. 打开游戏

```bash
open game/index.html
```

或起一个本地服务器（想用 `fetch` 而不是内嵌数据时）：

```bash
python3 -m http.server 8000 --directory game
```

## 改玩法

所有手感参数集中在 `game/index.html` 顶部的常量区，改一行就生效：

| 常量 | 默认 | 含义 |
|---|---|---|
| `FRYER.ms` | 3300 | 一份薯条的熟成总时长（毫秒） |
| `FRYER.slots` | 3 | 油槽数量 |
| `FRYER.rawUntil` | 0.60 | 生→可捞的分界（绿区起点） |
| `BASKET.ms` | 3400 | 一篮炸物到炸糊的时长 |
| `BASKET.shakeFrom` / `shakeTo` | 0.42 / 0.68 | 抖篮窗口；错过粘连（质量封顶 0.35） |
| `GRILL.sideMs` | 2500 | 肉饼单面煎制时长 |
| `GRILL.readyAt` | 0.58 | 单面可翻面 / 可起锅的进度 |
| `GRILL.warmCap` | 4 | 保温盘（组装堡必须消耗一块） |
| `FRESH.grace` / `rate` / `floor` | 7000 / 0.06 / 0.50 | 出餐架保鲜：7 秒后每秒掉 6% |
| `DRINK.ms` | 2000 | 注满一杯的时长 |
| `DRINK.low` / `DRINK.high` | 0.69 / 0.94 | 饮料绿区上下线 |
| `Q_CORE` / `Q_SLOPE` | 0.18 / 1.55 | 完美带半宽（占绿区半宽比例）/ 出带后的掉分斜率 |
| `PERFECT_Q` / `GOOD_Q` | 0.90 / 0.70 | 完美 / 良好的质量分界线 |
| `TIP_TIERS` | 12/5/2/0 % | 按质量分档发小费，对应 0.90 / 0.75 / 0.60 / 更低 |
| `SHELF_CAP` | 8 | 出餐架格数 |
| `MAX_ORDERS` | 7 | 同时在排的订单上限 |
| `ECON.dayMs` | 60000 | 一天多少毫秒 |

经济学参数在 `data/economy.json` 里（`days` / `startCash` / `rent` / `rentStep` / `lostPenalty` / `grades`），改完跑 `node tools/sync-economy.js` 同步进快照和内嵌块。
客流与耐心在 `dayCfg()` 里随天数递减。

改完必须**真的跑一遍**再告诉用户"好了"。至少验证：

```bash
# 1) 语法过得去
node -e "const h=require('fs').readFileSync('game/index.html','utf8');new Function(h.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1]);console.log('JS OK')"

# 2) 机器人跑完整 5 天，看服务率 / 评级 / 现金守恒
NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
  node tools/harness.js game/index.html smart 16 80000
```

判据：`smart` 落在 A 线附近（930~1050）、服务率 90%±、现金守恒误差 ≤ ¥4；`dumb` 应该很快破产。
单局噪声不小（同档两局能差 ¥300），评级线只能算"大致对"，真正的校准靠真人试玩。

## 加一道新菜

数据侧：在 `tools/pull-mcp.js` 的 `MENU` 里加一条 `{ code, nutritionName }`（注意放在对应的工位数组里：`fries` / `basket` / `drink` / `assembly`），重跑脚本。
游戏侧：不用改。新菜会按 `station` 自动出现在对应工位的选品条里；如果它属于 `assembly`，还需要在 `TOPPING_STYLE` 里给它用到的每种配料补一个颜色和形状。

## 加工位

`game/index.html` 里的 `STATIONS` 是工位注册表：tab、角标、调度全走它。
加一座站 = 在表里加一行 + 写一个 `renderXxx()` 和一个 `paintXxx()`，再在两个分发函数里补一个分支。
**别把工位逻辑写死在 `renderTabs` / `paint` 里**——那是三工位版的老写法。

## 边界

- 不编造商品、价格、配料。MCP 没返回的东西就如实说没有。
- 营养数据只做展示，绝不输出健康或营养建议。
- 不做竞品对比，不贬低任何品牌。
- 游戏内与本 Skill 输出均标注：非麦当劳官方产品。
