export const ROLES = {
    USER: 'user',
    AUTHOR: 'author',
    ADMIN: 'admin',
    MODERATOR: 'moderator',
    TECH_ADMIN: 'tech_admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_VALUES = Object.values(ROLES);

export const DEFAULT_ROLE: Role = ROLES.USER;
