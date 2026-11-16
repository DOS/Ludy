// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HrDepartmentView, HrEmployee, HrEmployeeSummary, LegalEntity } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

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
        departments: {
          add: vi.fn(),
          edit: vi.fn(),
          archive: vi.fn(),
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
  filterDepartmentsForEntity,
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

describe('HR departments UI panel & employee assignment (#3412)', () => {
  beforeEach(() => cache.current.clear());

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
});
