import { PERMISSIONS } from './permissions';
import { ROLE_PERMISSIONS } from './role-permissions';
import type { Role } from './roles';
import { ROLE_MANAGEMENT } from './role-management';
import { DEFAULT_ROLE, ROLE_VALUES } from './roles';

describe('DEFAULT_ROLE', () => {
    it('is a real role that can be handed out later, not a special case', () => {
        expect(ROLE_VALUES).toContain(DEFAULT_ROLE);
        expect(ROLE_MANAGEMENT.admin).toContain(DEFAULT_ROLE);
        expect(ROLE_MANAGEMENT.tech_admin).toContain(DEFAULT_ROLE);
    });
});

describe('MANAGE_VERIFICATION', () => {
    it('is held by admins and tech admins only', () => {
        const holders = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter(
            (role) =>
                ROLE_PERMISSIONS[role].includes(
                    PERMISSIONS.MANAGE_VERIFICATION,
                ),
        );
        expect(holders.sort()).toEqual(['admin', 'tech_admin']);
    });
});
