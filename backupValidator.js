const REQUIRED_BIRD_FIELDS = ["ringNo", "species"];
const OPTIONAL_ARRAY_FIELDS = ["measurements", "releases", "recaptures", "observations"];
const OPTIONAL_STRING_FIELDS = ["sex", "age", "capturePlace", "season"];
const OPTIONAL_NESTED_FIELDS = ["fieldSessionId", "healthRisk"];
const REQUIRED_EVENT_FIELDS = ["ringNo", "eventType", "eventIndex", "data"];
const VALID_EVENT_TYPES = ["measurements", "releases", "recaptures", "observations"];
const REQUIRED_SESSION_FIELDS = ["id", "date", "season", "capturePlace"];
const REQUIRED_RING_BATCH_FIELDS = ["id", "prefix", "startNo", "endNo"];
const REQUIRED_RING_FIELDS = ["ringNo", "batchId", "status"];

export function validateSnapshotStructure(data) {
  const errors = [];

  if (data === null || data === undefined || typeof data !== "object") {
    return { valid: false, errors: ["快照根节点不是有效对象"] };
  }

  if (!Array.isArray(data.birds)) {
    return { valid: false, errors: ["快照缺少 birds 数组或 birds 不是数组"] };
  }

  const ringNos = new Set();
  for (let i = 0; i < data.birds.length; i++) {
    const bird = data.birds[i];
    const prefix = `birds[${i}]`;

    if (!bird || typeof bird !== "object") {
      errors.push(`${prefix} 不是有效对象`);
      continue;
    }

    for (const field of REQUIRED_BIRD_FIELDS) {
      if (bird[field] === undefined || bird[field] === null || bird[field] === "") {
        errors.push(`${prefix} 缺少必填字段「${field}」`);
      }
    }

    if (bird.ringNo) {
      if (ringNos.has(bird.ringNo)) {
        errors.push(`${prefix} 环号「${bird.ringNo}」在快照内重复`);
      }
      ringNos.add(bird.ringNo);
    }

    for (const field of OPTIONAL_ARRAY_FIELDS) {
      if (bird[field] !== undefined && !Array.isArray(bird[field])) {
        errors.push(`${prefix}.${field} 应为数组`);
      }
    }

    for (const field of OPTIONAL_STRING_FIELDS) {
      if (bird[field] !== undefined && typeof bird[field] !== "string") {
        errors.push(`${prefix}.${field} 应为字符串`);
      }
    }

    for (const field of OPTIONAL_NESTED_FIELDS) {
      if (bird[field] !== undefined && bird[field] !== null && typeof bird[field] !== "object" && typeof bird[field] !== "string") {
        errors.push(`${prefix}.${field} 类型无效`);
      }
    }
  }

  if (data.events !== undefined) {
    if (!Array.isArray(data.events)) {
      errors.push("events 应为数组");
    } else {
      const eventKeys = new Set();
      for (let i = 0; i < data.events.length; i++) {
        const event = data.events[i];
        const prefix = `events[${i}]`;
        if (!event || typeof event !== "object") {
          errors.push(`${prefix} 不是有效对象`);
          continue;
        }
        for (const field of REQUIRED_EVENT_FIELDS) {
          if (event[field] === undefined || event[field] === null) {
            errors.push(`${prefix} 缺少必填字段「${field}」`);
          }
        }
        if (event.eventType && !VALID_EVENT_TYPES.includes(event.eventType)) {
          errors.push(`${prefix}.eventType 无效，应为: ${VALID_EVENT_TYPES.join(", ")}`);
        }
        if (event.ringNo && event.eventType !== undefined && event.eventIndex !== undefined) {
          const key = `${event.ringNo}|${event.eventType}|${event.eventIndex}`;
          if (eventKeys.has(key)) {
            errors.push(`${prefix} 事件重复: ${key}`);
          }
          eventKeys.add(key);
        }
        if (event.data !== undefined && typeof event.data !== "object") {
          errors.push(`${prefix}.data 应为对象`);
        }
      }
    }
  }

  if (data.dictionaries !== undefined) {
    if (typeof data.dictionaries !== "object" || data.dictionaries === null) {
      errors.push("dictionaries 应为对象");
    } else {
      for (const [type, entries] of Object.entries(data.dictionaries)) {
        if (!Array.isArray(entries)) {
          errors.push(`dictionaries.${type} 应为数组`);
          continue;
        }
        const values = new Set();
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const prefix = `dictionaries.${type}[${i}]`;
          if (!entry || typeof entry !== "object") {
            errors.push(`${prefix} 不是有效对象`);
            continue;
          }
          if (entry.value === undefined || entry.value === null || entry.value === "") {
            errors.push(`${prefix} 缺少必填字段「value」`);
          }
          if (entry.value) {
            if (values.has(entry.value)) {
              errors.push(`${prefix} 值「${entry.value}」重复`);
            }
            values.add(entry.value);
          }
        }
      }
    }
  }

  if (data.fieldSessions !== undefined) {
    if (!Array.isArray(data.fieldSessions)) {
      errors.push("fieldSessions 应为数组");
    } else {
      const sessionIds = new Set();
      for (let i = 0; i < data.fieldSessions.length; i++) {
        const session = data.fieldSessions[i];
        const prefix = `fieldSessions[${i}]`;
        if (!session || typeof session !== "object") {
          errors.push(`${prefix} 不是有效对象`);
          continue;
        }
        for (const field of REQUIRED_SESSION_FIELDS) {
          if (session[field] === undefined || session[field] === null || session[field] === "") {
            errors.push(`${prefix} 缺少必填字段「${field}」`);
          }
        }
        if (session.id) {
          if (sessionIds.has(session.id)) {
            errors.push(`${prefix} 场次ID「${session.id}」重复`);
          }
          sessionIds.add(session.id);
        }
      }
    }
  }

  if (data.ringInventory !== undefined) {
    if (typeof data.ringInventory !== "object" || data.ringInventory === null) {
      errors.push("ringInventory 应为对象");
    } else {
      if (data.ringInventory.batches !== undefined) {
        if (!Array.isArray(data.ringInventory.batches)) {
          errors.push("ringInventory.batches 应为数组");
        } else {
          const batchIds = new Set();
          for (let i = 0; i < data.ringInventory.batches.length; i++) {
            const batch = data.ringInventory.batches[i];
            const prefix = `ringInventory.batches[${i}]`;
            if (!batch || typeof batch !== "object") {
              errors.push(`${prefix} 不是有效对象`);
              continue;
            }
            for (const field of REQUIRED_RING_BATCH_FIELDS) {
              if (batch[field] === undefined || batch[field] === null) {
                errors.push(`${prefix} 缺少必填字段「${field}」`);
              }
            }
            if (batch.id) {
              if (batchIds.has(batch.id)) {
                errors.push(`${prefix} 批次ID「${batch.id}」重复`);
              }
              batchIds.add(batch.id);
            }
            if (batch.startNo !== undefined && typeof batch.startNo !== "number") {
              errors.push(`${prefix}.startNo 应为数字`);
            }
            if (batch.endNo !== undefined && typeof batch.endNo !== "number") {
              errors.push(`${prefix}.endNo 应为数字`);
            }
          }
        }
      }
      if (data.ringInventory.rings !== undefined) {
        if (!Array.isArray(data.ringInventory.rings)) {
          errors.push("ringInventory.rings 应为数组");
        } else {
          const ringNos = new Set();
          for (let i = 0; i < data.ringInventory.rings.length; i++) {
            const ring = data.ringInventory.rings[i];
            const prefix = `ringInventory.rings[${i}]`;
            if (!ring || typeof ring !== "object") {
              errors.push(`${prefix} 不是有效对象`);
              continue;
            }
            for (const field of REQUIRED_RING_FIELDS) {
              if (ring[field] === undefined || ring[field] === null || ring[field] === "") {
                errors.push(`${prefix} 缺少必填字段「${field}」`);
              }
            }
            if (ring.ringNo) {
              if (ringNos.has(ring.ringNo)) {
                errors.push(`${prefix} 环号「${ring.ringNo}」重复`);
              }
              ringNos.add(ring.ringNo);
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      totalBirds: data.birds.length,
      uniqueRingNos: ringNos.size,
      totalEvents: data.events?.length || 0,
      totalFieldSessions: data.fieldSessions?.length || 0,
      totalRingBatches: data.ringInventory?.batches?.length || 0,
      totalRings: data.ringInventory?.rings?.length || 0
    }
  };
}
