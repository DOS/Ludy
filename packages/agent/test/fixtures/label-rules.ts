// SPDX-License-Identifier: AGPL-3.0-only
// The label rules the kernel hands the label suggestion (#5010): the contract's own, the ones a label the recorder types meets. The agent package does not import the contract, so its tests build them here.
import { MEETING_LABELS_MAX, cleanLabelText, labelKey, labelProblem } from '../../../kernel-contract/src/meeting-labels.ts';
import type { LabelRules } from '../../src/member-vy/index.ts';

export const LABEL_RULES: LabelRules = { clean: (text) => (labelProblem(text) === null ? cleanLabelText(text) : null), key: labelKey, maxLabels: MEETING_LABELS_MAX };
