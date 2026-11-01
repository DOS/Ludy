import { crmAgentQueries } from './agent.ts';
import { bookingFeedCommands, bookingFeedQueries } from './booking-feed.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { contactQueries } from './contacts.ts';
import { dealCommands, dealQueries } from './deals.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';

export * from './deals.ts';
export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';
export * from './booking-feed.ts';
export * from './contacts.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands, ...bookingFeedCommands, ...dealCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries, ...bookingFeedQueries, ...dealQueries, ...contactQueries];
export { crmManifest } from './manifest.ts';
