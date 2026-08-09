-- One test TRIAL key for local/dev verification. Real keys are issued via
-- the Supabase table editor (lean MVP — no admin console yet).
insert into licenses (license_key, type, status, customer_name, customer_business_name)
values ('RTL-TRIAL-DEV0-0001', 'TRIAL', 'TRIAL', 'Dev Test', 'RaSetu Dev Verification')
on conflict (license_key) do nothing;
