const INJURY_KEYWORDS = [
  /受伤/, /伤/, /流血/, /虚弱/, /无力/, /状态差/, /消瘦/,
  /跛行/, /伤口/, /感染/, /发炎/
];

const SEVERE_INJURY_KEYWORDS = [
  /骨折/, /重伤/, /无法飞行/, /无法站立/, /流血不止/, /生命垂危/, /昏迷/,
  /严重受伤/, /大量失血/, /翅膀断裂/, /腿断/, /无法行动/
];

const ABNORMAL_MOLT_KEYWORDS = [
  /换羽异常/, /掉毛严重/, /羽毛稀疏/, /换羽不正常/, /异常掉毛/,
  /羽毛脱落/, /秃/, /无羽毛/, /断羽/
];

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

const SPECIES_WEIGHT_BASELINE = {
  '黑尾鸥': { min: 400, max: 650 },
  '红嘴鸥': { min: 200, max: 400 },
  '银鸥': { min: 700, max: 1300 },
  '普通燕鸥': { min: 90, max: 150 }
};

function hasKeyword(text, keywords) {
  if (!text) return false;
  return keywords.some(k => k.test(text));
}

function getLatestMeasurements(measurements) {
  if (!measurements || measurements.length === 0) return null;
  const sorted = measurements
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => {
      const dateDiff = new Date(b.m.at).getTime() - new Date(a.m.at).getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.idx - a.idx;
    });
  return sorted[0].m;
}

function getPreviousMeasurements(measurements) {
  if (!measurements || measurements.length < 2) return null;
  const sorted = measurements
    .map((m, idx) => ({ m, idx }))
    .sort((a, b) => {
      const dateDiff = new Date(b.m.at).getTime() - new Date(a.m.at).getTime();
      if (dateDiff !== 0) return dateDiff;
      return b.idx - a.idx;
    });
  return sorted[1].m;
}

function calculateWeightChange(current, previous) {
  if (!current || !previous || !current.weight || !previous.weight) return null;
  const change = ((current.weight - previous.weight) / previous.weight) * 100;
  return Number(change.toFixed(1));
}

function isWeightOutOfRange(weight, species) {
  const baseline = SPECIES_WEIGHT_BASELINE[species];
  if (!baseline || !weight) return false;
  return weight < baseline.min || weight > baseline.max;
}

function analyzeMeasurements(bird, factors, score) {
  const measurements = bird.measurements || [];
  const latest = getLatestMeasurements(measurements);
  const previous = getPreviousMeasurements(measurements);

  if (measurements.length === 0) {
    factors.push({
      type: 'no_measurements',
      description: '无任何测量记录',
      severity: 'high'
    });
    score += 60;
    return { score, factors };
  }

  if (latest) {
    const missingFields = [];
    if (latest.wing === undefined || latest.wing === null) missingFields.push('wing(翼长)');
    if (latest.weight === undefined || latest.weight === null) missingFields.push('weight(体重)');
    if (latest.bill === undefined || latest.bill === null) missingFields.push('bill(喙长)');

    if (missingFields.length > 0) {
      factors.push({
        type: 'missing_measurements',
        description: `最新测量缺少关键字段：${missingFields.join('、')}`,
        severity: 'medium',
        missingFields
      });
      score += 30;
    }
  }

  if (latest && previous && latest.weight && previous.weight) {
    const weightChange = calculateWeightChange(latest, previous);
    if (weightChange !== null) {
      if (weightChange <= -25) {
        factors.push({
          type: 'extreme_weight_loss',
          description: `体重极度下降 ${Math.abs(weightChange)}%`,
          severity: 'critical',
          weightChange,
          previousWeight: previous.weight,
          currentWeight: latest.weight
        });
        score += 80;
      } else if (weightChange <= -15) {
        factors.push({
          type: 'significant_weight_loss',
          description: `体重显著下降 ${Math.abs(weightChange)}%`,
          severity: 'high',
          weightChange,
          previousWeight: previous.weight,
          currentWeight: latest.weight
        });
        score += 50;
      } else if (weightChange <= -10) {
        factors.push({
          type: 'moderate_weight_loss',
          description: `体重中度下降 ${Math.abs(weightChange)}%`,
          severity: 'medium',
          weightChange,
          previousWeight: previous.weight,
          currentWeight: latest.weight
        });
        score += 25;
      }
    }
  }

  if (latest && latest.weight) {
    if (isWeightOutOfRange(latest.weight, bird.species)) {
      const baseline = SPECIES_WEIGHT_BASELINE[bird.species];
      factors.push({
        type: 'weight_out_of_range',
        description: `体重 ${latest.weight}g 超出${bird.species}正常范围(${baseline.min}-${baseline.max}g)`,
        severity: 'high',
        weight: latest.weight,
        baseline
      });
      score += 40;
    }
  }

  return { score, factors };
}

