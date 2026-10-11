import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { ErrorState, Loading } from '@/components/ui/Feedback';
import { FieldRow, Input, Select, type SelectOption } from '@/components/ui/Field';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { AuthLayout } from './AuthLayout';
import s from './Auth.module.css';

/**
 * Step 2: the company.
 *
 * This is the call that creates the tenant, which is the isolation boundary for
 * everything afterwards — so it is also the point where the account stops being
 * a login and becomes a workspace.
 *
 * Industry and currency options come from the server's catalog, not a list typed
 * in here. The server validates `service_type` against the same catalog, so a
 * hardcoded frontend list would eventually offer an option the server rejects.
 */

/** Free-form on the server, so these are conveniences rather than a contract. */
const COUNTRIES: SelectOption[] = [
  { value: 'IN', label: 'India' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'AE', label: 'United Arab Emirates' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'JP', label: 'Japan' },
];

const SIZES: SelectOption[] = [
  { value: '1-10', label: '1–10 people' },
  { value: '11-50', label: '11–50 people' },
  { value: '51-200', label: '51–200 people' },
  { value: '201-1000', label: '201–1,000 people' },
  { value: '1000+', label: 'More than 1,000' },
];

/** Which currency to preselect for a country. A nicety, fully overridable. */
const CURRENCY_FOR_COUNTRY: Record<string, string> = {
  IN: 'INR',
  US: 'USD',
  GB: 'GBP',
  AE: 'AED',
  SG: 'SGD',
  AU: 'AUD',
  DE: 'EUR',
  JP: 'JPY',
};

export function OnboardingPage() {
  const navigate = useNavigate();
  const { status, needsOnboarding, catalog, refresh } = useSession();

  const [companyName, setCompanyName] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [country, setCountry] = useState('IN');
  const [currency, setCurrency] = useState('INR');
  const [size, setSize] = useState('');

  // The session's catalog comes from /auth/me and is normally already loaded.
  // The public catalog is the fallback for the case where this page is opened
  // directly before the bootstrap call has returned.
  const fallback = useAsync(() => authApi.catalog(), [], { enabled: !catalog });
  const options = catalog ?? fallback.data?.catalog ?? null;

  useEffect(() => {
    setCurrency((prev) => CURRENCY_FOR_COUNTRY[country] ?? prev);
  }, [country]);

  const complete = useMutation(
    () =>
      authApi.completeProfile({
        company_name: companyName.trim(),
        service_type: serviceType,
        currency,
        country,
        company_size: size,
      }),
    {
      onSuccess: async () => {
        // Re-read /auth/me so the shell has the tenant before navigating —
        // going straight to /app against a session that still looks incomplete
        // would bounce the user back here.
        await refresh();
        // Straight to the dashboard. The old interstitial asked everyone to
        // create a project before they had seen anything, which made an empty
        // account feel like a chore list rather than a workspace.
        navigate('/app', { replace: true });
      },
    },
  );

  // Guards. This page is reachable while authenticated-but-incomplete only.
  if (status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Loading label="Loading" />
      </div>
    );
  }
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (!needsOnboarding) return <Navigate to="/app" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!companyName.trim() || !serviceType) return;
    void complete.run();
  };

  return (
    <AuthLayout
      wide
      heading="Tell us about your business"
      sub="This sets your workspace defaults. You can override the currency on any individual project."
      steps={[
        { label: 'Account', state: 'done' },
        { label: 'Company', state: 'active' },
      ]}
      asideTitle="One workspace, many pricing projects."
      asideBody="A company can run a hotel chain, a store and a fleet from the same account — each as its own project, with its own schema and its own API key. Nothing is ever mixed."
      asidePoints={[
        'Projects are fully isolated from each other',
        'Each project gets its own pricing API key',
        'Analytics, alerts and decisions never cross projects',
        'Industry templates are a starting point, not a limit',
      ]}
    >
      {!options && fallback.loading ? (
        <div className={s.fields}>
          <Loading label="Loading options" />
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <div className={s.fields}>
            <Input
              label="Company name"
              autoFocus
              required
              value={companyName}
              placeholder="ABC Hotels"
              hint="This is your organisation's name — not a username."
              onChange={(e) => setCompanyName(e.target.value)}
            />

            <Select
              label="Industry"
              required
              placeholder="Choose your industry"
              value={serviceType}
              options={(options?.service_types ?? []).map((t) => ({
                value: t.id,
                label: t.label,
              }))}
              hint="Used to suggest a starting schema. It does not restrict what you can price."
              onChange={(e) => setServiceType(e.target.value)}
            />

            <FieldRow>
              <Select
                label="Country"
                value={country}
                options={COUNTRIES}
                onChange={(e) => setCountry(e.target.value)}
              />
              <Select
                label="Default currency"
                value={currency}
                options={(options?.currencies ?? []).map((c) => ({
                  value: c.id,
                  label: `${c.symbol} ${c.id} — ${c.label}`,
                }))}
                onChange={(e) => setCurrency(e.target.value)}
              />
            </FieldRow>

            <Select
              label="Company size"
              optional
              placeholder="Prefer not to say"
              value={size}
              options={SIZES}
              onChange={(e) => setSize(e.target.value)}
            />

            {complete.error && (
              <ErrorState error={complete.error} title="Could not save your company details" />
            )}
          </div>

          <div className={s.submit}>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              loading={complete.pending}
              disabled={!companyName.trim() || !serviceType}
              iconAfter="arrow-right"
            >
              Create my workspace
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
