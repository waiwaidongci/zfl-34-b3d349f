import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_TYPES,
  TARGET_TYPES,
  recordAuditLog,
  pickDictEntryKeyFields
} from "./auditLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dictPath = join(__dirname, "data", "dictionaries.json");
const birdsPath = join(__dirname, "data", "seabirds.json");
const sessionsPath = join(__dirname, "data", "fieldSessions.json");

const DICTIONARY_TYPES = ["species", "capturePlace", "season"];

const MANDATORY_SEED = {
  species: ["黑尾鸥"],
  capturePlace: ["东礁A区", "东礁B区"],
  season: ["2026春"]
};

function nowIso() {
  return new Date().toISOString();
}

function buildEntry(value, description = null) {
  const t = nowIso();
  return { value, description, createdAt: t, updatedAt: t };
}

async function loadBirdsSafely() {
  try {
    if (!existsSync(birdsPath)) return { birds: [] };
    return JSON.parse(await readFile(birdsPath, "utf8"));
  } catch (_) {
    return { birds: [] };
  }
}

async function loadSessionsSafely() {
  try {
    if (!existsSync(sessionsPath)) return { fieldSessions: [] };
    return JSON.parse(await readFile(sessionsPath, "utf8"));
  } catch (_) {
    return { fieldSessions: [] };
  }
}

async function collectExistingValues() {
  const result = { species: new Set(), capturePlace: new Set(), season: new Set() };
  const birdsDb = await loadBirdsSafely();
  for (const b of birdsDb.birds || []) {
    if (b.species) result.species.add(b.species);
    if (b.capturePlace) result.capturePlace.add(b.capturePlace);
    if (b.season) result.season.add(b.season);
  }
  const sessionsDb = await loadSessionsSafely();
  for (const s of sessionsDb.fieldSessions || []) {
    if (s.season) result.season.add(s.season);
    if (s.capturePlace) result.capturePlace.add(s.capturePlace);
  }
  return result;
}

async function buildInitialDictionaries() {
  const existing = await collectExistingValues();
  const dict = { species: [], capturePlace: [], season: [] };
  for (const type of DICTIONARY_TYPES) {
    const values = new Set([...MANDATORY_SEED[type], ...existing[type]]);
    for (const v of values) dict[type].push(buildEntry(v));
  }
  return dict;
}

