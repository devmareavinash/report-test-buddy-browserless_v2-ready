/** Complete, deterministic application fallback; no schema changes required. */
export async function collectPages<T>(query: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: any }>, size = 1000): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += size) {
      const response = await query(offset, offset + size - 1);
      if (response.error) throw new Error(response.error.message || "Could not load results");
      rows.push(...(response.data || []));
      if (!response.data || response.data.length < size) return rows;
    }
  }