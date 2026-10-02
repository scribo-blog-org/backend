/**
 * Снимки для журнала. В записи лога лежат id сущностей, но сами сущности потом
 * удаляют и переименовывают, поэтому заголовок поста, название категории и
 * подобное кладём прямо в запись: она должна читаться и после удаления.
 */

export type FieldChange = {
    field: string;
    from?: unknown;
    to?: unknown;
    /** Для длинных значений (текст поста, картинка): известно только, что изменилось. */
    changed?: boolean;
    /** Длина текста до и после, если сам текст в журнал не кладём. */
    from_length?: number;
    to_length?: number;
};

export type CategorySnapshot = {
    name: string;
    icon?: number;
    color?: number;
};

const same = (a: unknown, b: unknown) =>
    (a ?? null) === (b ?? null) || String(a ?? '') === String(b ?? '');

/** Короткая выдержка из текста для журнала. */
export function textPreview(value: unknown, max = 160): string | null {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Изменение значения поля или null, если значение осталось прежним. */
export function changeOf(
    field: string,
    from: unknown,
    to: unknown,
): FieldChange | null {
    return same(from, to)
        ? null
        : { field, from: from ?? null, to: to ?? null };
}

export function categorySnapshot(
    category:
        { name?: unknown; icon?: unknown; color?: unknown } | null | undefined,
): CategorySnapshot | null {
    if (!category || typeof category.name !== 'string') return null;
    return {
        name: category.name,
        ...(typeof category.icon === 'number' ? { icon: category.icon } : {}),
        ...(typeof category.color === 'number'
            ? { color: category.color }
            : {}),
    };
}

export function compact(
    changes: Array<FieldChange | null | undefined>,
): FieldChange[] {
    return changes.filter((item): item is FieldChange => Boolean(item));
}
