import { exportQueries } from './export.ts';
import { noteCommands, noteQueries } from './notes.ts';
import { systemCommands } from './system.ts';
import { myWorkQueries, todoCommands, todoQueries } from './todos.ts';
import { vyCommands, vyQueries } from './vy.ts';

export * from './notes.ts';
export * from './system.ts';
export * from './todos.ts';
export * from './vy.ts';

export const notesCommands = [...noteCommands, ...todoCommands, ...vyCommands, ...systemCommands];
export const notesQueries = [...noteQueries, ...todoQueries, ...myWorkQueries, ...exportQueries, ...vyQueries];
export { notesManifest } from './manifest.ts';
