# 海鸟环志站API

运行：

```bash
npm start
```

默认端口`3034`。支持环号唯一档案、测量、复捕、迁徙观测、复捕率统计、**野外作业场次**管理，以及**环号库存与批次发放**管理。

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
- `GET /birds` - 查询鸟类列表，支持 `?species=` 筛选
- `POST /birds` - 创建鸟类记录（自动检查 ringNo 重复，支持 `fieldSessionId` 关联作业场次，子记录自动继承）
- `GET /birds/:ringNo/history` - 查询单只鸟完整档案
- `POST /birds/:ringNo/measurements` - 添加测量数据（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/recaptures` - 添加复捕记录（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/observations` - 添加观测记录（请求体支持 `fieldSessionId` 关联作业场次）
- `POST /birds/:ringNo/releases` - 添加放飞记录（请求体支持 `fieldSessionId` 关联作业场次）

### 统计报表
- `GET /reports/recapture-rate?season=` - 按季节统计复捕率

### 野外作业场次
- `POST /field-sessions` - 创建作业场次
- `GET /field-sessions` - 查询作业场次列表（支持 `?season=&capturePlace=&dateFrom=&dateTo=` 筛选）
- `GET /field-sessions/summary` - 查询作业场次摘要（同上筛选条件，带 computedStats 统计）
- `GET /field-sessions/:id` - 查询单场次详情（含关联鸟类）
- `PUT /field-sessions/:id` - 更新作业场次
- `DELETE /field-sessions/:id` - 删除作业场次
