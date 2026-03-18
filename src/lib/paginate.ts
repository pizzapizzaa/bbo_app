const PAGE_SIZE = 1000;

/**
 * Fetches all rows from a Supabase query by paginating with `.range()`,
 * bypassing the default 1000-row cap.
 *
 * @param selectFn  A function that receives (from, to) and returns a
 *                  Supabase query builder with `.range(from, to)` applied.
 */
export async function fetchAllPages(
  selectFn: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>
): Promise<{ data: any[]; error: any }> {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await selectFn(from, from + PAGE_SIZE - 1);
    if (error) return { data: [], error };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: all, error: null };
}
