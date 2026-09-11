// ─── Types ───

export interface DataQueryResult {
  keys: string[];
  value: unknown;
}

export interface DataOpResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export type DataQueryHandler = (key: string) => DataQueryResult | undefined;
export type DataOpHandler = (operation: string, params?: Record<string, unknown>) => DataOpResult;

export interface DataSourceDescriptor {
  itemId: string;
  desktopId: string;
  label: string;
  contentType: string;
  dataKeys: string[];
  queryHandler?: DataQueryHandler;
  opHandler?: DataOpHandler;
}

// ─── Registry ───

const registry = new Map<string, DataSourceDescriptor>();

export function registerDataSource(
  descriptor: DataSourceDescriptor
): void {
  registry.set(descriptor.itemId, descriptor);
}

export function updateDataSource(
  itemId: string,
  partial: Partial<Omit<DataSourceDescriptor, "itemId">>
): void {
  const existing = registry.get(itemId);
  if (!existing) return;
  registry.set(itemId, { ...existing, ...partial });
}

export function unloadDataSource(itemId: string): void {
  registry.delete(itemId);
}

export function getDataSource(itemId: string): DataSourceDescriptor | undefined {
  return registry.get(itemId);
}

export function getAllDataSources(): DataSourceDescriptor[] {
  return [...registry.values()];
}

export function queryData(itemId: string, key: string): DataQueryResult | undefined {
  const ds = registry.get(itemId);
  if (!ds?.queryHandler) return undefined;
  return ds.queryHandler(key);
}

export function executeOperation(
  itemId: string,
  operation: string,
  params?: Record<string, unknown>
): DataOpResult {
  const ds = registry.get(itemId);
  if (!ds?.opHandler) {
    return { success: false, error: `No operation handler for item ${itemId}` };
  }
  return ds.opHandler(operation, params);
}
