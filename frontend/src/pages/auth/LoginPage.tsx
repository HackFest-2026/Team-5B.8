import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { AuthLayout } from './AuthLayout';
import s from './Auth.module.css';

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation(
    async () => {
      const result = await authApi.login(email.trim(), password);
      const me = await signIn(result.token);
      return { result, me };
    },
    {
      onSuccess: ({ result }) => {
        // The server tells us where this account belongs: an account that
        // never finished step 2 has no tenant and every other endpoint would
        // answer 403, so it goes to onboarding rather than the dashboard.
        if (!result.registration_complete) {
          navigate('/onboarding', { replace: true });
          return;
        }
        const from = (location.state as LocationState | null)?.from;
        navigate(from && from.startsWith('/app') ? from : '/app', { replace: true });
      },
    },
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void login.run();
  };

  return (
    <AuthLayout
      heading="Sign in"
      sub="Continue to your pricing workspace."
      alt={
        <>
          New to DevNexus?{' '}
          <Link to="/signup" className={s.altLink}>
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <div className={s.fields}>
          <Input
            label="Work email"
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            placeholder="you@company.com"
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {/*
            The server answers the same way for an unknown email and a wrong
            password, so the UI must not imply which it was — doing so would
            turn this form into an account-enumeration oracle.
          */}
          {login.error && <ErrorState error={login.error} title="Could not sign you in" />}
        </div>

        <div className={s.submit}>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={login.pending}
            disabled={!email.trim() || !password}
          >
            Sign in
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
