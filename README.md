# 海鸟环志站API

运行：

```bash
npm start
```

默认端口`3034`。支持环号唯一档案、测量、复捕、迁徙观测、复捕率统计，以及**环号库存与批次发放**管理。

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
- `POST /birds` - 创建鸟类记录（自动检查 ringNo 重复）
- `GET /birds/:ringNo/history` - 查询单只鸟完整档案
- `POST /birds/:ringNo/measurements` - 添加测量数据
- `POST /birds/:ringNo/recaptures` - 添加复捕记录
- `POST /birds/:ringNo/observations` - 添加观测记录
- `POST /birds/:ringNo/releases` - 添加放飞记录

### 统计报表
- `GET /reports/recapture-rate?season=` - 按季节统计复捕率
