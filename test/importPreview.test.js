import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "zfl-import-test-"));

const { createPreview, getPreview, commitImport, listTasks, TASK_STATUS } = await import("../importPreview.js");
const { initialize, readBirdsStore } = await import("../dataStore.js");
const { loadDictionaries } = await import("../dictionaries.js");

await initialize();
await loadDictionaries();

test("createPreview: empty records should throw invalid_input", async () => {
  await assert.rejects(
    () => createPreview([], []),
    { message: "invalid_input" }
  );
});

test("createPreview: records not an array should throw invalid_input", async () => {
  await assert.rejects(
    () => createPreview(null, []),
    { message: "invalid_input" }
  );
});

test("createPreview: unknown species blocks commit (status=blocked)", async () => {
  const records = [
    { ringNo: "T-UNKNOWN-001", species: "不存在的物种" }
  ];
  const preview = await createPreview(records, []);
  assert.equal(preview.status, TASK_STATUS.BLOCKED);
  assert.equal(preview.validation.hasBlockingErrors, true);
  assert.equal(preview.validation.unknownSpecies.length, 1);
  assert.equal(preview.validation.unknownSpecies[0].species, "不存在的物种");

  await assert.rejects(
    () => commitImport(preview.taskId),
    { message: "has_blocking_errors" }
  );

  const fetched = await getPreview(preview.taskId);
  assert.equal(fetched.status, TASK_STATUS.BLOCKED);
});

test("commitImport: duplicate ringNo in same batch skips the second", async () => {
  const records = [
    { ringNo: "T-DUP-001", species: "黑尾鸥", measurements: [{ wing: 300, weight: 400 }] },
    { ringNo: "T-DUP-001", species: "黑尾鸥", measurements: [{ wing: 300, weight: 400 }] }
  ];
  const preview = await createPreview(records, []);
  assert.equal(preview.status, TASK_STATUS.READY);
  assert.equal(preview.validation.hasBlockingErrors, false);

  const result = await commitImport(preview.taskId);
  assert.equal(result.completed, true);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.status, TASK_STATUS.COMMITTED);

  const skippedDup = result.skippedDetails.find(s => s.reason === "duplicate_in_batch_processed");
  assert.ok(skippedDup, "should have skipped duplicate_in_batch_processed");
  assert.equal(skippedDup.ringNo, "T-DUP-001");

  const birdsStore = await readBirdsStore();
  const matchingBirds = birdsStore.birds.filter(b => b.ringNo === "T-DUP-001");
  assert.equal(matchingBirds.length, 1, "duplicate ringNo should not create duplicate birds");
});

