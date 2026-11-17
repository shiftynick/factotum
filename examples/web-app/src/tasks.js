import { readFile, writeFile } from 'node:fs/promises';

export function addTask(tasks, title) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('A task needs a nonempty title');
  }
  const id = Math.max(0, ...tasks.map((task) => task.id)) + 1;
  return [...tasks, { id, title: title.trim(), completed: false }];
}

export function completeTask(tasks, id) {
  if (!tasks.some((task) => task.id === id)) {
    throw new Error(`Task ${id} does not exist`);
  }
  return tasks.map((task) => task.id === id ? { ...task, completed: true } : task);
}

export async function saveTasks(path, tasks) {
  const saved = tasks.map(({ id, title }) => ({ id, title }));
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
}

export async function loadTasks(path) {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    return saved.map((task) => ({ ...task, completed: task.completed === true }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
