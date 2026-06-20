# 海鸟环志站API

运行：

```bash
npm start
```

默认端口`3034`。支持环号唯一档案、测量、复捕、迁徙观测、复捕率统计、**野外作业场次**管理，以及**环号库存与批次发放**管理，并提供**物种与站点字典**模块用于收敛 `species`、`capturePlace`、`season` 字段的取值。

---

## 多文件数据仓库架构（v2）

### 架构概述

将原来的单文件 `data/seabirds.json` 拆分为**按数据类型分开的 JSON 文件**，通过独立的数据访问层 `dataStore.js` 统一管理，实现：

- ✅ **首次启动自动迁移**：检测到 `data/seabirds.json` 时自动拆分并生成新结构
- ✅ **API 完全兼容**：所有现有接口的请求/响应格式与旧版完全一致
- ✅ **原子写入防半写**：写文件采用「临时文件 → rename」两步法，进程中断不会损坏主文件
- ✅ **server.js 瘦身**：仅负责路由分发，所有业务逻辑下沉到 `birdsService.js` 等服务层

### 物理文件结构

```
data/
├── birds.json          # 鸟类主档案（不含子记录数组）
├── events.json         # 所有事件子记录（measurements/releases/recaptures/observations）
├── reports.json        # 报表缓存（预留扩展）
├── dictionaries.json   # 字典（已独立）
├── fieldSessions.json  # 野外作业场次（已独立）
├── ringInventory.json  # 环号库存（已独立）
├── auditLogs.json      # 审计日志（已独立）
├── seabirds.json       # 旧文件（迁移时读取，迁移后可手动删除）
└── snapshots/          # 备份快照目录
```

### birds.json 结构（鸟类主档案）

```json
{
  "birds": [
    {
      "ringNo": "SB-26001",
      "species": "黑尾鸥",
      "sex": "unknown",
      "age": "adult",
      "capturePlace": "东礁A区",
      "season": "2026春",
      "fieldSessionId": "FS-2026-0503-001",
      "healthRisk": { "level": "low", "score": 0, "...": "..." }
    }
  ]
}
```

### events.json 结构（事件记录扁平化）

```json
{
  "events": [
    {
      "ringNo": "SB-26001",
      "eventType": "measurements",
      "eventIndex": 0,
      "data": { "at": "2026-05-03", "wing": 328, "weight": 512, "bill": 44, "fieldSessionId": "FS-2026-0503-001" }
    },
    {
      "ringNo": "SB-26001",
      "eventType": "recaptures",
      "eventIndex": 0,
      "data": { "at": "2026-06-11", "place": "东礁B区", "note": "换羽正常", "fieldSessionId": "FS-2026-0611-001" }
    }
  ]
}
```

`eventType` 取值：`measurements` | `releases` | `recaptures` | `observations`
`eventIndex`：保证同一鸟同一类型内按原顺序还原。

### 模块分层图

```
┌─────────────────────────────────────────────────┐
│                   server.js                     │
│  (HTTP 路由分发 + 错误映射，无直接文件读写)      │
└─────────────────────┬───────────────────────────┘
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
 birdsService.js   fieldSessions.js   ringInventory.js
 dictionaries.js   importPreview.js   backupService.js
 migrationRoutes   auditLog.js        healthRisk.js
     │                │                │
     └────────────────┼────────────────┘
                      ▼
             ┌─────────────────┐
             │   dataStore.js  │  ← 统一数据访问层
             │  - 自动迁移     │
             │  - 原子写入     │
             │  - 组装/拆分    │
             └────────┬────────┘
                      ▼
             data/*.json (多文件)
```

### 原子写入机制

所有写操作通过 `dataStore.atomicWriteFile(filePath, data)`：

```
1. JSON.stringify(data) → 生成完整字符串
2. writeFile("xxx.json.tmp.<时间戳>-<随机串>") → 写到临时文件
3. rename("临时文件", "xxx.json") → 原子替换
```

进程在步骤 1/2 中断：主文件毫发无损（仍是旧版本）
进程在步骤 3 中断：取决于操作系统，现代文件系统的 rename 是原子的。
遗留的 `.tmp.*` 文件可以手动清理，不影响数据完整性。

### 数据迁移 README 流程

---

#### 场景 A：已有 `data/seabirds.json` 旧数据 → 首次启动自动迁移

**迁移前验证：**

```bash
# 1. 确认旧数据存在
ls -la data/seabirds.json

# 2. 统计旧数据中的鸟数量
python3 -c "import json; d=json.load(open('data/seabirds.json')); print('旧库鸟数:', len(d['birds']))"

# 3. 先备份旧文件
cp data/seabirds.json data/seabirds.json.backup-$(date +%Y%m%d-%H%M%S)

# 4. 确认新文件不存在（首次迁移）
ls data/birds.json data/events.json data/reports.json 2>/dev/null || echo "新结构文件不存在，将执行迁移"
```

**执行迁移（就是启动服务）：**

```bash
npm start
```

预期控制台输出（出现迁移日志）：
```
[dataStore] 数据结构初始化完成 (从旧文件迁移: 4 birds, 10 events)
Seabird banding API listening on http://localhost:3034
```

**迁移后验证（curl 逐步验证）：**

