import { mcpFinanceQueries } from './mcp.ts';
import { financeSalesSignals } from './signals-sales.ts';
export { MCP_LINES_PER_INVOICE, zMcpInvoicesInput } from './mcp.ts';
import { fixedAssetCommands, fixedAssetQueries } from './fixed-assets.ts';
import { createAccount, setVendorDefaultAccount, updateAccount } from './accounts.ts';
import { categorizationCommands, categorizationQueries } from './categorization.ts';
import { recordPurchase, revisePurchase } from './record.ts';
import { cashVouchers, prepareVoucher, recordVoucher, vouchersList } from './cash-voucher.ts';
import { prepareJournalVoucher, recordJournalVoucher } from './journal-voucher.ts';
import { prepareYearClosing, recordYearClosing } from './year-closing.ts';
import { prepareReversal, reverseEntry } from './reversal.ts';
import { openingBalancePost, openingBalancePreview } from './opening-balance.ts';
import { fileForExtraction, purchaseLookup } from './extract.ts';
import { accountsList, documentGet, documentsList, journalExport, journalGet, journalList, purchaseVouchers, salesVouchers, vendorsList, voidedProposals } from './queries.ts';
import { salesNumberGapsQuery, vatDeclarationQuery, vatExport, vatPaymentMark, vatPeriodQuery, vatReturnMark } from './vat.ts';
import { ledgerAccountQuery, ledgerBookQuery, ledgerExport, ledgerPeriodQuery } from './ledger-reports.ts';
import { portalListImport, portalListReconcile, portalListRecord, portalListRemove, portalListSource } from './portal-list.ts';
import { portalSyncCommands, portalSyncQueries } from './portal-sync.ts';
import { bankImport, bankIngest, bankLines, bankPreview } from './bank.ts';
import { bankAccountNumberCommands, bankAccountNumberQueries } from './bank-account-number.ts';
import { bankFeedCommands, bankFeedQueries } from './bank-feed.ts';
import { bankStatementConfirm, bankStatementLines, bankStatementReject, bankStatementStage } from './bank-statement-file.ts';
import { bankLineVoucher, bankOpenLines, bankPayrollMatch, bankSuggestions } from './bank-match.ts';
import { bankGroupQueries } from './bank-groups.ts';
import { bankPartyRuleCommands, bankPartyRuleQueries } from './bank-rules.ts';
import { financeToday } from './today.ts';
import { periodLock, periodLockStateQuery, periodUnlock } from './period-lock.ts';
import { bookEntitiesList } from './legal-entity.ts';
import { statementsExport, statementsPeriodQuery } from './statements.ts';
import { statementsHtkkQueries } from './statements-htkk.ts';
import { missingInvoicesReminderSet, missingInvoicesRemind, missingInvoicesRequest, missingInvoicesStatus } from './missing-invoices.ts';
import { searchQuery } from './search.ts';
import { documentExports } from './document-exports.ts';
import { misaGoodsCodeCommands, misaGoodsCodeQueries } from './misa-goods-codes.ts';
import { customersList } from './parties.ts';
import { financeNotificationCommands } from './notifications.ts';
import { collectionSettingCommands, collectionSettingQueries } from './collection-settings.ts';
import { paymentReminderCommands, paymentReminderQueries } from './payment-reminders.ts';
import { financeOverviewQuery } from './overview.ts';
import { einvoiceConnectionCommands, einvoiceConnectionQueries } from './einvoice-connections.ts';
import { einvoiceCommands, einvoiceQueries } from './einvoice-drafts.ts';
import { marketplaceIncomeCommands, marketplaceIncomeQueries } from './marketplace-income.ts';
import { marketplaceRetentionCommands, marketplaceRetentionQueries } from './marketplace-retention.ts';
import { marketplaceCommands, marketplaceQueries } from './marketplace-orders.ts';
import { einvoiceIssueCommands, einvoiceIssueQueries } from './einvoice-issue.ts';
import { einvoiceJobCommands } from './einvoice-job.ts';
export { EINVOICE_DUE_PAGE, einvoiceDue } from './einvoice-job.ts';
import { stockCommands, stockQueries } from './stock.ts';
import { stockLineCommands, stockLineQueries } from './stock-lines.ts';
import { orderHandoffCommands } from './order-handoff.ts';
import { payrollPaymentCommands } from './payroll-payment.ts';
import { payrollSettlement } from './payroll-settlement.ts';
import { payrollPostingCommands } from './payroll-posting.ts';
import { stockCloseCommands } from './stock-close.ts';
import { stockCountCommands, stockCountQueries } from './stock-count.ts';
import { stockExportCommands } from './stock-export.ts';
import { stockReportQueries } from './stock-report.ts';
import { stockLowQueries } from './stock-low.ts';
export type { ReorderSource, SuggestSource } from './stock-low.ts';
export type { EInvoiceSuggestSource, EInvoiceSuggestParty, RateCount } from './einvoice-suggest.ts';

