export const PERMISSIONS = {
    CREATE_POST: 'create_post',
    EDIT_ANY_POST: 'edit_any_post',
    DELETE_ANY_POST: 'delete_any_post',
    CREATE_CATEGORY: 'create_category',
    EDIT_ANY_CATEGORY: 'edit_any_category',
    DELETE_ANY_CATEGORY: 'delete_any_category',
    DELETE_ANY_COMMENT: 'delete_any_comment',
    MANAGE_ROLES: 'manage_roles',
    MANAGE_VERIFICATION: 'manage_verification',
    VIEW_LOGS: 'view_logs',
    MANAGE_SUPPORT: 'manage_support',
    MANAGE_BACKUPS: 'manage_backups',
    RESTORE_BACKUPS: 'restore_backups',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