```bash
# 1. 根路由 - 查看迁移状态（migrationState.hasMigrated=true）
curl -s http://localhost:3034/ | python3 -m json.tool

# 2. GET /birds - 鸟类总数应与旧库一致
curl -s http://localhost:3034/birds | python3 -c "import sys,json; d=json.load(sys.stdin); print('迁移后鸟数:', len(d), '鸟环号列表:', [b['ringNo'] for b in d])"

# 3. GET /birds - 支持 species、season、capturePlace、fieldSessionId、healthRiskLevel 组合筛选
curl -s 'http://localhost:3034/birds?species=黑尾鸥&season=2026春&capturePlace=东礁A区&fieldSessionId=FS-2026-0503-001&healthRiskLevel=high' | python3 -c "import sys,json; d=json.load(sys.stdin); print('组合筛选鸟数:', len(d), '鸟环号列表:', [b['ringNo'] for b in d])"

# 4. GET /birds/SB-26001/history - 子记录完整（measurements/releases/recaptures/observations 都在）
curl -s http://localhost:3034/birds/SB-26001/history | python3 -m json.tool

# 5. 统计 - 复捕率应与旧数据一致
curl -s 'http://localhost:3034/reports/recapture-rate?season=2026春' | python3 -m json.tool

# 6. 统计 - 健康风险报告
curl -s http://localhost:3034/health-risk/report | python3 -c "import sys,json; d=json.load(sys.stdin); print('总数:', d['total'], '按等级:', d['byLevel'])"

# 7. 比对物理文件
echo "=== 新结构文件 ==="
ls -la data/birds.json data/events.json data/reports.json
echo "=== birds.json 鸟数 ==="
python3 -c "import json; d=json.load(open('data/birds.json')); print(len(d['birds']))"
echo "=== events.json 按类型分组 ==="
python3 -c "
import json
from collections import Counter
d = json.load(open('data/events.json'))
print('事件总数:', len(d['events']))
print('按类型:', dict(Counter(e['eventType'] for e in d['events'])))
print('按环号:', dict(Counter(e['ringNo'] for e in d['events'])))
"

# 7. 验证字典自动迁移 - GET /dictionaries
curl -s http://localhost:3034/dictionaries | python3 -m json.tool
```

**写操作完整性验证（追加一条复捕）：**

```bash
# 1. 先追加一条复捕记录
curl -s -X POST http://localhost:3034/birds/SB-26001/recaptures \
  -H 'Content-Type: application/json' \
  -d '{"at":"2026-06-20","place":"东礁A区","note":"验证原子写入-正常换羽"}' \
  | python3 -m json.tool

# 2. 再次 GET 历史确认写入
curl -s http://localhost:3034/birds/SB-26001/history | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('复捕记录数:', len(d['recaptures']))
for r in d['recaptures']: print(' -', r['at'], r['place'], r.get('note',''))
"

# 3. 验证物理文件：events.json 有这条新记录
python3 -c "
import json
d = json.load(open('data/events.json'))
new_events = [e for e in d['events'] if e['eventType']=='recaptures' and e['data'].get('note','').startswith('验证原子写入')]
print('新增事件数:', len(new_events))
print(new_events[0] if new_events else '未找到')
"

# 4. 模拟写入中进程被 kill（可选，验证半写入防护）：
#    - 手动在写入时杀进程，重启后 birds.json/events.json 仍能正常解析
```

---

#### 场景 B：全新部署（没有旧数据）

系统会自动写入种子数据（SB-26001 及其 4 条事件记录）。

```bash
rm -rf data/birds.json data/events.json data/reports.json
npm start
```

验证：

```bash
curl -s http://localhost:3034/birds | python3 -c "import sys,json; d=json.load(sys.stdin); print('种子鸟数:', len(d), '种子鸟:', [b['ringNo'] for b in d])"
```

---

#### 场景 C：备份/恢复 - 快照与新结构协作

快照格式保持**兼容视图**不变（即快照 data 字段仍是旧的 `{birds:[...]}` 结构），但恢复时会自动拆分回 `birds.json + events.json`。

```bash
# 1. 创建快照
curl -s -X POST http://localhost:3034/backups/snapshots | python3 -m json.tool

# 2. 故意写坏数据 - 新增一条鸟
curl -s -X POST http://localhost:3034/birds \
  -H 'Content-Type: application/json' \
  -d '{"ringNo":"SB-26999","species":"黑尾鸥","sex":"unknown","capturePlace":"东礁A区","season":"2026春"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('新增:', d.get('ringNo'))"

# 3. 恢复快照（用上面步骤 1 返回的 snapshotId）
# curl -s -X POST http://localhost:3034/backups/snapshots/<SNAPSHOT_ID>/restore | python3 -m json.tool

# 4. 验证 SB-26999 已消失
curl -s http://localhost:3034/birds/SB-26999/history -o /dev/null -w "HTTP状态: %{http_code}\n"
# 预期：HTTP 404（已被恢复删除）
```

---

## 物种与站点字典模块

将 `species`（物种）、`capturePlace`（环志礁区）、`season`（环志季节）从自由文本逐步收敛为可维护字典。所有新建鸟档案、作业场次、复捕/放飞记录时均会校验对应字段是否存在于字典中。

### 数据存储

字典数据存储在 `data/dictionaries.json`：

