import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addTask, completeTask, loadTasks, saveTasks } from '../src/tasks.js';

test('adding and completing tasks preserves the original collection', () => {
  const original = addTask([], '  Buy pencils  ');
  const completed = completeTask(original, 1);
  assert.deepEqual(original, [{ id: 1, title: 'Buy pencils', completed: false }]);
  assert.equal(completed[0].completed, true);
  assert.throws(() => addTask(original, ' '), /nonempty/);
  assert.throws(() => completeTask(original, 9), /does not exist/);
});

test('pending tasks round trip and older files load as pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fictional-web-baseline-'));
  try {
    const path = join(directory, 'tasks.json');
    assert.deepEqual(await loadTasks(path), []);
    const tasks = addTask([], 'Water seedlings');
    await saveTasks(path, tasks);
    assert.deepEqual(await loadTasks(path), tasks);
    await writeFile(path, '[{"id":8,"title":"Read a book"}]');
    assert.deepEqual(await loadTasks(path), [{ id: 8, title: 'Read a book', completed: false }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
