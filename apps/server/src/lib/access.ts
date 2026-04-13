import type postgres from 'postgres';
import { isSuperuser } from './response';

type Sql = postgres.Sql;

export interface UserAccessFlags {
  isSuperadmin: boolean;
  isCrmAdmin: boolean;
  isComplianceOfficer: boolean;
  /** True when the user has role 'bdm' (Business Development Manager). */
  isBdm: boolean;
  role: string | null;
}

/**
 * Resolves the role-based access flags for a session user.
 *
 * Superusers always count as CRM admins. Any user entity with
 * `properties.role === 'crm_admin'` also counts as a CRM admin.
 * Any user entity with `properties.role === 'compliance_officer'` counts as a
 * compliance officer.
 * Any user entity with `properties.role === 'bdm'` counts as a BDM.
 */
export async function getUserAccessFlags(userId: string, sql: Sql): Promise<UserAccessFlags> {
  const isSuperadmin = isSuperuser(userId);
  if (isSuperadmin) {
    return {
      isSuperadmin: true,
      isCrmAdmin: true,
      isComplianceOfficer: true,
      isBdm: false,
      role: 'superuser',
    };
  }

  const rows = await sql<{ properties: Record<string, unknown> }[]>`
    SELECT properties
    FROM entities
    WHERE id = ${userId}
      AND type = 'user'
    LIMIT 1
  `;

  const role = typeof rows[0]?.properties?.role === 'string' ? rows[0].properties.role : null;
  return {
    isSuperadmin: false,
    isCrmAdmin: role === 'crm_admin',
    isComplianceOfficer: role === 'compliance_officer',
    isBdm: role === 'bdm',
    role,
  };
}

/**
 * Returns true when the user may access CRM entity management endpoints.
 */
export async function canManageCrmEntities(userId: string, sql: Sql): Promise<boolean> {
  const flags = await getUserAccessFlags(userId, sql);
  return flags.isCrmAdmin;
}