```json
{
  "species": [
    { "value": "黑尾鸥", "description": null, "createdAt": "...", "updatedAt": "..." }
  ],
  "capturePlace": [
    { "value": "东礁A区", "description": null, "createdAt": "...", "updatedAt": "..." }
  ],
  "season": [
    { "value": "2026春", "description": null, "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### 自动迁移历史数据

首次启动时，若 `data/dictionaries.json` 不存在，系统会自动：

1. 预置强制迁移值：**黑尾鸥**（species）、**东礁A区**（capturePlace）、**东礁B区**（capturePlace）、**2026春**（season）
2. 扫描现有 `data/seabirds.json` 和 `data/fieldSessions.json`，收集全部已有的 `species`、`capturePlace`、`season` 值，一并写入字典

### 兼容旧数据的行为

- **读取操作**：所有查询接口（`GET /birds`、`GET /field-sessions` 等）**不受字典约束**，历史数据中不在字典内的值仍可正常读取和展示
- **新建操作**：`POST /birds`、`POST /field-sessions`、`POST /birds/:ringNo/recaptures`、`POST /birds/:ringNo/releases` 等新建接口**强制校验**字典值，若值不在字典中则返回 400 错误，提示先在字典中添加
- **更新操作**：`PUT /field-sessions/:id` 若更新 `season` 或 `capturePlace` 字段，则校验新值；未涉及的字段不校验
- **批量导入**：`POST /import/preview` 会校验每条记录的 `species`、`capturePlace`、`season`，不在字典中的值以警告形式返回（`unknownSpecies`、`dictValidationErrors`），但不阻断导入；`POST /import/commit/:previewId` 在实际写入时同样强制执行字典校验
- **字典删除**：删除字典条目不会影响已存在的历史数据，但之后新建记录无法再使用该值

### 1. 查询字典总览

**GET /dictionaries**

返回所有字典类型及各类型的条目数量：

```json
{
  "types": ["species", "capturePlace", "season"],
  "counts": {
    "species": 2,
    "capturePlace": 2,
    "season": 1
  }
}
```

### 2. 查询指定字典的所有条目

**GET /dictionaries/:type**

`:type` 可选值：`species` | `capturePlace` | `season`

示例 `GET /dictionaries/species` 响应（200）：

```json
[
  {
    "value": "黑尾鸥",
    "description": null,
    "createdAt": "2026-06-20T00:00:00.000Z",
    "updatedAt": "2026-06-20T00:00:00.000Z"
  }
]
```

### 3. 新增字典条目

**POST /dictionaries/:type**

请求体：

```json
{
  "value": "黑嘴鸥",
  "description": "Saunders's Gull，易危物种"
}
```

- `value` 必填，不能为空，同一字典内不可重复
- `description` 可选，默认为 `null`

响应（201）：返回新建的完整字典条目对象。

冲突时返回 409 `entry_already_exists`。

### 4. 更新字典条目

**PUT /dictionaries/:type/:value**

`:value` 为 URL 编码后的当前字典值。

请求体（可部分更新）：

```json
{
  "value": "黑嘴鸥（新名）",
  "description": "更新后的描述"
}
```

- 仅传 `description` 可只修改描述
- 修改 `value` 时新值不能与同字典已有值重复

响应（200）：返回更新后的完整字典条目对象。

### 5. 删除字典条目

**DELETE /dictionaries/:type/:value**

响应（200）：`{ "deleted": true }`

不存在时返回 404 `entry_not_found`。

### 校验失败响应示例

当新建鸟档案使用了不在字典中的物种时：

```json
{
  "status": 400,
  "error": "dictionary_validation_failed",
  "message": "字段「species」的值「未知鸟种」不在字典中，请先在字典中添加",
  "details": [
    { "valid": false, "type": "species", "value": "未知鸟种", "reason": "not_in_dictionary" }
  ]
}
```

---

## 野外作业场次 API

用于记录某一天某个礁区的作业情况（作业队、天气、潮汐、捕获/放飞数量、异常备注），并把新建鸟档案、测量、复捕、观察、放飞记录关联到同一个作业场次。

### 数据存储结构

作业场次数据存储在 `data/fieldSessions.json`：

```json
{
  "fieldSessions": [
    {
      "id": "FS-2026-0503-001",
      "date": "2026-05-03",
      "season": "2026春",
      "capturePlace": "东礁A区",
      "team": ["张三", "李四", "王五"],
      "weather": "晴，风力3级",
      "tide": "高潮 08:20，潮高2.1m",
      "capturedCount": 15,
      "releasedCount": 15,
      "notes": "鸟群活跃度高，无异常情况",
      "createdAt": "2026-05-03T10:00:00.000Z",
      "updatedAt": "2026-05-03T18:00:00.000Z"
    }
  ]
}
```

**鸟类记录关联说明：**
- 鸟档案本身支持 `fieldSessionId` 字段，表示该鸟在哪一场次首次被环志
- `measurements`、`recaptures`、`observations`、`releases` 的每条子记录也支持各自的 `fieldSessionId`
- 创建鸟档案时，如果提供了 `fieldSessionId`，其 `measurements` 和 `releases` 子记录会自动继承该 `fieldSessionId`（除非子记录显式指定）

### 1. 创建作业场次

**POST /field-sessions**

必填字段：`date`、`season`、`capturePlace`

请求体：
```json
{
  "date": "2026-06-20",
  "season": "2026春",
  "capturePlace": "西礁C区",
  "team": ["赵六", "钱七"],
  "weather": "晴，风力2级",
  "tide": "低潮 07:30，潮高0.5m",
  "capturedCount": 12,
  "releasedCount": 12,
  "notes": "测试场次"
}
```

响应（201）：
```json
{
  "id": "FS-2026-0620-91IX",
  "date": "2026-06-20",
  "season": "2026春",
  "capturePlace": "西礁C区",
  "team": ["赵六", "钱七"],
  "weather": "晴，风力2级",
  "tide": "低潮 07:30，潮高0.5m",
  "capturedCount": 12,
  "releasedCount": 12,
  "notes": "测试场次",
  "createdAt": "2026-06-20T09:14:09.501Z",
  "updatedAt": "2026-06-20T09:14:09.501Z"
}
```

### 2. 查询作业场次列表

**GET /field-sessions**

查询参数：
- `season` (可选)：按季节筛选，如 `?season=2026春`
- `capturePlace` (可选)：按礁区筛选，如 `?capturePlace=东礁A区`
- `dateFrom` (可选)：起始日期（含），如 `?dateFrom=2026-05-01`
- `dateTo` (可选)：截止日期（含），如 `?dateTo=2026-05-31`

示例：`GET /field-sessions?season=2026春&dateFrom=2026-05-01&dateTo=2026-06-30`

响应（200）：作业场次数组，按日期升序排列。

### 3. 查询作业场次详情（含关联鸟类）

**GET /field-sessions/:id** 或 **GET /field-sessions/:id/detail**

返回作业场次基本信息，以及：
- `relatedBirds`：在该场次首次环志的鸟类档案（过滤出属于该场次的子记录）
- `recapturedBirds`：在该场次被复捕、但并非本场次首次环志的鸟

响应（200）：
```json
{
  "id": "FS-2026-0503-001",
  "date": "2026-05-03",
  "season": "2026春",
  "capturePlace": "东礁A区",
  "team": ["张三", "李四", "王五"],
  "weather": "晴，风力3级",
  "tide": "高潮 08:20，潮高2.1m",
  "capturedCount": 15,
  "releasedCount": 15,
  "notes": "鸟群活跃度高，无异常情况",
  "relatedBirds": [
    {
      "ringNo": "SB-26001",
      "species": "黑尾鸥",
      "sex": "unknown",
      "age": "adult",
      "capturePlace": "东礁A区",
      "measurements": [
        { "at": "2026-05-03", "wing": 328, "weight": 512, "bill": 44, "fieldSessionId": "FS-2026-0503-001" }
      ],
      "recaptures": [],
      "observations": [],
      "releases": [
        { "at": "2026-05-03T09:40:00.000Z", "place": "东礁A区", "fieldSessionId": "FS-2026-0503-001" }
      ]
    }
  ],
  "recapturedBirds": []
}
```

### 4. 更新作业场次

**PUT /field-sessions/:id**

请求体可包含任意需要更新的字段（`id`、`createdAt` 不可改）。

请求体：
```json
{
  "capturedCount": 15,
  "releasedCount": 14,
  "notes": "发现1只异常未放飞"
}
```

响应（200）：更新后的完整作业场次对象。

### 5. 删除作业场次

**DELETE /field-sessions/:id**

响应（200）：`{ "deleted": true }`

### 6. 查询作业场次摘要（带统计）

**GET /field-sessions/summary**

查询参数与列表接口相同：
- `season` (可选)：按季节筛选
- `capturePlace` (可选)：按礁区筛选
- `dateFrom` (可选)：起始日期（含）
- `dateTo` (可选)：截止日期（含）

返回的每条场次记录额外包含 `computedStats` 统计字段，从鸟类记录中自动汇总：
- `newBirds`：本场次新建的鸟档案数量
- `measurements`：本场次关联的测量记录数
- `recaptures`：本场次关联的复捕记录数
- `observations`：本场次关联的观察记录数
- `releases`：本场次关联的放飞记录数
- `speciesBreakdown`：按物种分组的环志数/复捕数

响应示例（200）：
```json
[
  {
    "id": "FS-2026-0503-001",
    "date": "2026-05-03",
    "season": "2026春",
    "capturePlace": "东礁A区",
    "team": ["张三", "李四", "王五"],
    "weather": "晴，风力3级",
    "tide": "高潮 08:20，潮高2.1m",
    "capturedCount": 15,
    "releasedCount": 15,
    "notes": "鸟群活跃度高，无异常情况",
    "computedStats": {
      "newBirds": 1,
      "measurements": 1,
      "recaptures": 0,
      "observations": 0,
      "releases": 1,
      "speciesBreakdown": [
        { "species": "黑尾鸥", "banded": 1, "recaptured": 0 }
      ]
    }
  }
]
```

### 7. 鸟类记录关联作业场次

**创建鸟档案时关联：**
`POST /birds` 请求体中加入 `fieldSessionId`：

```json
{
  "ringNo": "SB-26003",
  "species": "黑尾鸥",
  "sex": "male",
  "age": "subadult",
  "capturePlace": "西礁C区",
  "season": "2026春",
  "fieldSessionId": "FS-2026-0620-91IX",
  "measurements": [{ "wing": 315, "weight": 490, "bill": 42 }]
}
```

创建后，鸟档案、其 `measurements` 和 `releases` 子记录会自动带上该 `fieldSessionId`。

**添加子记录时关联：**
`POST /birds/:ringNo/measurements|recaptures|observations|releases` 请求体中加入 `fieldSessionId`：

```json
{
  "at": "2026-06-20",
  "place": "西礁C区",
  "note": "状态良好",
  "fieldSessionId": "FS-2026-0620-91IX"
}
```

---

## 环号库存与批次发放 API

### 1. 登记批次并生成环号

**POST /ring-inventory/batches**

登记一个环号批次，按区间自动生成可用环号。自动跳过与已有 `birds.ringNo` 重复的环号。

请求体：
```json
{
  "prefix": "SB",
  "startNo": 27000,
  "endNo": 27010,
  "season": "2026秋",
  "description": "2026年秋季黑尾鸥环志批次"
}
```

响应（201）：
```json
{
  "batch": {
    "id": "BATCH-2026秋-ABC123",
    "prefix": "SB",
    "startNo": 27000,
    "endNo": 27010,
    "season": "2026秋",
    "description": "2026年秋季黑尾鸥环志批次",
    "createdAt": "2026-06-20T10:00:00.000Z",
    "totalGenerated": 11,
    "conflicts": []
  },
  "generated": 11,
  "conflicts": []
}
```

### 2. 查询批次列表

**GET /ring-inventory/batches**

查询参数：
- `season` (可选)：按季节筛选，如 `?season=2026春`

响应（200）：
```json
[
  {
    "id": "BATCH-2026-SPRING-001",
    "prefix": "SB",
    "startNo": 26000,
    "endNo": 26999,
    "season": "2026春",
    "description": "2026年春季黑尾鸥环志批次",
    "createdAt": "2026-01-15T00:00:00.000Z",
    "totalRings": 2,
    "available": 1,
    "allocated": 1
  }
]
```

### 3. 查询环号列表

**GET /ring-inventory/rings**

查询参数：
- `status` (可选)：`available` 或 `allocated`
- `batchId` (可选)：按批次筛选
- `ringNo` (可选)：按环号精确查询

示例：`GET /ring-inventory/rings?status=available`

响应（200）：
```json
[
  {
    "ringNo": "SB-26002",
    "batchId": "BATCH-2026-SPRING-001",
    "status": "available",
    "allocatedTo": null,
    "allocatedAt": null
  }
]
```

### 4. 获取下一个可用环号

**GET /ring-inventory/rings/available**

查询参数：
- `batchId` (可选)：指定批次

响应（200）：
```json
{
  "ringNo": "SB-26002",
  "batchId": "BATCH-2026-SPRING-001",
    "status": "available",
    "allocatedTo": null,
    "allocatedAt": null
}
```

### 5. 分配指定环号

**POST /ring-inventory/rings/allocate**

请求体：
```json
{
  "ringNo": "SB-26002",
  "allocatedTo": "环志员-张三-20260620",
  "season": "2026春"
}
```

响应（200）：
```json
{
  "ringNo": "SB-26002",
  "batchId": "BATCH-2026-SPRING-001",
  "status": "allocated",
  "allocatedTo": "环志员-张三-20260620",
  "allocatedAt": "2026-06-20T10:30:00.000Z"
}
```

### 6. 自动分配下一个可用环号

**POST /ring-inventory/rings/allocate-next**

请求体：
```json
{
  "batchId": "BATCH-2026-SPRING-001",
  "allocatedTo": "环志员-李四-20260620",
  "season": "2026春"
}
```

响应（200）：
```json
{
  "ringNo": "SB-26003",
  "batchId": "BATCH-2026-SPRING-001",
  "status": "allocated",
  "allocatedTo": "环志员-李四-20260620",
  "allocatedAt": "2026-06-20T10:35:00.000Z"
}
```

### 7. 释放环号

**POST /ring-inventory/rings/release**

请求体：
```json
{
  "ringNo": "SB-26002"
}
```

响应（200）：
```json
{
  "ringNo": "SB-26002",
  "batchId": "BATCH-2026-SPRING-001",
  "status": "available",
  "allocatedTo": null,
  "allocatedAt": null
}
```

---

## 错误码说明

| 错误码 | HTTP状态 | 说明 |
|--------|----------|------|
| `invalid_batch_params` | 400 | 批次参数无效 |
| `missing_params` | 400 | 缺少必填参数 |
| `ring_not_found` | 404 | 环号不存在 |
| `no_available_rings` | 404 | 没有可用环号 |
| `ring_already_allocated` | 409 | 环号已被分配 |
| `ring_already_used_in_birds` | 409 | 环号已在 birds 记录中使用 |

---

## 最小示例数据

系统首次启动时会自动创建示例数据：

### 示例批次
```json
{
  "id": "BATCH-2026-SPRING-001",
  "prefix": "SB",
  "startNo": 26000,
  "endNo": 26999,
  "season": "2026春",
  "description": "2026年春季黑尾鸥环志批次"
}
```

### 示例环号
| 环号 | 状态 | 分配给 |
|------|------|--------|
| SB-26001 | allocated | SB-26001 (已绑定鸟类记录) |
| SB-26002 | available | - |

---

## 原有接口

### 鸟类记录管理
- `GET /birds` - 查询鸟类列表，支持 `?species=&season=&capturePlace=&fieldSessionId=&healthRiskLevel=` 组合筛选
- `POST /birds` - 创建鸟类记录（自动检查 ringNo 重复，支持 `fieldSessionId` 关联作业场次，子记录自动继承）
- `GET /birds/:ringNo/history` - 查询单只鸟完整档案
- `POST /birds/:ringNo/measurements` - 添加测量数据（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/recaptures` - 添加复捕记录（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/observations` - 添加观测记录（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/releases` - 添加放飞记录（请求体支持 `fieldSessionId` 关联作业场次）