async function loadDictionaries() {
  if (!existsSync(dictPath)) {
    await mkdir(dirname(dictPath), { recursive: true });
    const initial = await buildInitialDictionaries();
    await writeFile(dictPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(await readFile(dictPath, "utf8"));
  for (const type of DICTIONARY_TYPES) {
    if (!Array.isArray(data[type])) data[type] = [];
  }
  return data;
}

async function saveDictionaries(dict) {
  await writeFile(dictPath, JSON.stringify(dict, null, 2));
}

function isValidType(type) {
  return DICTIONARY_TYPES.includes(type);
}

function listDictionary(dict, type) {
  if (!isValidType(type)) return null;
  return dict[type] || [];
}

function findEntry(dict, type, value) {
  if (!isValidType(type)) return null;
  return (dict[type] || []).find(e => e.value === value) || null;
}

async function addDictionaryEntry(type, value, description = null) {
  if (!isValidType(type)) throw new Error("invalid_dictionary_type");
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid_value");
  }
  const dict = await loadDictionaries();
  if (findEntry(dict, type, value)) throw new Error("entry_already_exists");
  const entry = buildEntry(value, description);
  dict[type].push(entry);
  await saveDictionaries(dict);
  recordAuditLog({
    operationType: OPERATION_TYPES.DICTIONARY_ENTRY_ADD,
    targetType: TARGET_TYPES.DICTIONARY,
    targetId: `${type}:${value}`,
    requestSummary: { type, value, description },
    before: null,
    after: { type, ...pickDictEntryKeyFields(entry) }
  });
  return entry;
}

async function updateDictionaryEntry(type, oldValue, newValue, description) {
  if (!isValidType(type)) throw new Error("invalid_dictionary_type");
  if (!oldValue || typeof oldValue !== "string") throw new Error("invalid_old_value");
  const dict = await loadDictionaries();
  const entry = findEntry(dict, type, oldValue);
  if (!entry) throw new Error("entry_not_found");
  const beforeEntry = { type, ...pickDictEntryKeyFields(entry) };
  if (newValue !== undefined && newValue !== null) {
    if (typeof newValue !== "string" || newValue.trim().length === 0) throw new Error("invalid_new_value");
    if (newValue !== oldValue && findEntry(dict, type, newValue)) throw new Error("entry_already_exists");
    entry.value = newValue;
  }
  if (description !== undefined) entry.description = description;
  entry.updatedAt = nowIso();
  await saveDictionaries(dict);
  recordAuditLog({
    operationType: OPERATION_TYPES.DICTIONARY_ENTRY_UPDATE,
    targetType: TARGET_TYPES.DICTIONARY,
    targetId: `${type}:${newValue || oldValue}`,
    requestSummary: { type, oldValue, newValue, description },
    before: beforeEntry,
    after: { type, ...pickDictEntryKeyFields(entry) }
  });
  return entry;
}

async function deleteDictionaryEntry(type, value) {
  if (!isValidType(type)) throw new Error("invalid_dictionary_type");
  if (!value || typeof value !== "string") throw new Error("invalid_value");
  const dict = await loadDictionaries();
  const idx = (dict[type] || []).findIndex(e => e.value === value);
  if (idx === -1) throw new Error("entry_not_found");
  const existing = dict[type][idx];
  const beforeEntry = { type, ...pickDictEntryKeyFields(existing) };
  dict[type].splice(idx, 1);
  await saveDictionaries(dict);
  recordAuditLog({
    operationType: OPERATION_TYPES.DICTIONARY_ENTRY_DELETE,
    targetType: TARGET_TYPES.DICTIONARY,
    targetId: `${type}:${value}`,
    requestSummary: { type, value },
    before: beforeEntry,
    after: null
  });
  return true;
}

async function validateDictionaryValue(type, value, { allowEmpty = true } = {}) {
  if (!isValidType(type)) throw new Error("invalid_dictionary_type");
  if (value === undefined || value === null || value === "") {
    if (allowEmpty) return { valid: true };
    return { valid: false, type, value, reason: "empty_value_not_allowed" };
  }
  const dict = await loadDictionaries();
  const entry = findEntry(dict, type, value);
  if (entry) return { valid: true };
  return { valid: false, type, value, reason: "not_in_dictionary" };
}

async function validateDictionaryValues(validations) {
  const results = [];
  for (const { type, value, allowEmpty } of validations) {
    results.push(await validateDictionaryValue(type, value, { allowEmpty }));
  }
  return results;
}

function mapDictError(e) {
  switch (e.message) {
    case "invalid_dictionary_type":
      return { status: 400, error: "invalid_dictionary_type", message: `无效的字典类型，支持: ${DICTIONARY_TYPES.join(", ")}` };
    case "invalid_value":
      return { status: 400, error: "invalid_value", message: "字典值不能为空" };
    case "invalid_old_value":
      return { status: 400, error: "invalid_old_value", message: "待更新的字典值无效" };
    case "invalid_new_value":
      return { status: 400, error: "invalid_new_value", message: "新字典值无效" };
    case "entry_already_exists":
      return { status: 409, error: "entry_already_exists", message: "该字典值已存在" };
    case "entry_not_found":
      return { status: 404, error: "entry_not_found", message: "字典条目不存在" };
    default:
      return { status: 500, error: e.message };
  }
}

export {
  DICTIONARY_TYPES,
  loadDictionaries,
  saveDictionaries,
  isValidType,
  listDictionary,
  findEntry,
  addDictionaryEntry,
  updateDictionaryEntry,
  deleteDictionaryEntry,
  validateDictionaryValue,
  validateDictionaryValues,
  mapDictError
};
