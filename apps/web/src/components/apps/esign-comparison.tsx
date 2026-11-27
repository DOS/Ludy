// SPDX-License-Identifier: AGPL-3.0-only
// Competitor comparison table (desktop) and stacked cards (mobile/tablet) for the Ludy eSign page (/esign).
// Pure Server Component using opaque surface and accent tokens so WCAG 2.2 AA contrast holds in light and dark themes.
import { Section, SectionHead } from '../landing/ui';

export interface EsignComparisonVendor {
  key: string;
  name: string;
  tag?: string;
}

export interface EsignComparisonRow {
  id: string;
  label: string;
  values: readonly [string, string, string, string];
}

export interface EsignComparisonCopy {
  title: string;
  lead: string;
  caption: string;
  capabilityLabel: string;
  vendors: readonly [
    EsignComparisonVendor,
    EsignComparisonVendor,
    EsignComparisonVendor,
    EsignComparisonVendor,
  ];
  rows: readonly EsignComparisonRow[];
  note: string;
}

export function EsignComparison({ copy }: { copy: EsignComparisonCopy }) {
  return (
    <Section id="compare" labelledBy="compare-title" tinted>
      <SectionHead id="compare-title" title={copy.title} lead={copy.lead} />

      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface lg:block">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <caption className="sr-only">{copy.caption}</caption>
          <thead>
            <tr className="border-b border-line bg-surface-2">
              <th scope="col" className="w-[22%] bg-surface-2 px-4 py-3.5 align-top text-xs font-semibold tracking-wide text-subtle uppercase">
                {copy.capabilityLabel}
              </th>
              {copy.vendors.map((vendor, i) => (
                <th
                  key={vendor.key}
                  scope="col"
                  className={
                    i === 0
                      ? 'border-x border-line bg-accent-soft px-4 py-3.5 align-top text-accent-ink'
                      : 'bg-surface-2 px-4 py-3.5 align-top text-fg'
                  }
                >
                  <span className="block font-display text-sm font-semibold">{vendor.name}</span>
                  {vendor.tag ? (
                    <span className={i === 0 ? 'mt-0.5 block text-xs font-normal text-accent-ink' : 'mt-0.5 block text-xs font-normal text-muted'}>
                      {vendor.tag}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-surface">
            {copy.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="bg-surface px-4 py-3.5 align-top font-medium break-words text-fg">
                  {row.label}
                </th>
                {copy.vendors.map((vendor, i) => (
                  <td
                    key={vendor.key}
                    className={
                      i === 0
                        ? 'border-x border-line bg-surface px-4 py-3.5 align-top font-medium break-words text-fg'
                        : 'bg-surface px-4 py-3.5 align-top break-words text-muted'
                    }
                  >
                    {row.values[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-4 lg:hidden">
        {copy.rows.map((row) => (
          <li key={row.id} className="min-w-0 rounded-xl border border-line bg-surface p-4">
            <h3 className="font-display text-base font-semibold text-fg">{row.label}</h3>
            <dl className="mt-3 divide-y divide-line border-t border-line text-sm">
              {copy.vendors.map((vendor, i) => (
                <div key={vendor.key} className="min-w-0 py-2.5 first:pt-2.5 last:pb-0">
                  <dt>
                    {i === 0 ? (
                      <span className="inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-ink">
                        {vendor.name}
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-subtle">{vendor.name}</span>
                    )}
                  </dt>
                  <dd className={i === 0 ? 'mt-1 font-medium break-words text-fg' : 'mt-1 break-words text-muted'}>
                    {row.values[i]}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <p className="mt-4 max-w-[75ch] text-xs text-muted">{copy.note}</p>
    </Section>
  );
}