### 统计报表
- `GET /reports/recapture-rate?season=` - 按季节统计复捕率

---

## 离线采集包同步 API

野外端可通过 `POST /offline-sync` 提交离线采集包。服务端会按事件时间写入数据，返回成功数量、冲突、失败和跳过明细；同一 `packetId` 重复提交会返回已处理结果并标记 `idempotent: true`。现有 `POST /birds`、`POST /birds/:ringNo/measurements` 等单条写入接口保持原有行为。

### 请求示例

```bash
curl -s -X POST http://localhost:3034/offline-sync \
  -H 'Content-Type: application/json' \
  -d '{
    "packetId": "SYNC-FIELD-20260620-001",
    "fieldSessions": [
      {
        "tempId": "session-temp-1",
        "date": "2026-06-20",
        "season": "2026春",
        "capturePlace": "东礁A区",
        "team": ["张三", "李四"],
        "capturedCount": 1,
        "releasedCount": 1
      }
    ],
    "birds": [
      {
        "tempId": "bird-temp-1",
        "ringNo": "SB-26030",
        "species": "黑尾鸥",
        "sex": "female",
        "age": "adult",
        "capturePlace": "东礁A区",
        "season": "2026春",
        "fieldSessionId": "session-temp-1",
        "measurements": [
          { "at": "2026-06-20T08:10:00.000Z", "wing": 322, "weight": 506, "bill": 43 }
        ],
        "releases": [
          { "at": "2026-06-20T09:30:00.000Z", "place": "东礁A区" }
        ]
      }
    ],
    "events": [
      {
        "tempId": "obs-temp-1",
        "birdTempId": "bird-temp-1",
        "eventType": "observations",
        "data": {
          "at": "2026-06-20T11:00:00.000Z",
          "point": "N30.1,E122.3",
          "note": "近岸盘旋"
        }
      }
    ]
  }' | python3 -m json.tool
```

