-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2320, the posted half of #2269; plan docs/plan/einvoice-lookup.md section 7): the seller's original
-- XML that arrives after its invoice was posted from a PDF or a photo is attached to the posted proposal as evidence.
-- Idempotent; applied files stay untouched.
--
-- Where the link lives. A posted document (crove_finance.purchase_document) is append-only and its entry is never changed,
-- so nothing is added to it. The evidence is the XML file's own extraction run, which is already the record of what was read
-- from the file, its checks and its signature result, and a finished run never changes (extraction_guard). Two columns say
-- that the run is the original of a proposal that was already executed:
--
-- crove_kernel.extraction.original_of_proposal_id  the executed proposal the run is the original of: a run inserted already
--                          done, by the worker, with no proposal of its own (the original is not posted again). The composite
--                          foreign key keeps it inside the org and on a real proposal (kernel to kernel, as source_file_id
--                          would be if it had one); an index backs it.
-- crove_kernel.extraction.original_differs         whether the original's subtotal, VAT or total differ from the posted
--                          document's: a warning for a person to look at, never a correction (the entry is not touched).
--                          Set exactly when original_of_proposal_id is.
--
-- Both are written at insert and never change: the UPDATE grant of the table lists only the columns that finish a pending
-- run, which these are not, and extraction_guard freezes a finished run's content. Only the run's own method and status
-- may carry them: an e-invoice XML read, done.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS original_of_proposal_id uuid;
ALTER TABLE crove_kernel.extraction ADD COLUMN IF NOT EXISTS original_differs boolean;

ALTER TABLE crove_kernel.extraction DROP CONSTRAINT IF EXISTS extraction_original_fk;
ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_original_fk
  FOREIGN KEY (org_id, original_of_proposal_id) REFERENCES crove_kernel.proposal (org_id, id);

ALTER TABLE crove_kernel.extraction DROP CONSTRAINT IF EXISTS extraction_original_shape;
ALTER TABLE crove_kernel.extraction ADD CONSTRAINT extraction_original_shape CHECK (
  (original_of_proposal_id IS NULL) = (original_differs IS NULL)
  AND (original_of_proposal_id IS NULL OR (method = 'einvoice_xml' AND status = 'done')));

CREATE INDEX IF NOT EXISTS extraction_original_idx ON crove_kernel.extraction (org_id, original_of_proposal_id);
