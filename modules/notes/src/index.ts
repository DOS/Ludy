import { exportQueries } from './export.ts';
import { noteCommands, noteQueries } from './notes.ts';
import { systemCommands } from './system.ts';
import { myWorkQueries, todoCommands, todoListCommands, todoListQueries, todoQueries } from './todos.ts';
import { vyCommands, vyQueries } from './vy.ts';

export * from './notes.ts';
export * from './system.ts';
export * from './todos.ts';
export * from './vy.ts';

export const notesCommands = [...noteCommands, ...todoCommands, ...todoListCommands, ...vyCommands, ...systemCommands];
export const notesQueries = [...noteQueries, ...todoQueries, ...todoListQueries, ...myWorkQueries, ...exportQueries, ...vyQueries];
export { notesManifest } from './manifest.ts';