export { AI_BUDGET_MESSAGE, AI_BUDGET_RECHECK_MS, aiCost, extractAndPropose, recordExtractionFailure, type ExtractDeps } from './extract.ts';
export { NOT_A_REPORT, readMarketplaceFile, recordMarketplaceReadFailure, type MarketplaceFileDeps } from './marketplace-orders.ts';
export { readMarketplaceIncomeFile, recordMarketplaceIncomeReadFailure, type MarketplaceIncomeFileDeps } from './marketplace-income.ts';
export { NOT_A_STATEMENT, readStatementFile, recordStatementReadFailure, statementFileRows, unmappedMessage, type StatementFileDeps, type StatementStageOutcome } from './bank-statement-file.ts';
export {
  checkPortalList,
  firstPerOutcome,
  importPortalList,
  recordPortalListFailure,
  PORTAL_LIST_ACTOR,
  PORTAL_PERIOD_ROW_LIMIT,
  PORTAL_RECONCILE_ITEMS_PER_OUTCOME,
  PORTAL_RECONCILE_LIMIT,
  reconcilePeriod,
  type PortalListDeps,
} from './portal-list.ts';
export { vatPeriod } from './domain/vat-return.ts';
export { defaultLegalEntityId, legalEntityError, resolveLegalEntity } from './legal-entity.ts';
export {
  normalizePortalInvoices,
  PORTAL_LIST_TOO_LARGE_MESSAGE,
  PortalListTooLarge,
  parseJsonKeepingNumbers,
  portalDate,
  readSyncedList,
  PORTAL_QUERIES,
  PORTAL_SYNC_CONTENT_TYPE,
  type NormalizedPortalList,
  type PortalAnswer,
  type PortalQuery,
} from './domain/portal-api.ts';
export { xmlCallKey, PORTAL_SYNC_TARGET, PORTAL_WRONG_PASSWORD_LIMIT, type PortalCallError, type PortalXmlItem, type PortalXmlPlan } from './portal-sync.ts';
export {
  MISSING_INVOICE_ACTOR,
  MISSING_INVOICE_REMIND_SOURCE,
  MISSING_INVOICE_REQUEST_SOURCE,
  MISSING_INVOICE_TEMPLATE,
  MISSING_INVOICES_PER_MAIL,
  REMINDER_DAY_MAX,
  collectMissing,
  formatAmount,
  mailPayload,
  MISSING_INVOICE_PAYLOAD_BYTES,
  periodLabel,
  type MissingItem,
  renderMissingInvoiceMail,
  zMissingInvoiceMail,
  type MissingInvoiceMail,
  type MissingInvoiceStatus,
  type RemindResult,
  type RenderedMail,
} from './missing-invoices.ts';
import { yearArchiveCommands, yearArchiveQueries } from './year-archive.ts';
export * from './domain/portal-reconcile.ts';
export { foldVietnamese, portalStatus } from './domain/portal-status.ts';
export { buildJournalWorkbook } from './export.ts';
export { buildVatWorkbook, VAT_RATE_LABELS, VAT_WARNING_LABELS } from './vat-export.ts';
export { buildVat01Xml, xmlCarryForward, type XmlCarryForwardSource } from './vat-xml.ts';
export { buildLedgerWorkbook } from './ledger-export.ts';
export { buildStatementsWorkbook } from './statements-export.ts';
export { buildStatementsHtkkXml, type StatementsFiling } from './statements-htkk.ts';
export * from './domain/statements-htkk-xml.ts';
export { buildFixedAssetsWorkbook } from './fixed-assets-export.ts';
export { buildStockWorkbook } from './stock-export.ts';
export {
  MISA_SME_BANK_CREDIT,
  MISA_SME_BANK_DEBIT,
  MISA_SME_CASH_PAYMENT,
  MISA_SME_CASH_RECEIPT,
  MISA_SME_PURCHASE_GOODS,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  buildMisaWorkbook,
  cashRows,
  goodsPurchaseRows,
  purchaseRows,
  salesRows,
  servicePurchaseRows,
  type CashVoucher,
  type PurchaseVoucher,
  type SalesVoucher,
} from './misa.ts';
export { CHIEF_ACCOUNTANT_TEMPLATE, chiefAccountantReview, financeAgentPrograms, reviewText } from './agent.ts';
export * from './domain/money.ts';
export * from './domain/ledger.ts';
export { postJournalEntry, postNewEntry, sourceRevisionError } from './ledger.ts';
export * from './domain/tt133-reports.ts';
export * from './domain/vat-return.ts';
export * from './domain/number-gaps.ts';
export * from './domain/vat-01gtgt-xml.ts';
export * from './domain/ledger-reports.ts';
export * from './domain/opening-balance.ts';
export * from './domain/cash-voucher.ts';
export * from './domain/bank-statement.ts';
export * from './domain/bank-match.ts';
export { type OrgChartAccount } from './accounts.ts';
export { REVERSAL_COMMAND, REVERSAL_KIND, zJournalReversal, type JournalReversal } from './reversal.ts';
export { JOURNAL_EXPORT_LIMIT, VOIDED_PROPOSALS_QUERY, type JournalEntryView } from './queries.ts';
export {
  VAT_EXPORT_FORMATS,
  VAT_PERIOD_LIMIT,
  VAT_WARNINGS,
  type VatDeclaration,
  type VatInvoiceView,
  type VatReport,
  type VatSide,
  type VatTaxpayer,
  type VatWarning,
} from './vat.ts';
export { LEDGER_LINE_LIMIT, type AccountLedgerView, type LedgerBook, type LedgerReport } from './ledger-reports.ts';
export { FINANCE_NOTIFYING_EVENTS, PERIOD_CLOSING_SWEEP_MS, sweepPeriodClosing } from './notifications.ts';
export { SEARCH_LIMIT, searchAmount, type SearchResult } from './search.ts';
export { ARCHIVE_FORMAT, type ArchiveSource, type ArchiveSourceFile, type RecordedArchive } from './year-archive.ts';
export { type FinancialStatements, type StatementLine, type UnmappedRow } from './statements.ts';

