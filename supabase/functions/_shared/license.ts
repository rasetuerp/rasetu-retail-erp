// Shared shape/checks used by both license-activate and license-validate.

export type LicenseRow = {
  id: string;
  license_key: string;
  type: string;
  status: string;
  block_reason: string | null;
  customer_name: string | null;
  customer_business_name: string | null;
  customer_gstin: string | null;
  machine_id: string | null;
  activated_at: string | null;
  trial_expires_on: string | null;
  amc_expires_on: string | null;
  max_machines: number;
};

export function licensePayload(row: LicenseRow) {
  return {
    key: row.license_key,
    type: row.type,
    status: row.status,
    customerName: row.customer_name,
    customerBusinessName: row.customer_business_name,
    customerGstin: row.customer_gstin,
    amcExpiresOn: row.amc_expires_on,
    trialExpiresOn: row.trial_expires_on,
  };
}

/** Returns a rejection { reason, message, httpStatus } if the license can't be used right now, else null. */
export function checkLicenseUsable(
  row: LicenseRow,
  machineId: string
): { reason: string; message: string; httpStatus: number } | null {
  if (row.status === 'BLOCKED') {
    return { reason: 'BLOCKED', message: row.block_reason ?? 'This license has been blocked. Contact support.', httpStatus: 403 };
  }

  if (row.machine_id && row.machine_id !== machineId) {
    return { reason: 'MAX_MACHINES', message: 'This license is already activated on a different machine.', httpStatus: 403 };
  }

  if (row.type === 'TRIAL' && row.trial_expires_on && new Date(row.trial_expires_on) < new Date()) {
    return { reason: 'EXPIRED', message: 'Trial period has expired. Contact support to purchase a license.', httpStatus: 410 };
  }

  return null;
}