### 响应示例

成功写入返回 `200`：

```json
{
  "packetId": "SYNC-FIELD-20260620-001",
  "processedAt": "2026-06-20T11:05:00.000Z",
  "success": {
    "birds": 1,
    "events": 3,
    "sessions": 1
  },
  "conflicts": [],
  "failures": [],
  "skipped": [],
  "ringNoConflicts": [],
  "status": "success",
  "idempotent": false
}
```

部分失败返回 `207`，例如包内包含已存在环号和非法事件类型：

```json
{
  "packetId": "SYNC-FIELD-20260620-002",
  "success": {
    "birds": 0,
    "events": 0,
    "sessions": 0
  },
  "conflicts": [
    {
      "type": "bird",
      "tempId": "bird-conflict-1",
      "ringNo": "SB-26001",
      "reason": "ring_already_exists_in_db"
    }
  ],
  "failures": [
    {
      "type": "event",
      "tempId": "event-invalid-1",
      "eventType": "invalid_type",
      "reason": "missing_ring_no_or_temp_id_mapping"
    }
  ],
  "skipped": [],
  "ringNoConflicts": [
    {
      "tempId": "bird-conflict-1",
      "ringNo": "SB-26001",
      "reason": "ring_already_exists_in_db"
    }
  ],
  "status": "partial_success",
  "idempotent": false
}
```

