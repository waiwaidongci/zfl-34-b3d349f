#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
TOTAL=0

pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
}

info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"

info "海鸟环志API - 数据隔离机制端到端验证"
info "================================================="
echo ""

info "步骤 1: 备份真实数据目录状态"
REAL_DATA_DIR="$BASE_DIR/data"
REAL_DATA_BACKUP=$(mktemp -d)
if [ -d "$REAL_DATA_DIR" ]; then
    cp -r "$REAL_DATA_DIR"/* "$REAL_DATA_BACKUP/" 2>/dev/null || true
fi
info "真实数据备份到: $REAL_DATA_BACKUP"
echo ""

info "步骤 2: 创建隔离测试目录"
TEST_DIR=$(mktemp -d)
info "隔离测试目录: $TEST_DIR"
echo ""

info "步骤 3: 测试数据目录隔离"
export DATA_DIR="$TEST_DIR"
node -e "
(async () => {
    const { initialize, getDataDir } = await import('./dataStore.js');
    const dataDir = getDataDir();
    await initialize();
    console.log('getDataDir() =', dataDir);
    const fs = await import('node:fs');
    const files = fs.readdirSync(dataDir);
    console.log('初始化后文件:', files.join(', '));
})();
"
if [ $? -eq 0 ]; then
    pass "数据目录隔离测试 - 初始化成功"
    INIT_FILES=$(ls "$TEST_DIR"/*.json 2>/dev/null | wc -l)
    if [ "$INIT_FILES" -ge 5 ]; then
        pass "数据目录隔离测试 - 创建了 $INIT_FILES 个数据文件"
    else
        fail "数据目录隔离测试 - 数据文件不足（实际 $INIT_FILES 个）"
    fi
else
    fail "数据目录隔离测试 - 初始化失败"
fi
echo ""

info "步骤 4: 验证真实数据目录未受影响"
REAL_FILES_BEFORE=$(find "$REAL_DATA_BACKUP" -type f 2>/dev/null | wc -l)
REAL_FILES_AFTER=$(find "$REAL_DATA_DIR" -type f 2>/dev/null | wc -l)
if [ "$REAL_FILES_BEFORE" = "$REAL_FILES_AFTER" ]; then
    pass "真实数据未受影响 - 文件数量一致 ($REAL_FILES_BEFORE)"
else
    fail "真实数据被修改 - 之前 $REAL_FILES_BEFORE 个文件，之后 $REAL_FILES_AFTER 个文件"
fi
echo ""

info "步骤 5: 测试 imports 目录隔离"
node -e "
(async () => {
    const { createPreview } = await import('./importPreview.js');
    const { loadLegacyCompatibleDb } = await import('./dataStore.js');
    const legacyDb = await loadLegacyCompatibleDb();
    const task = await createPreview([{
        ringNo: 'ISOLATION-TEST-001',
        species: '黑尾鸥',
        sex: 'male',
        capturePlace: '东礁A区',
        season: '2026春',
        measurements: [{ wing: 320, weight: 500 }]
    }], legacyDb.birds);
    console.log('导入任务ID:', task.taskId);
    console.log('导入任务状态:', task.status);
})();
"
if [ $? -eq 0 ] && [ -d "$TEST_DIR/imports" ] && [ -f "$TEST_DIR/imports/index.json" ]; then
    pass "导入任务隔离测试 - imports 目录和索引创建成功"
    TASK_FILES=$(ls "$TEST_DIR/imports"/IMP-*.json 2>/dev/null | wc -l)
    if [ "$TASK_FILES" -eq 1 ]; then
        pass "导入任务隔离测试 - 任务文件创建在隔离目录"
    else
        fail "导入任务隔离测试 - 任务文件数量不对（实际 $TASK_FILES 个）"
    fi
else
    fail "导入任务隔离测试 - 失败"
fi
echo ""

info "步骤 6: 测试 snapshots 目录隔离和恢复"
node -e "
(async () => {
    const { createSnapshot, listSnapshots, restoreFromSnapshot } = await import('./backupService.js');
    const { readBirdsStore, writeBirdsAndEventsStore } = await import('./dataStore.js');
    const snapshot = await createSnapshot();
    console.log('快照ID:', snapshot.snapshotId);
    const list = await listSnapshots();
    console.log('快照列表数量:', list.length);
    const before = await readBirdsStore();
    await writeBirdsAndEventsStore(
        { birds: [...before.birds, { ringNo: 'SNAP-RESTORE-TEMP', species: '黑尾鸥' }] },
        { events: [] }
    );
    const changed = await readBirdsStore();
    console.log('恢复前包含临时鸟:', changed.birds.some(b => b.ringNo === 'SNAP-RESTORE-TEMP'));
    await restoreFromSnapshot(snapshot.snapshotId);
    const restored = await readBirdsStore();
    console.log('恢复后包含临时鸟:', restored.birds.some(b => b.ringNo === 'SNAP-RESTORE-TEMP'));
    if (restored.birds.some(b => b.ringNo === 'SNAP-RESTORE-TEMP')) {
        throw new Error('snapshot_restore_failed');
    }
})();
"
if [ $? -eq 0 ] && [ -d "$TEST_DIR/snapshots" ] && [ -f "$TEST_DIR/snapshots/index.json" ]; then
    pass "快照隔离测试 - snapshots 目录、索引和恢复流程成功"
    SNAP_FILES=$(ls "$TEST_DIR/snapshots"/SNAP-*.json 2>/dev/null | wc -l)
    if [ "$SNAP_FILES" -eq 1 ]; then
        pass "快照隔离测试 - 快照文件创建在隔离目录"
    else
        fail "快照隔离测试 - 快照文件数量不对（实际 $SNAP_FILES 个）"
    fi
else
    fail "快照隔离测试 - 失败"
fi
echo ""

info "步骤 7: 测试 auditLogs 隔离"
node -e "
(async () => {
    const { readStore } = await import('./dataStore.js');
    const logs = await readStore('auditLogs');
    console.log('审计日志数量:', logs.logs.length);
    if (logs.logs.length > 0) {
        console.log('最新日志类型:', logs.logs[logs.logs.length - 1].operationType);
    }
})();
"
if [ $? -eq 0 ] && [ -f "$TEST_DIR/auditLogs.json" ]; then
    pass "审计日志隔离测试 - auditLogs.json 在隔离目录中"
else
    fail "审计日志隔离测试 - 失败"
fi
echo ""

info "步骤 8: 测试 offlineSyncTracker 隔离"
node -e "
(async () => {
    const { readStore } = await import('./dataStore.js');
    const tracker = await readStore('offlineSyncTracker');
    console.log('离线同步跟踪器已处理包数:', tracker.processedPackets.length);
})();
"
if [ $? -eq 0 ] && [ -f "$TEST_DIR/offlineSyncTracker.json" ]; then
    pass "离线同步隔离测试 - offlineSyncTracker.json 在隔离目录中"
else
    fail "离线同步隔离测试 - 失败"
fi
echo ""

info "步骤 9: 测试一致性检查"
node -e "
(async () => {
    const { checkConsistency } = await import('./backupService.js');
    const result = await checkConsistency();
    console.log('一致性检查 isConsistent:', result.isConsistent);
    console.log('可修复问题数:', result.repairable.length);
    console.log('不可修复问题数:', result.nonRepairable.length);
})();
"
if [ $? -eq 0 ]; then
    pass "一致性检查测试 - 执行成功"
else
    fail "一致性检查测试 - 失败"
fi
echo ""

info "步骤 10: 测试原子写入机制"
node -e "
(async () => {
    const { atomicWriteFile, getStoreFiles } = await import('./dataStore.js');
    const storeFiles = getStoreFiles();
    const fs = await import('node:fs');
    const path = await import('node:path');
    
    const testPath = path.join(path.dirname(storeFiles.birds), 'atomic-test.json');
    await atomicWriteFile(testPath, { test: 'data', value: 123 });
    
    const result = JSON.parse(await fs.promises.readFile(testPath, 'utf8'));
    console.log('原子写入测试结果:', JSON.stringify(result));
    
    const tmpFiles = fs.readdirSync(path.dirname(testPath)).filter(f => f.includes('.tmp.'));
    console.log('遗留临时文件数:', tmpFiles.length);
    
    await fs.promises.unlink(testPath);
})();
"
if [ $? -eq 0 ]; then
    pass "原子写入测试 - 写入和读取成功"
    TMP_FILES=$(ls "$TEST_DIR"/*.tmp.* 2>/dev/null | wc -l)
    if [ "$TMP_FILES" -eq 0 ]; then
        pass "原子写入测试 - 无遗留临时文件"
    else
        fail "原子写入测试 - 发现 $TMP_FILES 个遗留临时文件"
    fi
else
    fail "原子写入测试 - 失败"
fi
echo ""

info "步骤 11: 测试多个隔离目录互不干扰"
TEST_DIR2=$(mktemp -d)
export DATA_DIR="$TEST_DIR2"
node -e "
(async () => {
    const { initialize, writeBirdsAndEventsStore, readBirdsStore } = await import('./dataStore.js');
    await initialize();
    await writeBirdsAndEventsStore(
        { birds: [{ ringNo: 'DIR2-UNIQUE', species: '红嘴鸥', capturePlace: '西礁C区', season: '2026春' }] },
        { events: [] }
    );
    const birds = await readBirdsStore();
    console.log('目录2鸟数:', birds.birds.length);
    console.log('目录2鸟环号:', birds.birds.map(b => b.ringNo).join(', '));
})();
"

export DATA_DIR="$TEST_DIR"
node -e "
(async () => {
    const { readBirdsStore } = await import('./dataStore.js');
    const birds = await readBirdsStore();
    const ringNos = birds.birds.map(b => b.ringNo);
    console.log('目录1鸟数:', birds.birds.length);
    console.log('目录1包含DIR2-UNIQUE:', ringNos.includes('DIR2-UNIQUE'));
})();
"

DIR1_HAS_DIR2=$(export DATA_DIR="$TEST_DIR" && node -e "
(async () => {
    const { readBirdsStore } = await import('./dataStore.js');
    const birds = await readBirdsStore();
    const has = birds.birds.some(b => b.ringNo === 'DIR2-UNIQUE');
    console.log(has ? 'YES' : 'NO');
})();
")

if [ "$DIR1_HAS_DIR2" = "NO" ]; then
    pass "多目录隔离测试 - 两个目录数据互不干扰"
else
    fail "多目录隔离测试 - 目录1包含了目录2的数据"
fi
echo ""

info "步骤 12: 最终验证真实数据目录完整性"
if [ -d "$REAL_DATA_BACKUP" ] && [ "$(ls -A "$REAL_DATA_BACKUP" 2>/dev/null)" ]; then
    DIFF_OUTPUT=$(diff -r "$REAL_DATA_BACKUP" "$REAL_DATA_DIR" 2>/dev/null || true)
    if [ -z "$DIFF_OUTPUT" ]; then
        pass "真实数据完整性验证 - 与备份完全一致"
    else
        fail "真实数据完整性验证 - 存在差异: $DIFF_OUTPUT"
    fi
else
    info "真实数据目录原本为空，跳过对比验证"
fi
echo ""

info "================================================="
info "测试总结: 共 $TOTAL 项, 通过 $PASS 项, 失败 $FAIL 项"
info "================================================="

if [ "$FAIL" -eq 0 ]; then
    echo ""
    pass "所有测试通过！数据隔离机制工作正常。"
    echo ""
    info "清理测试目录..."
    rm -rf "$TEST_DIR" "$TEST_DIR2" "$REAL_DATA_BACKUP"
    info "清理完成。"
    exit 0
else
    echo ""
    fail "有 $FAIL 项测试失败，请检查问题。"
    echo ""
    info "测试目录保留以便排查: $TEST_DIR"
    exit 1
fi
