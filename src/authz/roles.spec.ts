import { ROLE_MANAGEMENT } from './role-management';
import { DEFAULT_ROLE, ROLE_VALUES } from './roles';

describe('DEFAULT_ROLE', () => {
    it('is a real role that can be handed out later, not a special case', () => {
        expect(ROLE_VALUES).toContain(DEFAULT_ROLE);
        // Кто может менять роли, тот может и вернуть эту.
        expect(ROLE_MANAGEMENT.admin).toContain(DEFAULT_ROLE);
        expect(ROLE_MANAGEMENT.tech_admin).toContain(DEFAULT_ROLE);
    });
});