---

## 导入预览 API

批量导入海鸟环志记录的**两步式**流程：先提交校验 → 确认后写入。现有 `POST /birds` 手工录入流程不受影响。

### 流程说明

```
提交一批 JSON  ──→  POST /import/preview  ──→  返回校验结果 + previewId
                                                    │
                                          ┌─────────┴──────────┐
                                          │ 阻断性错误？        │
                                          │ (缺字段/环号已存在)  │
                                          └─────────┬──────────┘
                                             否 ↓         ↓ 是
                                    确认写入          修正后重新预览
                              POST /import/commit/:id
```

### 校验规则

| 检查项 | 类型 | 说明 |
|--------|------|------|
| 必填字段缺失 | 阻断 | 每条记录必须包含 `ringNo` 和 `species` |
| 环号与数据库重复 | 阻断 | `ringNo` 不能与 `data/seabirds.json` 已有记录冲突 |
| 批次内环号重复 | 警告 | 同一批次内出现相同 `ringNo`，仅提示不阻断 |
| 缺失测量值 | 警告 | 没有 `measurements` 或为空数组，仅提示不阻断 |
| 未知物种 | 警告 | `species` 不在已知物种列表中，仅提示不阻断 |

### 已知物种列表

内置已知物种：黑尾鸥、黑嘴鸥、遗鸥、红嘴鸥、普通燕鸥、白额圆尾鹱、黑叉尾海燕、大凤头燕鸥、粉红燕鸥、褐翅燕鸥、灰背鸥、海鸥、北极鸥、三趾鸥。

数据库中已有的物种会自动加入已知列表。

### 1. 提交预览

**POST /import/preview**

请求体：
```json
{
  "records": [
    {
      "ringNo": "SB-26003",
      "species": "黑尾鸥",
      "sex": "male",
      "age": "adult",
      "capturePlace": "东礁A区",
      "season": "2026春",
      "fieldSessionId": "FS-2026-0503-001",
      "measurements": [{ "wing": 320, "weight": 498, "bill": 43 }]
    },
    {
      "ringNo": "SB-26004",
      "species": "黑嘴鸥",
      "sex": "female",
      "age": "subadult",
      "capturePlace": "东礁B区",
      "season": "2026春"
    }
  ]
}
```

响应（200）：
```json
{
  "previewId": "IMP-M1R2K3-abc123",
  "status": "ready",
  "validation": {
    "totalRecords": 2,
    "validRecords": 2,
    "fieldErrors": [],
    "duplicateInBatch": [],
    "duplicateInDb": [],
    "missingMeasurements": [
      { "index": 1, "ringNo": "SB-26004" }
    ],
    "unknownSpecies": [],
    "hasBlockingErrors": false
  },
  "createdAt": "2026-06-20T10:00:00.000Z"
}
```

- `status` 为 `"ready"` 时可提交确认写入
- `status` 为 `"blocked"` 时存在阻断性错误，需修正后重新提交预览

### 2. 查看预览

**GET /import/preview/:previewId**

预览缓存有效期为 30 分钟，过期后需重新提交。

响应（200）：
```json
{
  "previewId": "IMP-M1R2K3-abc123",
  "status": "ready",
  "validation": { ... },
  "createdAt": "2026-06-20T10:00:00.000Z",
  "committedAt": null
}
```

