import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authApi } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/Feedback';
import { Input } from '@/components/ui/Field';
import { useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { AuthLayout } from './AuthLayout';
import s from './Auth.module.css';

/**
 * Step 1 of registration: the login identity only.
 *
 * Company details are step 2, on purpose — the account exists and is signed in
 * after this screen, which is why `/auth/signup` returns a session token. It is
 * a partial registration, and the backend enforces that by refusing every other
 * endpoint until `/auth/complete-profile` has run.
 */

/** Matches the server's minimum, so the user is told before the round trip. */
const MIN_PASSWORD = 8;

export function SignupPage() {
  const navigate = useNavigate();
  const { signIn } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  const passwordError =
    touched && password.length > 0 && password.length < MIN_PASSWORD
      ? `Use at least ${MIN_PASSWORD} characters.`
      : null;

  const signup = useMutation(
    async () => {
      const result = await authApi.signup(email.trim(), password);
      await signIn(result.token);
      return result;
    },
    {
      // Signup always lands on step 2: by definition the company is not set yet.
      onSuccess: () => navigate('/onboarding', { replace: true }),
    },
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (password.length < MIN_PASSWORD) return;
    void signup.run();
  };

  return (
    <AuthLayout
      heading="Create your account"
      sub="Two steps. This one takes a few seconds, and you can configure your first project straight after."
      steps={[
        { label: 'Account', state: 'active' },
        { label: 'Company', state: 'todo' },
      ]}
      alt={
        <>
          Already have an account?{' '}
          <Link to="/login" className={s.altLink}>
            Sign in
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
            autoComplete="new-password"
            required
            value={password}
            hint={`At least ${MIN_PASSWORD} characters.`}
            error={passwordError}
            onBlur={() => setTouched(true)}
            onChange={(e) => setPassword(e.target.value)}
          />

          {signup.error && <ErrorState error={signup.error} title="Could not create the account" />}
        </div>

        <div className={s.submit}>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            loading={signup.pending}
            disabled={!email.trim() || password.length < MIN_PASSWORD}
            iconAfter="arrow-right"
          >
            Continue
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
