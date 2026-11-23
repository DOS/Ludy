// SPDX-License-Identifier: AGPL-3.0-only
import { isValidElement, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrEmployee } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { setActiveLocale } from '../src/i18n/runtime.ts';

interface DrivenMutationSlot {
  isPending: boolean;
  error: unknown;
  variables: unknown;
  inFlight: Promise<void> | null;
}

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const apiSpies = vi.hoisted(() => ({
  addEmployee: vi.fn(),
}));
const hookDriver = vi.hoisted(() => ({
  inTargetComponent: false,
  states: [] as unknown[],
  stateCursor: 0,
  mutations: [] as DrivenMutationSlot[],
  mutationCursor: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (<S,>(initialState?: S | (() => S)) => {
      if (!hookDriver.inTargetComponent) return actual.useState(initialState as S);
      const idx = hookDriver.stateCursor++;
      if (idx >= hookDriver.states.length) {
        hookDriver.states.push(typeof initialState === 'function' ? (initialState as () => S)() : initialState);
      }
      const setState = (action: S | ((prev: S) => S)) => {
        const prev = hookDriver.states[idx] as S;
        hookDriver.states[idx] = typeof action === 'function' ? (action as (p: S) => S)(prev) : action;
      };
      return [hookDriver.states[idx] as S, setState];
    }) as typeof actual.useState,
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useMutation: ((options: {
      mutationFn?: (variables: unknown) => Promise<unknown>;
      onSuccess?: (data: unknown, variables: unknown) => Promise<unknown> | unknown;
    }) => {
      if (!hookDriver.inTargetComponent) {
        return actual.useMutation(options as Parameters<typeof actual.useMutation>[0]);
      }
      const idx = hookDriver.mutationCursor++;
      if (idx >= hookDriver.mutations.length) {
        hookDriver.mutations.push({ isPending: false, error: null, variables: undefined, inFlight: null });
      }
      const slot = hookDriver.mutations[idx] as DrivenMutationSlot;
      return {
        isPending: slot.isPending,
        error: slot.error,
        variables: slot.variables,
        reset: () => {
          slot.isPending = false;
          slot.error = null;
          slot.variables = undefined;
        },
        mutate: (variables?: unknown) => {
          slot.isPending = true;
          slot.error = null;
          slot.variables = variables;
          slot.inFlight = (async () => {
            try {
              const data = await options.mutationFn?.(variables);
              await options.onSuccess?.(data, variables);
              slot.isPending = false;
            } catch (err) {
              slot.error = err;
              slot.isPending = false;
            }
          })();
        },
      };
    }) as typeof actual.useMutation,
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input ?? {}], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      hr: {
        payroll: {
          employees: { add: apiSpies.addEmployee, edit: vi.fn(), end: vi.fn(), finalization: vi.fn(), erase: vi.fn() },
          employments: { add: vi.fn() },
          dependents: { add: vi.fn(), end: vi.fn() },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

const {
  AddForm,
  EditForm,
  blankEditDraft,
  buildEditPayload,
  hasEditEmployeeChanges,
  idNumberOk,
} = await import('../src/routes/hr-employees.tsx');
const { Button } = await import('@ludy/ui/components/button');
const { I18nProvider } = await import('../src/i18n/provider.tsx');

const EMP_ID = '00000000-0000-7000-8000-000000000031';
const ENTITY_ID = '00000000-0000-7000-8000-000000000001';

const sampleEmployee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: EMP_ID,
  legalEntityId: ENTITY_ID,
  displayName: 'Nguyễn Văn A',
  departmentId: null,
  departmentName: null,
  jobTitle: null,
  linkedUserId: null,
  linkedMemberName: null,
  address: null,
  identityNumber: null,
  hasIdentityNumber: false,
  accountNumber: null,
  hasAccountNumber: false,
  bankCode: null,
  birthDate: '1991-04-12',
  taxCode: '0123456789',
  insuranceNumber: '7901234568',
  endedOn: null,
  status: 'active',
  isForeign: false,
  workPermitExempt: false,
  workPermitExpiresOn: null,
  hasWorkPermitNumber: false,
  workPermitNumber: null,
  erased: false,
  finalizationAuthorizedYears: [],
  contractAlerts: [],
  current: null,
  employments: [],
  dependents: [],
  ...over,
});

function wrap(ui: ReactNode, locale: 'vi' | 'en' = 'vi') {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function findElements(node: ReactNode, predicate: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (!n || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (isValidElement(n)) {
      const el = n as ReactElement<Record<string, unknown>>;
      if (predicate(el)) matches.push(el);
      if (el.props && 'children' in el.props) walk(el.props.children as ReactNode);
    }
  };
  walk(node);
  return matches;
}

describe('HR employees EditForm birthDate clear & AddForm/EditForm tax/insurance validation (#2748)', () => {
  beforeEach(() => {
    hookDriver.inTargetComponent = false;
    hookDriver.states = [];
    hookDriver.stateCursor = 0;
    hookDriver.mutations = [];
    hookDriver.mutationCursor = 0;
    cache.current.clear();
    apiSpies.addEmployee.mockReset();
  });

  it('(item 2) EditForm supports clearing stored birthDate to null and enables Save', () => {
    const clean = blankEditDraft();
    expect(hasEditEmployeeChanges(clean)).toBe(false);

    const clearingBirth = { ...clean, clear: { ...clean.clear, birth: true } };
    expect(hasEditEmployeeChanges(clearingBirth)).toBe(true);
    expect(buildEditPayload(EMP_ID, clearingBirth)).toEqual({ employeeId: EMP_ID, birthDate: null });

    const htmlWithBirth = wrap(
      <EditForm
        employee={sampleEmployee({ birthDate: '1991-04-12' })}
        departments={[]}
        draft={clearingBirth}
        onChange={() => {}}
        pending={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(htmlWithBirth).toContain('data-testid="hr-edit-birth-clear"');
    expect(htmlWithBirth).toContain('max-md:min-h-11');
    expect(htmlWithBirth).toContain('data-testid="hr-edit-save"');

    const htmlNoBirth = wrap(
      <EditForm
        employee={sampleEmployee({ birthDate: null })}
        departments={[]}
        draft={clean}
        onChange={() => {}}
        pending={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(htmlNoBirth).not.toContain('data-testid="hr-edit-birth-clear"');
  });

  it('(item 3) idNumberOk accepts empty, 10-digit, or 12-digit numeric strings and rejects invalid formats', () => {
    expect(idNumberOk('')).toBe(true);
    expect(idNumberOk('  0123456789  ')).toBe(true);
    expect(idNumberOk('012345678912')).toBe(true);
    expect(idNumberOk('12345')).toBe(false);
    expect(idNumberOk('01234567891')).toBe(false);
    expect(idNumberOk('0123456789abc')).toBe(false);
  });

  it('(item 3) EditForm validates taxCode and insuranceNumber on blur and submit, showing FieldError linked via aria-describedby and aria-invalid', () => {
    const onSubmit = vi.fn();
    let capturedTree: ReactNode = null;
    function Probe({ draft }: { draft: ReturnType<typeof blankEditDraft> }) {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.mutationCursor = 0;
      try {
        capturedTree = EditForm({
          employee: sampleEmployee(),
          departments: [],
          draft,
          onChange: () => {},
          pending: false,
          onSubmit,
          onCancel: () => {},
        });
        return capturedTree;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }

    const invalidDraft = { ...blankEditDraft(), tax: '12345', insurance: 'bad-bhxh' };
    wrap(<Probe draft={invalidDraft} />, 'vi');
    const saveBtn = findElements(capturedTree, (el) => el.props['data-testid'] === 'hr-edit-save')[0]!;
    expect(saveBtn.props.disabled).toBe(false);

    // Blur invalid taxCode -> marks only taxCode invalid with aria-describedby="hr-edit-tax-error".
    const taxInput = findElements(capturedTree, (el) => el.props.id === 'hr-edit-tax')[0]!;
    (taxInput.props.onBlur as (ev: { target: { value: string } }) => void)({ target: { value: '12345' } });
    const afterBlurHtml = wrap(<Probe draft={invalidDraft} />, 'vi');
    expect(afterBlurHtml).toContain('id="hr-edit-tax-error"');
    expect(afterBlurHtml).toContain(viMessages.hrEmployees.taxCodeInvalid);
    expect(afterBlurHtml).not.toContain('id="hr-edit-insurance-error"');
    const invalidatedTax = findElements(capturedTree, (el) => el.props.id === 'hr-edit-tax')[0]!;
    expect(invalidatedTax.props['aria-invalid']).toBe(true);
    expect(invalidatedTax.props['aria-describedby']).toBe('hr-edit-tax-error');

    // Submit marks all invalid fields simultaneously and blocks onSubmit.
    const focusTarget = { focus: vi.fn(), matches: () => true };
    const form = findElements(capturedTree, (el) => el.type === 'form')[0]!;
    (form.props.onSubmit as (ev: FormEvent<HTMLFormElement>) => void)({
      preventDefault: vi.fn(),
      currentTarget: { querySelector: vi.fn(() => focusTarget) } as unknown as HTMLFormElement,
    } as unknown as FormEvent<HTMLFormElement>);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(focusTarget.focus).toHaveBeenCalledTimes(1);

    const afterSubmitHtml = wrap(<Probe draft={invalidDraft} />, 'vi');
    expect(afterSubmitHtml).toContain('id="hr-edit-insurance-error"');
    expect(afterSubmitHtml).toContain(viMessages.hrEmployees.insuranceNumberInvalid);

    // Editing taxCode clears its error until next blur/submit; checking clear stored skips tax/insurance validation.
    (invalidatedTax.props.onChange as (ev: { target: { value: string } }) => void)({ target: { value: '0123456789' } });
    const afterEditHtml = wrap(<Probe draft={{ ...blankEditDraft(), tax: '0123456789', clear: { ...blankEditDraft().clear, insurance: true } }} />, 'vi');
    expect(afterEditHtml).not.toContain('id="hr-edit-tax-error"');
    expect(en.hrEmployees.taxCodeInvalid).toBeTruthy();
    expect(en.hrEmployees.insuranceNumberInvalid).toBeTruthy();
  });

  it('(item 3) AddForm validates taxCode and insuranceNumber on blur and submit in English too, and mobile Buttons enforce 44px touch target', () => {
    let capturedTree: ReactNode = null;
    function Probe() {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.mutationCursor = 0;
      try {
        capturedTree = AddForm({ onClose: () => {}, departments: [], entities: [] });
        return capturedTree;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }

    wrap(<Probe />, 'en');
    const nameInput = findElements(capturedTree, (el) => el.props.id === 'hr-add-name')[0]!;
    (nameInput.props.onChange as (ev: { target: { value: string } }) => void)({ target: { value: 'Trần Văn B' } });
    const termsEl = findElements(capturedTree, (el) => el.props.id === 'hr-add' && typeof el.props.onChange === 'function')[0]!;
    (termsEl.props.onChange as (patch: { baseWage: string }) => void)({ baseWage: '15000000' });
    const taxInput = findElements(capturedTree, (el) => el.props.id === 'hr-add-tax')[0]!;
    (taxInput.props.onChange as (ev: { target: { value: string } }) => void)({ target: { value: '123' } });
    const insInput = findElements(capturedTree, (el) => el.props.id === 'hr-add-insurance')[0]!;
    (insInput.props.onChange as (ev: { target: { value: string } }) => void)({ target: { value: 'bad' } });

    // Re-render after state updates (matching React's controlled input commit before blur/submit).
    wrap(<Probe />, 'en');
    const taxAfterChange = findElements(capturedTree, (el) => el.props.id === 'hr-add-tax')[0]!;
    (taxAfterChange.props.onBlur as (ev: { target: { value: string } }) => void)({ target: { value: '123' } });

    const blurHtml = wrap(<Probe />, 'en');
    expect(blurHtml).toContain('id="hr-add-tax-error"');
    expect(blurHtml).toContain(en.hrEmployees.taxCodeInvalid);
    const badTax = findElements(capturedTree, (el) => el.props.id === 'hr-add-tax')[0]!;
    expect(badTax.props['aria-invalid']).toBe(true);
    expect(badTax.props['aria-describedby']).toBe('hr-add-tax-error');

    const saveBtn = findElements(capturedTree, (el) => el.props['data-testid'] === 'hr-employee-save')[0]!;
    expect(saveBtn.props.disabled).toBe(false);

    const form = findElements(capturedTree, (el) => el.type === 'form')[0]!;
    const focusTarget = { focus: vi.fn(), matches: () => true };
    (form.props.onSubmit as (ev: FormEvent<HTMLFormElement>) => void)({
      preventDefault: vi.fn(),
      currentTarget: { querySelector: vi.fn(() => focusTarget) } as unknown as HTMLFormElement,
    } as unknown as FormEvent<HTMLFormElement>);
    expect(apiSpies.addEmployee).not.toHaveBeenCalled();
    expect(focusTarget.focus).toHaveBeenCalledTimes(1);

    const submitHtml = wrap(<Probe />, 'en');
    expect(submitHtml).toContain('id="hr-add-insurance-error"');
    expect(submitHtml).toContain(en.hrEmployees.insuranceNumberInvalid);

    const btnHtml = renderToStaticMarkup(<Button>Save</Button>);
    expect(btnHtml).toContain('max-md:min-h-11');
  });
});
