export interface IosSemanticNode {
  ref?: string;
  type?: string;
  label?: string;
  identifier?: string;
  value?: unknown;
  enabled?: boolean;
  hittable?: boolean;
  depth?: number;
  rect?: { x?: number; y?: number; width?: number; height?: number };
}

export interface IosSnapshotPolicy {
  interactiveOnly: boolean;
  raw: boolean;
  depth: number;
  scope?: string;
}

export interface IosSearchAdapter {
  discovery: IosSnapshotPolicy;
  searchFieldSelectors: string[];
  submitSelectors: string[];
  isSearchField(node: IosSemanticNode): boolean;
  isSubmit(node: IosSemanticNode): boolean;
}

export interface IosAppAdapter {
  id: string;
  bundleId: string;
  search?: IosSearchAdapter;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && String(value[key]).trim()
    ? String(value[key]).trim()
    : undefined;
}

export function semanticNodes(value: unknown, output: IosSemanticNode[] = []): IosSemanticNode[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => semanticNodes(entry, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  const ref = stringField(record, 'ref');
  const type = stringField(record, 'type');
  if (ref || type) {
    output.push({
      ref,
      type,
      label: stringField(record, 'label'),
      identifier: stringField(record, 'identifier'),
      value: record.value,
      enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
      hittable: typeof record.hittable === 'boolean' ? record.hittable : undefined,
      depth: typeof record.depth === 'number' ? record.depth : undefined,
      rect: record.rect && typeof record.rect === 'object' && !Array.isArray(record.rect)
        ? record.rect as IosSemanticNode['rect']
        : undefined,
    });
  }
  Object.values(record).forEach((entry) => semanticNodes(entry, output));
  return output;
}

export function normalizedSemanticRef(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^@?(e\d+(?:~s\d+)?)$/i);
  return match ? `@${match[1]}` : undefined;
}

export function findSemanticRef(value: unknown, predicate: (node: IosSemanticNode) => boolean): string | undefined {
  for (const node of semanticNodes(value)) {
    if (!predicate(node)) continue;
    const ref = normalizedSemanticRef(node.ref);
    if (ref) return ref;
  }
  return undefined;
}

function searchableText(node: IosSemanticNode): string {
  return [node.label, node.identifier, typeof node.value === 'string' ? node.value : undefined]
    .filter(Boolean)
    .join(' ');
}

export const JD_IOS_APP_ADAPTER: IosAppAdapter = {
  id: 'jd',
  bundleId: 'com.360buy.jdmobile',
  search: {
    // JD's home page nests its actual SearchField around depth 14. A shallow
    // interactive-only snapshot can expose only the tab bar and falsely report
    // that search is absent. Raw structured discovery is bounded to depth 20.
    discovery: { interactiveOnly: false, raw: true, depth: 20 },
    searchFieldSelectors: ['type="SearchField"'],
    submitSelectors: ['type="Button" label="搜索"', 'label="搜索"'],
    isSearchField: (node) => node.type === 'SearchField'
      || (/TextField/i.test(node.type ?? '') && /搜索|搜一搜|请输入|search/i.test(searchableText(node))),
    isSubmit: (node) => node.type === 'Button' && /^(搜索|搜一搜|search)$/i.test(node.label?.trim() ?? ''),
  },
};

export const IOS_APP_ADAPTERS: ReadonlyMap<string, IosAppAdapter> = new Map([
  [JD_IOS_APP_ADAPTER.bundleId, JD_IOS_APP_ADAPTER],
]);

export function iosAppAdapter(bundleId: string): IosAppAdapter | undefined {
  return IOS_APP_ADAPTERS.get(bundleId);
}
