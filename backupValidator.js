const REQUIRED_BIRD_FIELDS = ["ringNo", "species"];
const OPTIONAL_ARRAY_FIELDS = ["measurements", "releases", "recaptures", "observations"];
const OPTIONAL_STRING_FIELDS = ["sex", "age", "capturePlace", "season"];
const OPTIONAL_NESTED_FIELDS = ["fieldSessionId", "healthRisk"];

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

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      totalBirds: data.birds.length,
      uniqueRingNos: ringNos.size
    }
  };
}
