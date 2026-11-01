import { crmAgentQueries } from './agent.ts';
import { bookingFeedCommands, bookingFeedQueries } from './booking-feed.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { contactQueries } from './contacts.ts';
import { dealCommands, dealQueries } from './deals.ts';
import { boardQueries, stageCommands } from './stages.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';
import { importCommands, importQueries } from './import.ts';

export { dealCommands, dealCreate, dealDelete, dealGet, dealList, dealMove, dealQueries, dealUpdate, partyDeals, partySearch, pipelineSetup, pipelineStages } from './deals.ts';
export { boardQueries, dealBoard, stageAdd, stageCommands, stageRemove, stageRename, stageReorder } from './stages.ts';
export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';
export * from './booking-feed.ts';
export * from './contacts.ts';
export { importCancel, importCommands, importCommit, importPreview, importQueries, importStage } from './import.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands, ...bookingFeedCommands, ...dealCommands, ...stageCommands, ...importCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries, ...bookingFeedQueries, ...dealQueries, ...boardQueries, ...contactQueries, ...importQueries];
export { crmManifest } from './manifest.ts';