test("commitImport: duplicate ringNo in DB (existingBirds) is skipped during validation and commit", async () => {
  const existingBirds = [{ ringNo: "T-DUPDB-001", species: "黑尾鸥" }];
  const records = [
    { ringNo: "T-DUPDB-001", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-DUPDB-002", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const preview = await createPreview(records, existingBirds);
  assert.equal(preview.status, TASK_STATUS.BLOCKED);
  assert.equal(preview.validation.duplicateInDb.length, 1);
  assert.equal(preview.validation.duplicateInDb[0].ringNo, "T-DUPDB-001");

  await assert.rejects(
    () => commitImport(preview.taskId),
    { message: "has_blocking_errors" }
  );
});

test("commitImport: batchSize partial commit can continue to completion", async () => {
  const records = [
    { ringNo: "T-BATCH-001", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-BATCH-002", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-BATCH-003", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-BATCH-004", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-BATCH-005", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const preview = await createPreview(records, []);
  assert.equal(preview.status, TASK_STATUS.READY);

  const r1 = await commitImport(preview.taskId, { batchSize: 2 });
  assert.equal(r1.completed, false);
  assert.equal(r1.imported, 2);
  assert.equal(r1.status, TASK_STATUS.PARTIAL);
  assert.equal(r1.progress.processed, 2);
  assert.equal(r1.progress.remaining, 3);
  assert.equal(r1.progress.total, 5);

  const midTask = await getPreview(preview.taskId);
  assert.equal(midTask.status, TASK_STATUS.PARTIAL);
  assert.equal(midTask.commitState.processedCount, 2);
  assert.equal(midTask.commitState.successCount, 2);

  const r2 = await commitImport(preview.taskId);
  assert.equal(r2.completed, true);
  assert.equal(r2.imported, 5);
  assert.equal(r2.skipped, 0);
  assert.equal(r2.status, TASK_STATUS.COMMITTED);
  assert.equal(r2.progress.processed, 5);
  assert.equal(r2.progress.remaining, 0);

  const finalTask = await getPreview(preview.taskId);
  assert.equal(finalTask.status, TASK_STATUS.COMMITTED);
  assert.ok(finalTask.commitState.committedAt, "committedAt should be set");

  const birdsStore = await readBirdsStore();
  for (let i = 1; i <= 5; i++) {
    assert.ok(
      birdsStore.birds.some(b => b.ringNo === `T-BATCH-00${i}`),
      `bird T-BATCH-00${i} should be in DB`
    );
  }
});

test("commitImport: batchSize exactly matches records count completes in one call", async () => {
  const records = [
    { ringNo: "T-EXACT-001", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-EXACT-002", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const preview = await createPreview(records, []);
  const result = await commitImport(preview.taskId, { batchSize: 2 });
  assert.equal(result.completed, true);
  assert.equal(result.imported, 2);
  assert.equal(result.status, TASK_STATUS.COMMITTED);
});

test("commitImport: already committed task is idempotent (no duplicate writes)", async () => {
  const records = [
    { ringNo: "T-IDEM-001", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-IDEM-002", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const preview = await createPreview(records, []);

  const r1 = await commitImport(preview.taskId);
  assert.equal(r1.completed, true);
  assert.equal(r1.imported, 2);
  assert.equal(r1.alreadyCommitted, undefined);
  assert.equal(r1.status, TASK_STATUS.COMMITTED);

  const birdsBefore = await readBirdsStore();
  const countBefore = birdsBefore.birds.filter(b => b.ringNo.startsWith("T-IDEM-")).length;
  assert.equal(countBefore, 2);

  const r2 = await commitImport(preview.taskId);
  assert.equal(r2.alreadyCommitted, true);
  assert.equal(r2.completed, true);
  assert.equal(r2.imported, r1.imported);
  assert.equal(r2.skipped, r1.skipped);
  assert.equal(r2.failed, r1.failed);

  const birdsAfter = await readBirdsStore();
  const countAfter = birdsAfter.birds.filter(b => b.ringNo.startsWith("T-IDEM-")).length;
  assert.equal(countAfter, 2, "second commit should not create more birds");
});

test("task status lifecycle: ready → committing → partial → committed", async () => {
  const records = [
    { ringNo: "T-LIFE-001", species: "黑尾鸥", measurements: [{ wing: 300 }] },
    { ringNo: "T-LIFE-002", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const preview = await createPreview(records, []);
  assert.equal(preview.status, TASK_STATUS.READY);
  assert.ok(preview.createdAt > 0);

  const r1 = await commitImport(preview.taskId, { batchSize: 1 });
  assert.equal(r1.status, TASK_STATUS.PARTIAL);

  const r2 = await commitImport(preview.taskId, { batchSize: 1 });
  assert.equal(r2.status, TASK_STATUS.COMMITTED);
  assert.ok(r2.completed);
});

test("listTasks: shows created tasks with correct summaries", async () => {
  const records = [
    { ringNo: "T-LIST-001", species: "黑尾鸥", measurements: [{ wing: 300 }] }
  ];
  const beforeCount = (await listTasks()).length;
  const preview = await createPreview(records, []);
  await commitImport(preview.taskId);

  const tasks = await listTasks();
  assert.ok(tasks.length >= beforeCount + 1);
  const ourTask = tasks.find(t => t.taskId === preview.taskId);
  assert.ok(ourTask, "newly created task should appear in listTasks");
  assert.equal(ourTask.status, TASK_STATUS.COMMITTED);
  assert.equal(ourTask.totalRecords, 1);
  assert.ok(ourTask.commitProgress);
  assert.equal(ourTask.commitProgress.committed, 1);
});

test("getPreview: returns null for non-existent taskId", async () => {
  const result = await getPreview("IMP-NONEXISTENT-XXX");
  assert.equal(result, null);
});
