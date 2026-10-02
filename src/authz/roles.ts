export const ROLES = {
    USER: 'user',
    AUTHOR: 'author',
    ADMIN: 'admin',
    MODERATOR: 'moderator',
    TECH_ADMIN: 'tech_admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_VALUES = Object.values(ROLES);

/**
 * Роль нового пользователя. Задаётся явно при регистрации, а не берётся «из
 * схемы»: это обычная роль, её можно выдать и позже (см. role-management), и
 * от неё же отталкивается журнал, когда прежняя роль в записи не сохранилась.
 */
export const DEFAULT_ROLE: Role = ROLES.USER;
