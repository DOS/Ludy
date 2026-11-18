import { attachmentCommands, attachmentQueries } from './attachments.ts';
import { exportQueries } from './export.ts';
import { noteCommands, noteQueries } from './notes.ts';
import { systemCommands, systemQueries } from './system.ts';
import { myWorkQueries, todoCommands, todoListCommands, todoListQueries, todoQueries } from './todos.ts';
import { vyCommands, vyQueries } from './vy.ts';

export * from './attachments.ts';
export * from './notes.ts';
export * from './system.ts';
export * from './todos.ts';
export * from './vy.ts';

export const notesCommands = [...noteCommands, ...attachmentCommands, ...todoCommands, ...todoListCommands, ...vyCommands, ...systemCommands];
export const notesQueries = [...noteQueries, ...attachmentQueries, ...todoQueries, ...todoListQueries, ...myWorkQueries, ...exportQueries, ...vyQueries, ...systemQueries];
export { notesManifest } from './manifest.ts';
