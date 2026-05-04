export type GroovyLicenseType = "personal" | "enterprise" | "enterprise_reseller";

export type GroovyLicenseStatus =
  | "active"
  | "past_due"
  | "expired"
  | "canceled"
  | "suspended"
  | "terminated";

export type GroovySignedEnvelope<TPayload extends Record<string, unknown>> = {
  alg: "Ed25519";
  typ: "groovy-license" | "groovy-activation";
  payload: TPayload;
  signature: string;
};

export type GroovyLicensePayload = {
  license_id: string;
  license_type: GroovyLicenseType;
  status: GroovyLicenseStatus;
  customer_email?: string | null;
  customer_name?: string | null;
  valid_from: string;
  valid_until: string;
  fallback_allowed: boolean;
  max_devices?: number | null;
  max_users?: number | null;
  max_agents?: number | null;
  max_environments?: number | null;
  production_environments?: number | null;
  production_agents?: number | null;
  reseller_billing_enabled: boolean;
  token_consumption_billing_enabled: boolean;
  features: string[];
};

export type GroovyActivationPayload = {
  license_id: string;
  license_type: GroovyLicenseType;
  status: GroovyLicenseStatus;
  device_activation_id: string;
  device_hash: string;
  valid_until: string;
  grace_until: string;
  issued_at: string;
  app_version?: string | null;
};
