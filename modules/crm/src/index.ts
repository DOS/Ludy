import { crmAgentQueries } from './agent.ts';
import { bookingFeedCommands, bookingFeedQueries } from './booking-feed.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { companySuggestQueries } from './company-suggest.ts';
export { companyCandidates, companySuggestQueries, domainLabelOf, emailDomainOf, taxCodesIn } from './company-suggest.ts';
import { contactQueries } from './contacts.ts';
import { dealCommands, dealQueries } from './deals.ts';
import { boardQueries, stageCommands } from './stages.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';
import { importCommands, importQueries } from './import.ts';
import { nextStepCommands, nextStepQueries } from './next-steps.ts';
import { followupQueries } from './followup-source.ts';
import { meetingBriefQueries } from './meeting-brief.ts';
import { quoteCommands, quoteQueries } from './quotes.ts';
import { quotePdfQueries } from './quote-pdf.ts';
import { quoteSuggestSource } from './quote-suggest.ts';
import { quoteReport } from './quote-report.ts';
import { salesOrderCommands, salesOrderQueries } from './sales-orders.ts';
import { crmOpenDealsSignals } from './signals-open-deals.ts';
import { crmWonDealsSignals } from './signals-won-deals.ts';
import { crmToday } from './today.ts';

export { dealCommands, dealConversations, dealCreate, dealDelete, dealGet, dealList, dealMove, dealQueries, dealUpdate, partyConversations, partyDeals, partySearch, pipelineSetup, pipelineStages } from './deals.ts';
export { boardQueries, dealBoard, stageAdd, stageCommands, stageRemove, stageRename, stageReorder } from './stages.ts';
export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';
export * from './booking-feed.ts';
export * from './contacts.ts';
export { importCancel, importCommands, importCommit, importExpire, importPreview, importQueries, importStage } from './import.ts';

export { dealSettingGet, dealSettingSet, nextStepCommands, nextStepDone, nextStepList, nextStepQueries, nextStepRaise, nextStepSnooze, staleDays } from './next-steps.ts';

export { loadQuoteDocument, quoteDocument, type QuoteDocumentData, type QuoteLogoFile } from './quote-pdf.ts';
export { renderQuotePdf, type QuoteDocument, type QuoteParty } from './pdf/quote-document.ts';
export { readLogoImage, type PdfImage } from './pdf/image.ts';
export { dealHasQuotes, dealQuotes, quoteCommands, quoteDefaults, quoteDeleteDraft, newQuoteToken, quoteGet, quoteLinkCreate, quoteLinkRevoke, quoteList, quoteLogoRemove, quoteLogoSet, quoteQueries, quoteRevise, quoteSave, quoteSend, quoteSettingGet, quoteSettingSet, quoteTokenHash } from './quotes.ts';

export { QUOTE_MAIL_SOURCE, QUOTE_MAIL_TEMPLATE, renderQuoteMail, zQuoteMail } from './quote-mail.ts';

export { quoteSuggestSource, type QuoteSuggestSource } from './quote-suggest.ts';
export { followupQueries, followupSource, type FollowupSource } from './followup-source.ts';
export { meetingBriefQueries, meetingBriefSourceQuery, type MeetingBriefSource } from './meeting-brief.ts';
export { quoteReport } from './quote-report.ts';

export { dealSalesOrders, quoteAccept, quoteDecline, salesOrderCancel, salesOrderCommands, salesOrderDeliver, salesOrderGet, salesOrderHandoff, salesOrderList, salesOrderQueries, salesOrderUndeliver } from './sales-orders.ts';

export { crmToday } from './today.ts';

export const crmCommands = [...eventTypeCommands, ...bookingCommands, ...bookingFeedCommands, ...dealCommands, ...stageCommands, ...importCommands, ...nextStepCommands, ...quoteCommands, ...salesOrderCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries, ...bookingFeedQueries, ...dealQueries, ...boardQueries, ...contactQueries, ...companySuggestQueries, ...importQueries, ...nextStepQueries, ...quoteQueries, quoteSuggestSource, ...followupQueries, ...meetingBriefQueries, quoteReport, ...quotePdfQueries, ...salesOrderQueries, crmToday, crmWonDealsSignals, crmOpenDealsSignals];
export { crmManifest } from './manifest.ts';