export const financeCommands = [recordPurchase, revisePurchase, prepareReversal, reverseEntry, journalExport, vatExport, ledgerExport, statementsExport, openingBalancePost, periodLock, periodUnlock, bankImport, bankIngest, bankStatementConfirm, bankStatementReject, createAccount, updateAccount, setVendorDefaultAccount, prepareVoucher, recordVoucher, prepareJournalVoucher, recordJournalVoucher, prepareYearClosing, recordYearClosing, portalListImport, portalListRemove, portalListRecord, missingInvoicesRequest, missingInvoicesReminderSet, missingInvoicesRemind, vatPaymentMark, vatReturnMark, ...portalSyncCommands, ...financeNotificationCommands, ...yearArchiveCommands, ...fixedAssetCommands, ...misaGoodsCodeCommands, ...categorizationCommands, ...bankFeedCommands, ...bankAccountNumberCommands, ...bankPartyRuleCommands, ...paymentReminderCommands, ...collectionSettingCommands, ...einvoiceCommands, ...einvoiceConnectionCommands, ...einvoiceIssueCommands, ...einvoiceJobCommands, ...stockCommands, ...stockLineCommands, ...orderHandoffCommands, ...stockCloseCommands, ...payrollPostingCommands, ...payrollPaymentCommands, ...stockCountCommands, ...stockExportCommands, ...marketplaceCommands, ...marketplaceIncomeCommands, ...marketplaceRetentionCommands];
export const financeQueries = [
  ...mcpFinanceQueries,
  financeSalesSignals,
  payrollSettlement,
  ...fixedAssetQueries,
  ...bankFeedQueries,
  ...bankAccountNumberQueries,
  bankStatementStage,
  bankStatementLines,
  ...statementsHtkkQueries,
  fileForExtraction,
  purchaseLookup,
  vendorsList,
  customersList,
  documentsList,
  documentGet,
  documentExports,
  journalList,
  journalGet,
  accountsList,
  voidedProposals,
  purchaseVouchers,
  salesVouchers,
  vatPeriodQuery,
  salesNumberGapsQuery,
  vatDeclarationQuery,
  ledgerPeriodQuery,
  ledgerAccountQuery,
  ledgerBookQuery,
  statementsPeriodQuery,
  financeOverviewQuery,
  openingBalancePreview,
  vouchersList,
  cashVouchers,
  portalListSource,
  portalListReconcile,
  ...portalSyncQueries,
  missingInvoicesStatus,
  periodLockStateQuery,
  bookEntitiesList,
  bankPreview,
  bankLines,
  bankLineVoucher,
  bankSuggestions,
  bankPayrollMatch,
  bankOpenLines,
  ...bankGroupQueries,
  ...bankPartyRuleQueries,
  ...collectionSettingQueries,
  ...paymentReminderQueries,
  ...einvoiceQueries,
  ...einvoiceConnectionQueries,
  ...einvoiceIssueQueries,
  ...stockQueries,
  ...stockLineQueries,
  ...stockReportQueries,
  ...stockLowQueries,
  ...stockCountQueries,
  ...marketplaceQueries,
  ...marketplaceIncomeQueries,
  ...marketplaceRetentionQueries,
  financeToday,
  searchQuery,
  ...yearArchiveQueries,
  ...misaGoodsCodeQueries,
  ...categorizationQueries,
];
export {
  PAYMENT_REMINDER_INVOICES_MAX,
  PAYMENT_REMINDER_SOURCE,
  PAYMENT_REMINDER_TEMPLATE,
  renderPaymentReminderMail,
  zPaymentReminderMail,
  type PaymentReminderMail,
} from './payment-reminder-mail.ts';
export * from './domain/payment-reminder.ts';
export { financeManifest } from './manifest.ts';