### 3. 确认写入

**POST /import/commit/:previewId**

确认后批量写入 `data/seabirds.json`，同时同步环号库存。每个 previewId 只能提交一次。

响应（200）：
```json
{
  "previewId": "IMP-M1R2K3-abc123",
  "imported": 2,
  "skipped": 0,
  "skippedDetails": []
}
```

### curl 验证示例

**1）正常批量导入（无阻断错误）**

```bash
# 步骤1：提交预览
curl -s -X POST http://localhost:3034/import/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "records": [
      {
        "ringNo": "SB-26009",
        "species": "黑尾鸥",
        "sex": "male",
        "age": "adult",
        "capturePlace": "东礁A区",
        "season": "2026春",
        "measurements": [{ "wing": 325, "weight": 505, "bill": 44 }]
      },
      {
        "ringNo": "SB-26010",
        "species": "红嘴鸥",
        "sex": "female",
        "age": "subadult",
        "capturePlace": "东礁B区",
        "season": "2026春",
        "measurements": [{ "wing": 280, "weight": 320, "bill": 35 }]
      }
    ]
  }' | python3 -m json.tool

# 步骤2：记下返回的 previewId，确认写入（替换 <PREVIEW_ID>）
curl -s -X POST http://localhost:3034/import/commit/<PREVIEW_ID> | python3 -m json.tool

# 步骤3：验证写入结果
curl -s http://localhost:3034/birds | python3 -m json.tool
```

**2）含阻断性错误的预览（重复环号 + 缺字段）**

```bash
curl -s -X POST http://localhost:3034/import/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "records": [
      {
        "ringNo": "SB-26001",
        "species": "黑尾鸥",
        "age": "adult"
      },
      {
        "species": "黑嘴鸥",
        "age": "subadult"
      }
    ]
  }' | python3 -m json.tool
```

预期返回 `status: "blocked"`，`duplicateInDb` 包含 `SB-26001`，`fieldErrors` 包含缺少 `ringNo` 的记录。

**3）含警告但不阻断的预览（缺失测量值 + 未知物种）**

```bash
curl -s -X POST http://localhost:3034/import/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "records": [
      {
        "ringNo": "SB-26007",
        "species": "某种新海鸟",
        "capturePlace": "西礁D区",
        "season": "2026春"
      }
    ]
  }' | python3 -m json.tool
```

预期返回 `status: "ready"`，`missingMeasurements` 和 `unknownSpecies` 有内容但不会阻断。

**4）查看预览详情**

```bash
curl -s http://localhost:3034/import/preview/<PREVIEW_ID> | python3 -m json.tool
```

**5）重复提交已确认的预览**

```bash
curl -s -X POST http://localhost:3034/import/commit/<PREVIEW_ID> | python3 -m json.tool
```

预期返回 409 `already_committed`。

**7）现有 POST /birds 流程不受影响**

```bash
curl -s -X POST http://localhost:3034/birds \
  -H 'Content-Type: application/json' \
  -d '{
    "ringNo": "SB-26011",
    "species": "黑尾鸥",
    "sex": "unknown",
    "age": "juvenile",
    "capturePlace": "东礁A区",
    "season": "2026春"
  }' | python3 -m json.tool
```

### 错误码说明（导入预览）

| 错误码 | HTTP状态 | 说明 |
|--------|----------|------|
| `invalid_input` | 400 | 请求体缺少 records 数组或 records 为空 |
| `preview_not_found` | 404 | 预览不存在或已过期（30分钟TTL） |
| `already_committed` | 409 | 该预览已提交，不可重复写入 |
| `has_blocking_errors` | 422 | 存在阻断性错误（缺字段/环号重复），需修正后重新预览 |

### 野外作业场次
- `POST /field-sessions` - 创建作业场次
- `GET /field-sessions` - 查询作业场次列表（支持 `?season=&capturePlace=&dateFrom=&dateTo=` 筛选）
- `GET /field-sessions/summary` - 查询作业场次摘要（同上筛选条件，带 computedStats 统计）
- `GET /field-sessions/:id` - 查询单场次详情（含关联鸟类）
- `PUT /field-sessions/:id` - 更新作业场次
- `DELETE /field-sessions/:id` - 删除作业场次

---

## 数据备份与恢复模块

手动创建 `data/seabirds.json` 的快照、列出快照、查看快照摘要，并从指定快照恢复。恢复前系统会自动校验快照结构；恢复后现有 `GET /birds` 和统计接口（`GET /reports/recapture-rate`、`GET /health-risk/report` 等）必须能正常读取。

### 数据存储

快照文件存储在 `data/snapshots/` 目录，每个快照是一个独立 JSON 文件：

```
data/snapshots/
├── index.json                    # 快照索引
└── SNAP-20260620143000-a1b2c3d4.json   # 单个快照文件
```

快照文件内部结构：

```json
{
  "_meta": {
    "snapshotId": "SNAP-20260620143000-a1b2c3d4",
    "createdAt": "2026-06-20T14:30:00.000Z",
    "sourceFile": "data/seabirds.json",
    "summary": {
      "totalBirds": 4,
      "speciesBreakdown": [
        { "species": "黑尾鸥", "count": 3 },
        { "species": "红嘴鸥", "count": 1 }
      ],
      "totalMeasurements": 3,
      "totalRecaptures": 1,
      "totalObservations": 1,
      "totalReleases": 1
    }
  },
  "data": {
    "birds": [ ... ]
  }
}
```

### 校验规则

创建快照时，系统会先校验当前 `data/seabirds.json` 的结构：

