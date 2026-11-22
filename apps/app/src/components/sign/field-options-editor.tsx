// SPDX-License-Identifier: AGPL-3.0-only
// Inspector controls for eSign Slice 4b choice options (dropdown/radio) and attachment label presets (#3818).
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import {
  SIGN_CHOICE_MAX_OPTIONS,
  isChoiceFieldType,
  type DraftFieldPlacement,
} from '../../lib/sign-fields.ts';

export interface FieldOptionsAndAttachmentEditorProps {
  field: DraftFieldPlacement;
  disabled?: boolean;
  onChangeOptions: (nextOptions: string[]) => void;
  onChangeLabel: (nextLabel: string | null) => void;
}

const ATTACHMENT_PRESET_KEYS = ['idCard', 'businessLicense', 'powerOfAttorney', 'supportingDoc'] as const;

export function FieldOptionsAndAttachmentEditor({
  field,
  disabled = false,
  onChangeOptions,
  onChangeLabel,
}: FieldOptionsAndAttachmentEditorProps) {
  const t = useTranslations('sign.fields');

  if (isChoiceFieldType(field.fieldType)) {
    const options = field.options && field.options.length > 0 ? field.options : [''];
    const canAdd = !disabled && options.length < SIGN_CHOICE_MAX_OPTIONS;

    const updateAt = (index: number, value: string) => {
      const next = options.map((opt, i) => (i === index ? value.slice(0, 200) : opt));
      onChangeOptions(next);
    };

    const removeAt = (index: number) => {
      if (options.length <= 1) return;
      onChangeOptions(options.filter((_, i) => i !== index));
    };

    const addOption = () => {
      if (!canAdd) return;
      onChangeOptions([...options, t('defaultOptionN', { index: String(options.length + 1) })]);
    };

    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2.5" data-testid="field-options-editor">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">{t('optionsHeading')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAdd}
            className="h-7 px-2 text-xs max-md:min-h-11"
            onClick={addOption}
            data-testid="field-options-add-btn"
          >
            + {t('addOptionButton')}
          </Button>
        </div>

        <div className="space-y-1.5">
          {options.map((opt, idx) => {
            const inputId = `field-option-input-${field.localId}-${idx}`;
            return (
              <div key={idx} className="flex items-center gap-1.5">
                <Label htmlFor={inputId} className="sr-only">
                  {t('optionItemLabel', { index: String(idx + 1) })}
                </Label>
                <Input
                  id={inputId}
                  disabled={disabled}
                  value={opt}
                  maxLength={200}
                  placeholder={t('optionPlaceholder', { index: String(idx + 1) })}
                  className="min-w-0 flex-1 text-xs max-md:min-h-11"
                  onChange={(e) => updateAt(idx, e.target.value)}
                  data-testid={`field-option-input-${idx}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || options.length <= 1}
                  className="h-8 shrink-0 px-2 text-xs max-md:min-h-11"
                  aria-label={t('removeOptionAria', { index: String(idx + 1) })}
                  onClick={() => removeAt(idx)}
                  data-testid={`field-option-remove-${idx}`}
                >
                  {t('removeOptionButton')}
                </Button>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{t('optionsHint')}</p>
      </div>
    );
  }

  if (field.fieldType === 'attachment') {
    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2.5" data-testid="field-attachment-presets">
        <span className="block text-xs font-medium text-foreground">{t('attachmentPresetHeading')}</span>
        <div className="flex flex-wrap gap-1.5">
          {ATTACHMENT_PRESET_KEYS.map((presetKey) => {
            const presetLabel = t(`attachmentPresets.${presetKey}`);
            return (
              <Button
                key={presetKey}
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                className="h-7 px-2 text-xs max-md:min-h-11"
                onClick={() => onChangeLabel(presetLabel)}
                data-testid={`field-attachment-preset-${presetKey}`}
              >
                {presetLabel}
              </Button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{t('attachmentHint')}</p>
      </div>
    );
  }

  return null;
}