function analyzeRecaptureNotes(bird, factors, score) {
  const recaptures = bird.recaptures || [];
  for (const recapture of recaptures) {
    if (!recapture.note) continue;

    if (hasKeyword(recapture.note, SEVERE_INJURY_KEYWORDS)) {
      factors.push({
        type: 'severe_injury',
        description: `复捕备注显示严重受伤：${recapture.note}`,
        severity: 'critical',
        note: recapture.note,
        recaptureAt: recapture.at
      });
      score += 90;
    } else if (hasKeyword(recapture.note, INJURY_KEYWORDS)) {
      factors.push({
        type: 'injury',
        description: `复捕备注显示受伤：${recapture.note}`,
        severity: 'high',
        note: recapture.note,
        recaptureAt: recapture.at
      });
      score += 60;
    }

    if (hasKeyword(recapture.note, ABNORMAL_MOLT_KEYWORDS)) {
      factors.push({
        type: 'abnormal_molt',
        description: `复捕备注显示换羽异常：${recapture.note}`,
        severity: 'medium',
        note: recapture.note,
        recaptureAt: recapture.at
      });
      score += 30;
    }
  }

  return { score, factors };
}

function analyzeObservations(bird, factors, score) {
  const observations = bird.observations || [];
  for (const obs of observations) {
    if (!obs.note) continue;

    if (hasKeyword(obs.note, SEVERE_INJURY_KEYWORDS)) {
      factors.push({
        type: 'severe_injury_observation',
        description: `观察记录显示严重受伤：${obs.note}`,
        severity: 'critical',
        note: obs.note,
        observedAt: obs.at
      });
      score += 90;
    } else if (hasKeyword(obs.note, INJURY_KEYWORDS)) {
      factors.push({
        type: 'injury_observation',
        description: `观察记录显示受伤：${obs.note}`,
        severity: 'high',
        note: obs.note,
        observedAt: obs.at
      });
      score += 60;
    }
  }

  return { score, factors };
}

function determineRiskLevel(score) {
  if (score >= 90) return RISK_LEVELS.CRITICAL;
  if (score >= 60) return RISK_LEVELS.HIGH;
  if (score >= 30) return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.LOW;
}

export function calculateBirdRisk(bird) {
  let score = 0;
  let factors = [];

  const measurementResult = analyzeMeasurements(bird, factors, score);
  score = measurementResult.score;
  factors = measurementResult.factors;

  const recaptureResult = analyzeRecaptureNotes(bird, factors, score);
  score = recaptureResult.score;
  factors = recaptureResult.factors;

  const observationResult = analyzeObservations(bird, factors, score);
  score = observationResult.score;
  factors = observationResult.factors;

  const finalScore = Math.min(score, 100);
  const level = determineRiskLevel(finalScore);

  return {
    ringNo: bird.ringNo,
    species: bird.species,
    level,
    score: finalScore,
    factors,
    calculatedAt: new Date().toISOString(),
    latestMeasurement: getLatestMeasurements(bird.measurements)
  };
}

export function calculateAllBirdsRisk(birds) {
  return birds.map(bird => calculateBirdRisk(bird));
}

export function getRiskSummary(birds) {
  const risks = calculateAllBirdsRisk(birds);
  const summary = {
    total: risks.length,
    byLevel: {
      [RISK_LEVELS.LOW]: 0,
      [RISK_LEVELS.MEDIUM]: 0,
      [RISK_LEVELS.HIGH]: 0,
      [RISK_LEVELS.CRITICAL]: 0
    },
    byFactorType: {},
    highRiskBirds: risks.filter(r => r.level === RISK_LEVELS.HIGH || r.level === RISK_LEVELS.CRITICAL),
    allRisks: risks
  };

  for (const risk of risks) {
    summary.byLevel[risk.level]++;
    for (const factor of risk.factors) {
      summary.byFactorType[factor.type] = (summary.byFactorType[factor.type] || 0) + 1;
    }
  }

  summary.highRiskBirds.sort((a, b) => b.score - a.score);

  return summary;
}

export function persistRiskToBird(bird) {
  const risk = calculateBirdRisk(bird);
  bird.healthRisk = risk;
  return bird;
}

export function persistRiskToAllBirds(birds) {
  return birds.map(bird => persistRiskToBird(bird));
}

export default {
  calculateBirdRisk,
  calculateAllBirdsRisk,
  getRiskSummary,
  persistRiskToBird,
  persistRiskToAllBirds,
  RISK_LEVELS
};
