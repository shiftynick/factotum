import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addTask, completeTask, loadTasks, saveTasks } from '../src/tasks.js';

test('completed and pending states survive saving and reloading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fictional-web-acceptance-'));
  try {
    const path = join(directory, 'tasks.json');
    const tasks = completeTask(addTask(addTask([], 'Post a letter'), 'Make tea'), 1);
    await saveTasks(path, tasks);
    assert.deepEqual(await loadTasks(path), [
      { id: 1, title: 'Post a letter', completed: true },
      { id: 2, title: 'Make tea', completed: false },
    ]);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(disk.map((task) => task.completed), [true, false]);
    await saveTasks(path, await loadTasks(path));
    assert.deepEqual(await loadTasks(path), tasks);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
