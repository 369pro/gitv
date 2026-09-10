import { token } from "./session.js";
import type { Repository } from "../lib/repository.js";
import type { ObjectStore } from "../lib/objects.js";
import type { Snapshot, FileView } from "../lib/types.js";

export interface ApiResponses {
  snapshot: Snapshot;
  more: Snapshot;
  history: Pick<Snapshot, "id" | "time" | "label">[];
  object: Awaited<ReturnType<ObjectStore["inspect"]>>;
  tree: Awaited<ReturnType<Repository["tree"]>>;
  meta: ReturnType<Repository["meta"]>;
  file: FileView;
  ignored: string[];
  diff: Awaited<ReturnType<Repository["commitDiff"]>>;
}
export async function api<K extends keyof ApiResponses>(
  route: K,
  params: Record<string, string | number | null | undefined> = {},
): Promise<ApiResponses[K]> {
  const url = new URL(`/api/${route}`, location.origin);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { "X-Gitv-Token": token } });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `HTTP ${response.status}`;
    throw Error(message);
  }
  // The same-origin API and client are type-checked together. Keep the JSON
  // boundary assertion here rather than scattering casts across views.
  return data as ApiResponses[K];
}
