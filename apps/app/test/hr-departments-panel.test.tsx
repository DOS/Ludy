// SPDX-License-Identifier: AGPL-3.0-only
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrDepartmentView, HrEmployee, HrEmployeeSummary, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

interface DrivenMutationSlot {
  isPending: boolean;
  error: unknown;
  variables: unknown;
  inFlight: Promise<void> | null;
}

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
const apiSpies = vi.hoisted(() => ({
  deptAdd: vi.fn(),
  deptEdit: vi.fn(),
  deptArchive: vi.fn(),
  invalidateQueries: vi.fn(),
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
  const origInvalidate = cache.current.invalidateQueries.bind(cache.current);
  cache.current.invalidateQueries = ((...args: Parameters<typeof origInvalidate>) => {
    apiSpies.invalidateQueries(...args);
    return origInvalidate(...args);
  }) as typeof cache.current.invalidateQueries;
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
        departments: {
          add: apiSpies.deptAdd,
          edit: apiSpies.deptEdit,
          archive: apiSpies.deptArchive,
        },
        payroll: {
          employees: {
            add: vi.fn(),
            edit: vi.fn(),
          },
        },
      },
    },
    queryClient: cache.current,
    errorMessage: (e: unknown) => String(e),
  };
});

const {
  AddForm,
  DepartmentsSection,
  Detail,
  HrEmployeesPage,
  applyDepartmentDefaultPayFunction,
  blankTerms,
  clearEditingDepartmentOnComplete,
  filterDepartmentsForEntity,
  formatDepartmentFilterOptionLabel,
  resolveVisibleDepartmentFilter,
} = await import('../src/routes/hr-employees.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const ORG_ID = '00000000-0000-7000-8000-000000000001';
const ENTITY_ID = '00000000-0000-7000-8000-000000000002';
const BRANCH_ENTITY_ID = '00000000-0000-7000-8000-000000000003';
const DEPT_SALES_ID = '00000000-0000-7000-8000-000000000101';
const DEPT_ARCHIVED_ID = '00000000-0000-7000-8000-000000000102';
const DEPT_BRANCH_ID = '00000000-0000-7000-8000-000000000103';
const EMP_ID = '00000000-0000-7000-8000-000000000201';

const MAIN_ENTITY: LegalEntity = {
  id: ENTITY_ID,
  name: 'Trụ sở chính',
  kind: 'company',
  taxCode: null,
  parentId: null,
  isDefault: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const BRANCH_ENTITY: LegalEntity = {
  id: BRANCH_ENTITY_ID,
  name: 'Chi nhánh HN',
  kind: 'branch',
  taxCode: null,
  parentId: ENTITY_ID,
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const BRANCH_DEPT: HrDepartmentView = {
  id: DEPT_BRANCH_ID,
  legalEntityId: BRANCH_ENTITY_ID,
  name: 'Kho Hà Nội',
  code: 'HN-01',
  payFunction: 'production',
  archivedAt: null,
  activeEmployees: 1,
  activeBaseWageTotal: '12000000.00',
};

const SALES_DEPT: HrDepartmentView = {
  id: DEPT_SALES_ID,
  legalEntityId: ENTITY_ID,
  name: 'Kinh doanh',
  code: 'KD-01',
  payFunction: 'sales',
  archivedAt: null,
  activeEmployees: 2,
  activeBaseWageTotal: '30000000.00',
};

const ARCHIVED_DEPT: HrDepartmentView = {
  id: DEPT_ARCHIVED_ID,
  legalEntityId: ENTITY_ID,
  name: 'Kho cũ',
  code: null,
  payFunction: 'overhead',
  archivedAt: '2026-10-01T00:00:00.000Z',
  activeEmployees: 0,
  activeBaseWageTotal: '0.00',
};

const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'vi') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
};

function collectByTestId(node: ReactNode, testId: string, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectByTestId(item, testId, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as Record<string, unknown>;
  if (props['data-testid'] === testId) {
    out.push(node as ReactElement<Record<string, unknown>>);
  }
  if (props.children !== undefined) {
    collectByTestId(props.children as ReactNode, testId, out);
  }
  return out;
}

function requireByTestId(node: ReactNode, testId: string, index = 0): ReactElement<Record<string, unknown>> {
  const found = collectByTestId(node, testId)[index];
  if (!found) throw new Error(`missing testId ${testId} at index ${index}`);
  return found;
}

describe('HR departments UI panel & employee assignment (#3412)', () => {
  beforeEach(() => {
    cache.current.clear();
    apiSpies.deptAdd.mockReset();
    apiSpies.deptEdit.mockReset();
    apiSpies.deptArchive.mockReset();
    apiSpies.invalidateQueries.mockReset();
    hookDriver.inTargetComponent = false;
    hookDriver.states = [];
    hookDriver.stateCursor = 0;
    hookDriver.mutations = [];
    hookDriver.mutationCursor = 0;
  });

  it('renders subtle empty state when no departments exist and rows with headcount & VND totals when populated', () => {
    const emptyHtml = wrap(
      <DepartmentsSection
        departments={[]}
        showArchived={false}
        onShowArchivedChange={() => {}}
        loading={false}
        error={null}
      />,
      'vi',
    );
    expect(emptyHtml).toContain('data-testid="hr-departments-card"');
    expect(emptyHtml).toContain('data-testid="hr-departments-empty"');
    expect(emptyHtml).toContain('data-testid="hr-department-new"');

    const populatedVi = wrap(
      <DepartmentsSection
        departments={[SALES_DEPT, ARCHIVED_DEPT, BRANCH_DEPT]}
        entities={[MAIN_ENTITY, BRANCH_ENTITY]}
        showArchived
        onShowArchivedChange={() => {}}
        loading={false}
        error={null}
      />,
      'vi',
    );
    expect(populatedVi).toContain('Chi nhánh HN');
    expect(populatedVi).toContain('Kinh doanh');
    expect(populatedVi).toContain('KD-01');
    expect(populatedVi).toContain('data-testid="hr-department-headcount"');
    expect(populatedVi).toContain('data-testid="hr-department-wage-total"');
    expect(populatedVi).toContain('30.000.000');
    expect(populatedVi).toContain('Kho cũ');
    expect(populatedVi).toContain(viMessages.hrEmployees.departments.archivedBadge);

    const populatedEn = wrap(
      <DepartmentsSection
        departments={[SALES_DEPT, ARCHIVED_DEPT]}
        showArchived
        onShowArchivedChange={() => {}}
        loading={false}
        error={null}
      />,
      'en',
    );
    expect(populatedEn).toContain(en.hrEmployees.departments.title);
    expect(populatedEn).toContain(en.hrEmployees.departments.archivedBadge);
  });

  it('renders HrEmployeesPage cleanly in zero-setup state and with department filter + department/job-title column', () => {
    cache.current.setQueryData(['org', 'get', {}], { orgId: ORG_ID, role: 'owner' });
    cache.current.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], []);
    const unassignedEmployee: HrEmployeeSummary = {
      id: EMP_ID,
      legalEntityId: ENTITY_ID,
      displayName: 'Nguyễn Văn Không',
      departmentId: null,
      departmentName: null,
      jobTitle: null,
      status: 'active',
      endedOn: null,
      current: {
        id: '00000000-0000-7000-8000-000000000301',
        effectiveFrom: '2026-01-01',
        contractType: 'indefinite',
        contractForm: null,
        termMonths: null,
        contractEndOn: null,
        fixedTermSequence: null,
        probationRoleTier: null,
        probationEndOn: null,
        probationWage: null,
        region: 'I',
        baseWage: '15000000.00',
        payFunction: 'admin',
      },
      hasIdentityNumber: false,
      hasAccountNumber: false,
      contractAlerts: [],
    };
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'list', { status: 'active', limit: 200 }], [unassignedEmployee]);

    const zeroSetupHtml = wrap(<HrEmployeesPage />, 'vi');
    expect(zeroSetupHtml).toContain('data-testid="hr-employee-new"');
    expect(zeroSetupHtml).toContain('data-testid="hr-departments-empty"');
    expect(zeroSetupHtml).toContain('data-testid="hr-employee-dept-filter"');
    expect(zeroSetupHtml).toContain('data-testid="hr-employee-dept-cell"');

    cache.current.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], [SALES_DEPT]);
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'list', { status: 'active', limit: 200 }], [
      { ...unassignedEmployee, departmentId: DEPT_SALES_ID, departmentName: 'Kinh doanh', jobTitle: 'Trưởng nhóm KD' },
    ]);

    const assignedHtml = wrap(<HrEmployeesPage />, 'vi');
    expect(assignedHtml).toContain('Kinh doanh - Trưởng nhóm KD');
    expect(assignedHtml).toContain('value="' + DEPT_SALES_ID + '"');
  });

  it('defaults AddForm payFunction from picked department unless manually overridden, and renders Detail department info', () => {
    const base = blankTerms();
    expect(base.payFunction).toBe('admin');
    const fromDept = applyDepartmentDefaultPayFunction(base, DEPT_SALES_ID, [SALES_DEPT], false);
    expect(fromDept.payFunction).toBe('sales');
    const overridden = applyDepartmentDefaultPayFunction({ ...base, payFunction: 'overhead' }, DEPT_SALES_ID, [SALES_DEPT], true);
    expect(overridden.payFunction).toBe('overhead');

    const addHtml = wrap(<AddForm departments={[SALES_DEPT, BRANCH_DEPT]} entities={[MAIN_ENTITY, BRANCH_ENTITY]} onClose={() => {}} />, 'vi');
    expect(addHtml).toContain('data-testid="hr-add-legal-entity"');
    expect(addHtml).toContain('data-testid="hr-add-department"');
    expect(addHtml).toContain('data-testid="hr-add-job-title"');
    expect(addHtml).toContain('Kinh doanh');
    expect(addHtml).not.toContain('Kho Hà Nội');

    expect(filterDepartmentsForEntity([SALES_DEPT, ARCHIVED_DEPT, BRANCH_DEPT], ENTITY_ID).map((d) => d.id)).toEqual([DEPT_SALES_ID]);
    expect(filterDepartmentsForEntity([SALES_DEPT, ARCHIVED_DEPT, BRANCH_DEPT], BRANCH_ENTITY_ID).map((d) => d.id)).toEqual([DEPT_BRANCH_ID]);
    expect(resolveVisibleDepartmentFilter(DEPT_SALES_ID, [SALES_DEPT], true)).toBe(DEPT_SALES_ID);
    expect(resolveVisibleDepartmentFilter(DEPT_SALES_ID, [], false)).toBe(DEPT_SALES_ID);
    expect(resolveVisibleDepartmentFilter(DEPT_SALES_ID, [BRANCH_DEPT], true)).toBe('');

    const detail: HrEmployee = {
      id: EMP_ID,
      legalEntityId: ENTITY_ID,
      displayName: 'Trần Thị Bán Hàng',
      departmentId: DEPT_SALES_ID,
      departmentName: 'Kinh doanh',
      jobTitle: 'Trưởng nhóm KD',
      status: 'active',
      endedOn: null,
      current: {
        id: '00000000-0000-7000-8000-000000000301',
        effectiveFrom: '2026-01-01',
        contractType: 'indefinite',
        contractForm: null,
        termMonths: null,
        contractEndOn: null,
        fixedTermSequence: null,
        probationRoleTier: null,
        probationEndOn: null,
        probationWage: null,
        region: 'I',
        baseWage: '15000000.00',
        payFunction: 'sales',
      },
      hasIdentityNumber: false,
      hasAccountNumber: false,
      contractAlerts: [],
      address: null,
      identityNumber: null,
      accountNumber: null,
      bankCode: null,
      birthDate: null,
      taxCode: null,
      insuranceNumber: null,
      finalizationAuthorizedYears: [],
      erased: false,
      employments: [],
      dependents: [],
    };
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'get', { employeeId: EMP_ID }], detail);
    const detailHtml = wrap(<Detail employeeId={EMP_ID} owner departments={[SALES_DEPT]} onClose={() => {}} />, 'vi');
    expect(detailHtml).toContain('data-testid="hr-employee-department"');
    expect(detailHtml).toContain('data-testid="hr-employee-job-title"');
    expect(detailHtml).toContain('Kinh doanh');
    expect(detailHtml).toContain('Trưởng nhóm KD');
  });

  it('defines all HR department i18n error codes and command labels in both vi and en', () => {
    for (const msg of [viMessages, en]) {
      expect(msg.kernelErrors.codes.HR_DEPARTMENT_NOT_FOUND).toBeTruthy();
      expect(msg.kernelErrors.codes.HR_DEPARTMENT_NAME_TAKEN).toBeTruthy();
      expect(msg.kernelErrors.codes.HR_DEPARTMENT_ARCHIVED).toBeTruthy();
      expect(msg.kernelErrors.codes.HR_DEPARTMENT_WRONG_ENTITY).toBeTruthy();
      expect(msg.commands.hr.department.add).toBeTruthy();
      expect(msg.commands.hr.department.edit).toBeTruthy();
      expect(msg.commands.hr.department.archive).toBeTruthy();
    }
  });

  it('keeps single-entity department filter options uncluttered and includes legal-entity name in multi-entity orgs (#3433)', () => {
    expect(formatDepartmentFilterOptionLabel(SALES_DEPT, [], viMessages.hrEmployees.departments.archivedBadge)).toBe('Kinh doanh');
    expect(formatDepartmentFilterOptionLabel(SALES_DEPT, [MAIN_ENTITY], viMessages.hrEmployees.departments.archivedBadge)).toBe('Kinh doanh');
    expect(formatDepartmentFilterOptionLabel(ARCHIVED_DEPT, [MAIN_ENTITY], viMessages.hrEmployees.departments.archivedBadge)).toBe(
      `Kho cũ (${viMessages.hrEmployees.departments.archivedBadge})`,
    );
    expect(
      formatDepartmentFilterOptionLabel(SALES_DEPT, [MAIN_ENTITY, BRANCH_ENTITY], viMessages.hrEmployees.departments.archivedBadge),
    ).toBe('Kinh doanh - Trụ sở chính');
    expect(
      formatDepartmentFilterOptionLabel(BRANCH_DEPT, [MAIN_ENTITY, BRANCH_ENTITY], viMessages.hrEmployees.departments.archivedBadge),
    ).toBe('Kho Hà Nội - Chi nhánh HN');
    expect(
      formatDepartmentFilterOptionLabel(ARCHIVED_DEPT, [MAIN_ENTITY, BRANCH_ENTITY], en.hrEmployees.departments.archivedBadge),
    ).toBe(`Kho cũ - Trụ sở chính (${en.hrEmployees.departments.archivedBadge})`);

    cache.current.setQueryData(['org', 'get', {}], { orgId: ORG_ID, role: 'owner' });
    cache.current.setQueryData(['hr', 'payroll', 'employees', 'list', { status: 'active', limit: 200 }], []);
    cache.current.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], [SALES_DEPT]);
    cache.current.setQueryData(['legalEntities', 'list', {}], [MAIN_ENTITY]);

    const singleEntityHtml = wrap(<HrEmployeesPage />, 'vi');
    const singleSelectMatch = singleEntityHtml.match(/<select[^>]*id="hr-emp-dept-filter"[^>]*>([\s\S]*?)<\/select>/);
    expect(singleSelectMatch?.[1]).toContain(`value="${DEPT_SALES_ID}">Kinh doanh</option>`);
    expect(singleSelectMatch?.[1]).not.toContain('Trụ sở chính');

    cache.current.setQueryData(['hr', 'departments', 'list', { includeArchived: false }], [SALES_DEPT, BRANCH_DEPT]);
    cache.current.setQueryData(['legalEntities', 'list', {}], [MAIN_ENTITY, BRANCH_ENTITY]);

    const multiEntityHtml = wrap(<HrEmployeesPage />, 'vi');
    const multiSelectMatch = multiEntityHtml.match(/<select[^>]*id="hr-emp-dept-filter"[^>]*>([\s\S]*?)<\/select>/);
    expect(multiSelectMatch?.[1]).toContain(`value="${DEPT_SALES_ID}">Kinh doanh - Trụ sở chính</option>`);
    expect(multiSelectMatch?.[1]).toContain(`value="${DEPT_BRANCH_ID}">Kho Hà Nội - Chi nhánh HN</option>`);
  });

  it('preserves unsaved edits on Department B when Department A save resolves, and closes when still editing Department A (#3433)', async () => {
    const draftB = {
      id: DEPT_BRANCH_ID,
      origName: 'Kho Hà Nội',
      origCode: 'HN-01',
      origPayFunction: 'production' as const,
      name: 'Kho Hà Nội Mở Rộng',
      code: 'HN-01',
      payFunction: 'production' as const,
    };
    expect(clearEditingDepartmentOnComplete(draftB, DEPT_SALES_ID)).toBe(draftB);
    expect(clearEditingDepartmentOnComplete(draftB, DEPT_BRANCH_ID)).toBeNull();
    expect(clearEditingDepartmentOnComplete(null, DEPT_SALES_ID)).toBeNull();

    let resolveDeptA!: (value: { departmentId: string }) => void;
    apiSpies.deptEdit
      .mockImplementationOnce(
        () =>
          new Promise<{ departmentId: string }>((resolve) => {
            resolveDeptA = resolve;
          }),
      )
      .mockResolvedValueOnce({ departmentId: DEPT_BRANCH_ID });

    let capturedTree: ReactNode = null;
    function Probe(props: Parameters<typeof DepartmentsSection>[0]) {
      hookDriver.inTargetComponent = true;
      hookDriver.stateCursor = 0;
      hookDriver.mutationCursor = 0;
      try {
        const rendered = DepartmentsSection(props);
        capturedTree = rendered;
        return rendered;
      } finally {
        hookDriver.inTargetComponent = false;
      }
    }

    const renderProbe = () =>
      wrap(
        <Probe
          departments={[SALES_DEPT, BRANCH_DEPT]}
          entities={[MAIN_ENTITY, BRANCH_ENTITY]}
          showArchived={false}
          onShowArchivedChange={() => {}}
          loading={false}
          error={null}
        />,
        'vi',
      );

    // 1. Open edit form for Department A (SALES_DEPT), modify its name, and submit save.
    renderProbe();
    expect(collectByTestId(capturedTree, 'hr-department-edit')).toHaveLength(2);
    (requireByTestId(capturedTree, 'hr-department-edit', 0).props.onClick as () => void)();

    renderProbe();
    const deptANameInput = requireByTestId(capturedTree, 'hr-dept-edit-name');
    (deptANameInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'Kinh doanh B2B' },
    });

    renderProbe();
    const deptASaveButton = requireByTestId(capturedTree, 'hr-dept-edit-save');
    expect(deptASaveButton.props.disabled).toBe(false);
    (deptASaveButton.props.onClick as () => void)();

    expect(apiSpies.deptEdit).toHaveBeenCalledTimes(1);
    expect(apiSpies.deptEdit).toHaveBeenLastCalledWith({
      departmentId: DEPT_SALES_ID,
      name: 'Kinh doanh B2B',
    });

    // 2. While Department A's save is still pending, switch to editing Department B (BRANCH_DEPT) and type unsaved edits.
    const pendingHtmlA = renderProbe();
    expect(requireByTestId(capturedTree, 'hr-dept-edit-save').props.loading).toBe(true);
    expect(pendingHtmlA).toContain('value="Kinh doanh B2B"');

    (requireByTestId(capturedTree, 'hr-department-edit', 1).props.onClick as () => void)();

    renderProbe();
    const deptBNameInput = requireByTestId(capturedTree, 'hr-dept-edit-name');
    expect(deptBNameInput.props.value).toBe('Kho Hà Nội');
    expect(requireByTestId(capturedTree, 'hr-dept-edit-save').props.loading).toBe(false);
    (deptBNameInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'Kho Hà Nội Mở Rộng' },
    });

    // 3. Resolve Department A's save + refresh: Department B's unsaved draft must remain intact!
    const updateSlot = hookDriver.mutations[1] as DrivenMutationSlot;
    resolveDeptA({ departmentId: DEPT_SALES_ID });
    await updateSlot.inFlight;
    expect(apiSpies.invalidateQueries).toHaveBeenCalledTimes(1);

    const afterDeptAResolvedHtml = renderProbe();
    expect(afterDeptAResolvedHtml).toContain('data-testid="hr-department-edit-form"');
    expect(afterDeptAResolvedHtml).toContain('value="Kho Hà Nội Mở Rộng"');
    const deptBSaveButton = requireByTestId(capturedTree, 'hr-dept-edit-save');
    expect(deptBSaveButton.props.disabled).toBe(false);

    // 4. Saving Department B while still editing Department B clears the edit form on completion.
    (deptBSaveButton.props.onClick as () => void)();
    await updateSlot.inFlight;
    expect(apiSpies.deptEdit).toHaveBeenCalledTimes(2);
    expect(apiSpies.deptEdit).toHaveBeenLastCalledWith({
      departmentId: DEPT_BRANCH_ID,
      name: 'Kho Hà Nội Mở Rộng',
    });

    const afterDeptBResolvedHtml = renderProbe();
    expect(afterDeptBResolvedHtml).not.toContain('data-testid="hr-department-edit-form"');
  });
});