- 根节点必须是对象，且包含 `birds` 数组
- 每条鸟记录必须包含 `ringNo` 和 `species` 字段
- 环号在快照内不可重复
- `measurements`、`releases`、`recaptures`、`observations` 若存在必须为数组
- `sex`、`age`、`capturePlace`、`season` 若存在必须为字符串

恢复快照时，同样执行以上校验。若校验不通过，恢复操作会被拒绝，返回 422 错误和具体校验失败信息。

### ⚠️ 危险操作警告

**`POST /backups/snapshots/:id/restore` 是危险操作**，执行后会将 `data/seabirds.json` 整体替换为快照中的数据，当前所有未备份的变更将**不可恢复**。

建议操作流程：

1. 恢复前先 `POST /backups/snapshots` 创建当前数据的快照
2. 使用 `GET /backups/snapshots/:id` 确认目标快照的摘要信息
3. 确认无误后再调用 `POST /backups/snapshots/:id/restore`
4. 恢复后立即调用 `GET /birds` 和统计接口验证数据可正常读取

### 1. 创建快照

**POST /backups/snapshots**

对当前 `data/seabirds.json` 创建一份快照。创建前会校验数据结构。

响应（201）：

```json
{
  "snapshotId": "SNAP-20260620143000-a1b2c3d4",
  "createdAt": "2026-06-20T14:30:00.000Z",
  "summary": {
    "totalBirds": 4,
    "speciesBreakdown": [
      { "species": "黑尾鸥", "count": 3 },
      { "species": "红嘴鸥", "count": 1 }
    ],
    "totalMeasurements": 3,
    "totalRecaptures": 1,
    "totalObservations": 1,
    "totalReleases": 1
  }
}
```

错误响应：

| HTTP状态 | 错误码 | 说明 |
|----------|--------|------|
| 404 | `db_not_found` | 数据文件不存在 |
| 500 | `db_parse_error` | 数据文件解析失败 |
| 422 | `db_structure_invalid` | 当前数据结构校验不通过 |

### 2. 列出所有快照

**GET /backups/snapshots**

响应（200）：

```json
[
  {
    "snapshotId": "SNAP-20260620143000-a1b2c3d4",
    "createdAt": "2026-06-20T14:30:00.000Z",
    "summary": {
      "totalBirds": 4,
      "speciesBreakdown": [ ... ],
      "totalMeasurements": 3,
      "totalRecaptures": 1,
      "totalObservations": 1,
      "totalReleases": 1
    }
  }
]
```

### 3. 查看快照摘要

**GET /backups/snapshots/:id**

返回快照的摘要信息和结构校验结果。

响应（200）：

```json
{
  "snapshotId": "SNAP-20260620143000-a1b2c3d4",
  "createdAt": "2026-06-20T14:30:00.000Z",
  "summary": {
    "totalBirds": 4,
    "speciesBreakdown": [ ... ],
    "totalMeasurements": 3,
    "totalRecaptures": 1,
    "totalObservations": 1,
    "totalReleases": 1
  },
  "validation": {
    "valid": true,
    "errors": [],
    "stats": {
      "totalBirds": 4,
      "uniqueRingNos": 4
    }
  }
}
```

404 响应：`{ "error": "snapshot_not_found", "message": "快照不存在" }`

### 4. 从快照恢复（⚠️ 危险操作）

**POST /backups/snapshots/:id/restore**

⚠️ **此操作将用快照数据覆盖当前 `data/seabirds.json`，未备份的当前数据将丢失。建议恢复前先创建当前数据的快照。**

恢复前会自动校验快照结构，校验不通过则拒绝恢复。

响应（200）：

```json
{
  "snapshotId": "SNAP-20260620143000-a1b2c3d4",
  "restoredAt": "2026-06-20T15:00:00.000Z",
  "summary": {
    "totalBirds": 4,
    "speciesBreakdown": [ ... ],
    "totalMeasurements": 3,
    "totalRecaptures": 1,
    "totalObservations": 1,
    "totalReleases": 1
  }
}
```

错误响应：

| HTTP状态 | 错误码 | 说明 |
|----------|--------|------|
| 404 | `snapshot_not_found` | 快照不存在 |
| 404 | `snapshot_file_missing` | 快照文件已丢失 |
| 500 | `snapshot_file_corrupt` | 快照文件损坏，无法解析 |
| 422 | `snapshot_data_missing` | 快照中缺少 data 字段 |
| 422 | `snapshot_structure_invalid` | 快照结构校验不通过，附带 `validationErrors` 数组 |

### curl 验证示例

**1）创建快照**

```bash
curl -s -X POST http://localhost:3034/backups/snapshots | python3 -m json.tool
```

**2）列出所有快照**

```bash
curl -s http://localhost:3034/backups/snapshots | python3 -m json.tool
```

**3）查看快照摘要**

```bash
curl -s http://localhost:3034/backups/snapshots/<SNAPSHOT_ID> | python3 -m json.tool
```

**4）从快照恢复（危险操作，请先备份当前数据）**

```bash
# 步骤1：先备份当前数据
curl -s -X POST http://localhost:3034/backups/snapshots | python3 -m json.tool

# 步骤2：执行恢复（替换 <SNAPSHOT_ID>）
curl -s -X POST http://localhost:3034/backups/snapshots/<SNAPSHOT_ID>/restore | python3 -m json.tool

# 步骤3：验证恢复后数据可正常读取
curl -s http://localhost:3034/birds | python3 -m json.tool
curl -s http://localhost:3034/reports/recapture-rate | python3 -m json.tool
curl -s http://localhost:3034/health-risk/report | python3 -m json.tool
```
