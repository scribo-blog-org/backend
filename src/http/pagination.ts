export function parsePagination(
    query: { page?: string | number; limit?: string | number } = {},
    defaultLimit = 10,
    maxLimit = 50,
) {
    let page = Number.parseInt(String(query.page ?? '1'), 10);
    let limit = Number.parseInt(String(query.limit ?? defaultLimit), 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;
    return { page, limit, skip: (page - 1) * limit };
}

export function paginationMeta(page: number, limit: number, total: number) {
    return {
        page,
        limit,
        total,
        pages: total > 0 ? Math.ceil(total / limit) : 0,
    };
}
