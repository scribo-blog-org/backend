export type FieldChange = {
    field: string;
    from?: unknown;
    to?: unknown;
    changed?: boolean;
    from_length?: number;
    to_length?: number;
};

const same = (a: unknown, b: unknown) =>
    (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

export function textPreview(value: unknown, max = 160): string | null {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function changeOf(
    field: string,
    from: unknown,
    to: unknown,
): FieldChange | null {
    return same(from, to)
        ? null
        : { field, from: from ?? null, to: to ?? null };
}

export function compact(
    changes: Array<FieldChange | null | undefined>,
): FieldChange[] {
    return changes.filter((item): item is FieldChange => Boolean(item));
}
