import Link from 'next/link';

import { AuthCard } from '@/components/auth/auth-card';

/**
 * Invite-only notice.
 *
 * Open self-registration is disabled (`disableSignUp` in the auth config):
 * accounts are created only through an organisation invitation, which binds
 * creation to a specific invited email. This route stays as a friendly
 * signpost rather than a form so old links explain themselves.
 */
export default function SignUpPage() {
  return (
    <AuthCard
      title="BlakPath is invite-only"
      subtitle="Accounts are created through an organisation invitation."
    >
      <p className="text-muted-foreground text-sm">
        If your council or organisation invited you, open the invitation link to create
        your account or join. Otherwise, contact the organisation you work with and ask
        them to invite you.
      </p>
      <p className="text-center text-sm">
        <Link
          href="/sign-in"
          className="text-primary font-medium underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
